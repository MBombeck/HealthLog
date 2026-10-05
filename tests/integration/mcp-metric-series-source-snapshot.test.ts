/**
 * The MCP single-metric reads build one source's section from that source's
 * rows (`source-snapshot.ts`) instead of a whole Coach snapshot. The promise
 * is that nothing a client receives changes, so this pins it against the full
 * builder on real rows: for every seeded source, across windows, the tool's
 * result serialises to exactly what `buildCoachSnapshot` scoped to that source
 * yields for the same section and grounding — the result `get_metric_series`
 * returned before. A dense series pushes the feature extraction's all-type row
 * cap into play, a year of blood pressure is large enough to go back to the
 * full builder, and an absent source stays an explicit absence.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { MCP_RESOURCE_TEMPLATES } from "@/lib/mcp/resources";
import type { McpAuthContext } from "@/lib/mcp/auth";
import {
  __resetCoachSnapshotCacheForTests,
  buildCoachSnapshot,
} from "@/lib/ai/coach/snapshot";
import { SOURCE_SNAPSHOT_FALLBACK_CHARS } from "@/lib/ai/coach/source-snapshot";
import { COACH_SOURCE_SNAPSHOT_KEY } from "@/lib/ai/coach/tools/source-keys";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { ensureUserMoodRollupsFresh } from "@/lib/rollups/mood-rollups";
import type { CoachScopeSource, CoachScopeWindow } from "@/lib/ai/coach/types";
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

let userId = "";

function ctx(): McpAuthContext {
  return {
    userId,
    tokenId: "token-int",
    scopes: ["health:read"],
    binding: `${userId}:token-int`,
    canRead: true,
    canWrite: false,
  };
}

function tool(name: string) {
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def;
}

/** What `get_metric_series` answered before: the full builder, sliced. */
async function oldPathResult(
  metric: CoachScopeSource,
  window: CoachScopeWindow | undefined,
) {
  __resetCoachSnapshotCacheForTests();
  const snapshot = await buildCoachSnapshot(userId, {
    sources: [metric],
    window,
  });
  const section = snapshot.sections[COACH_SOURCE_SNAPSHOT_KEY[metric]!];
  if (section === undefined) return { section, result: undefined };
  return {
    section,
    result: {
      present: true,
      data: { metric, section },
      grounding: snapshot.referenceGrounding ?? undefined,
    },
  };
}

async function newPathResult(
  metric: CoachScopeSource,
  window: CoachScopeWindow | undefined,
) {
  __resetCoachSnapshotCacheForTests();
  return tool("get_metric_series").run(
    ctx(),
    window ? { metric, window } : { metric },
  );
}

const PRESENT: CoachScopeSource[] = [
  "pulse",
  "resting_hr",
  "bp",
  "weight",
  "sleep",
  "steps",
  "hrv",
  "body_fat",
  "mood",
];
const WINDOWS: Array<CoachScopeWindow | undefined> = [
  undefined,
  "last7days",
  "last90days",
  "allTime",
];

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const user = await prisma.user.create({
    data: {
      username: "mcp-source-snapshot",
      email: "mcp-source-snapshot@example.test",
      timezone: "Europe/Berlin",
      dateOfBirth: new Date("1980-05-01T00:00:00Z"),
      heightCm: 180,
    },
  });
  userId = user.id;
  const now = Date.now();

  const rows: Array<{
    userId: string;
    type: MeasurementType;
    value: number;
    unit: string;
    source: "APPLE_HEALTH" | "WITHINGS";
    measuredAt: Date;
    sleepStage?: SleepStage;
    externalId?: string;
  }> = [];
  const add = (
    type: MeasurementType,
    unit: string,
    count: number,
    stepMs: number,
    value: (i: number) => number,
    source: "APPLE_HEALTH" | "WITHINGS" = "APPLE_HEALTH",
  ) => {
    for (let i = 0; i < count; i++) {
      rows.push({
        userId,
        type,
        value: value(i),
        unit,
        source,
        measuredAt: new Date(now - i * stepMs - 7 * 60_000),
      });
    }
  };
  // Hourly pulse for 400 days: more than the feature extraction's 6000-row
  // all-type cap on its own, so the cap decides which weight rows the core
  // aggregates see, in both builds.
  add("PULSE", "bpm", 400 * 24, HOUR_MS, (i) => 60 + ((i * 7) % 25));
  add("RESTING_HEART_RATE", "bpm", 400, DAY_MS, (i) => 52 + (i % 9));
  add("HEART_RATE_VARIABILITY", "ms", 400, DAY_MS, (i) => 40 + (i % 13));
  add(
    "BLOOD_PRESSURE_SYS",
    "mmHg",
    800,
    12 * HOUR_MS,
    (i) => 115 + ((i * 7) % 22),
    "WITHINGS",
  );
  add(
    "BLOOD_PRESSURE_DIA",
    "mmHg",
    800,
    12 * HOUR_MS,
    (i) => 74 + ((i * 5) % 13),
    "WITHINGS",
  );
  add("WEIGHT", "kg", 400, DAY_MS, (i) => 81 + (i % 6) * 0.3, "WITHINGS");
  add("BODY_FAT", "%", 120, 3 * DAY_MS, (i) => 20 + (i % 5) * 0.2, "WITHINGS");
  for (let d = 1; d <= 120; d++) {
    rows.push({
      userId,
      type: "ACTIVITY_STEPS",
      value: 6000 + ((d * 977) % 5000),
      unit: "steps",
      source: "APPLE_HEALTH",
      measuredAt: new Date(now - d * DAY_MS),
      externalId: `stats:HKQuantityTypeIdentifierStepCount:${d}`,
    });
    const stages: SleepStage[] = ["CORE", "DEEP", "CORE", "REM", "AWAKE"];
    stages.forEach((sleepStage, s) => {
      rows.push({
        userId,
        type: "SLEEP_DURATION",
        value: 45,
        unit: "minutes",
        source: "APPLE_HEALTH",
        measuredAt: new Date(now - d * DAY_MS - 6 * HOUR_MS + s * 50 * 60_000),
        sleepStage,
      });
    });
  }
  await prisma.measurement.createMany({ data: rows });

  const moods = Array.from({ length: 90 }, (_, d) => {
    const at = new Date(now - d * DAY_MS - 2 * HOUR_MS);
    return {
      userId,
      date: at.toISOString().slice(0, 10),
      mood: "GUT",
      score: 2 + (d % 4),
      moodLoggedAt: at,
    };
  });
  await prisma.moodEntry.createMany({ data: moods });

  await recomputeUserRollups(userId, {
    from: new Date(now - 420 * DAY_MS),
    to: new Date(now),
  });
  // The mood feature warms its rollup tier fire-and-forget on first read;
  // settle it now so both builds read the same tier.
  await ensureUserMoodRollupsFresh(userId);
  // No ANALYZE here, on purpose: a fresh import below the autoanalyze
  // threshold is what production runs too, and the all-time pulse aggregate
  // must not depend on planner statistics
  // (`day-weight-unanalysed-scale.test.ts`).
}, 120_000);

describe("get_metric_series built from one source's rows", () => {
  it.each(PRESENT.flatMap((m) => WINDOWS.map((w) => [m, w] as const)))(
    "%s over %s answers exactly what the full snapshot answered",
    async (metric, window) => {
      const before = await oldPathResult(metric, window);
      expect(before.result).toBeDefined();
      const after = await newPathResult(metric, window);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before.result));
    },
  );

  it("sends a section large enough for the budget pass to the full builder", async () => {
    // Without a case past the threshold the fallback branch is never run and
    // the equality above would say nothing about it.
    const sizes = await Promise.all(
      (["bp", "pulse", "weight"] as const).map(async (m) => {
        const { section } = await oldPathResult(m, "allTime");
        return JSON.stringify({ section }, null, 2).length;
      }),
    );
    expect(Math.max(...sizes)).toBeGreaterThan(SOURCE_SNAPSHOT_FALLBACK_CHARS);
  });

  it("keeps an absent source an explicit absence", async () => {
    for (const metric of ["vo2_max", "spo2", "walking_speed"] as const) {
      expect((await oldPathResult(metric, undefined)).result).toBeUndefined();
      const after = (await newPathResult(metric, undefined)) as {
        present: boolean;
        reason?: string;
      };
      expect(after.present).toBe(false);
      expect(after.reason).toBe("no_data");
    }
  });

  it("answers get_metrics and the metric resource with the same per-metric results", async () => {
    const metrics = ["resting_hr", "pulse", "bp", "weight", "vo2_max"] as const;
    __resetCoachSnapshotCacheForTests();
    const batch = (await tool("get_metrics").run(ctx(), {
      metrics: [...metrics],
    })) as {
      present: boolean;
      results: Array<{ metric: string; present: boolean; data?: unknown }>;
    };
    expect(batch.present).toBe(true);
    for (const entry of batch.results) {
      const metric = entry.metric as CoachScopeSource;
      const { result } = await oldPathResult(metric, undefined);
      if (!result) {
        expect(entry.present).toBe(false);
        continue;
      }
      expect(JSON.stringify(entry)).toBe(
        JSON.stringify({
          metric,
          present: true,
          data: result.data,
          ...(result.grounding ? { grounding: result.grounding } : {}),
        }),
      );
    }

    const resource = MCP_RESOURCE_TEMPLATES.find((r) => r.name === "metric")!;
    __resetCoachSnapshotCacheForTests();
    const viaResource = await resource.read(ctx(), { type: "resting_hr" });
    expect(JSON.stringify(viaResource)).toBe(
      JSON.stringify((await oldPathResult("resting_hr", undefined)).result),
    );
  });
});
