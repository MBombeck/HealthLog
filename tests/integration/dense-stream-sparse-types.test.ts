/**
 * A dense stream must not starve a sparse type out of a capped bulk read.
 *
 * The feature extraction and the Coach snapshot each read measurements
 * newest-first under a row cap. Read across every type at once, the cap
 * belongs to whichever type writes fastest: a watch sending heart rate every
 * few seconds fills 6,000 rows within hours, and every weight and blood
 * pressure reading older than those hours falls out of the read. The blocks
 * then report no weight at all on an account with years of it, while the
 * availability probe (uncapped aggregates) sees the rows and calls the miss
 * "unavailable in scope".
 *
 * The account below has heart rate every ten seconds, more rows than either
 * cap on their own and all of them newer than the sparse history, plus two
 * months of daily weight and twice-daily blood pressure. Every read that
 * builds a weight or blood pressure block must still see them: the
 * single-metric MCP read, the full feature extraction, and the full Coach
 * snapshot. The scoped and the full extraction must also agree block for
 * block, which is what the single-metric read promises.
 *
 * That the per-type read and the span probe touch only the rows they return,
 * whatever the planner statistics say, is held in
 * `newest-per-type-plans.test.ts`, which builds each statistics state on
 * purpose.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import type { McpAuthContext } from "@/lib/mcp/auth";
import {
  __resetCoachSnapshotCacheForTests,
  buildCoachSnapshot,
} from "@/lib/ai/coach/snapshot";
import { COACH_SOURCE_SNAPSHOT_KEY } from "@/lib/ai/coach/tools/source-keys";
import {
  extractFeatures,
  type AggregatedFeatures,
} from "@/lib/insights/features";
import type { MeasurementType } from "@/generated/prisma/client";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Above both 6,000-row caps on its own. */
const PULSE_ROWS = 9_000;
const PULSE_STEP_MS = 10_000;
const SPARSE_DAYS = 60;

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

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const user = await prisma.user.create({
    data: {
      username: "dense-stream-sparse",
      email: "dense-stream-sparse@example.test",
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
  }> = [];
  // Heart rate every ten seconds for the last 25 hours: every row is newer
  // than the newest sparse reading below.
  for (let i = 0; i < PULSE_ROWS; i++) {
    rows.push({
      userId,
      type: "PULSE",
      value: 60 + ((i * 7) % 25),
      unit: "bpm",
      source: "APPLE_HEALTH",
      measuredAt: new Date(now - 60_000 - i * PULSE_STEP_MS),
    });
  }
  for (let d = 2; d < 2 + SPARSE_DAYS; d++) {
    rows.push({
      userId,
      type: "WEIGHT",
      value: 81 + (d % 6) * 0.3,
      unit: "kg",
      source: "WITHINGS",
      measuredAt: new Date(now - d * DAY_MS - 2 * HOUR_MS),
    });
    for (const h of [8, 20]) {
      const at = new Date(now - d * DAY_MS - h * HOUR_MS);
      rows.push(
        {
          userId,
          type: "BLOOD_PRESSURE_SYS",
          value: 118 + ((d * 7 + h) % 15),
          unit: "mmHg",
          source: "WITHINGS",
          measuredAt: at,
        },
        {
          userId,
          type: "BLOOD_PRESSURE_DIA",
          value: 76 + ((d * 5 + h) % 9),
          unit: "mmHg",
          source: "WITHINGS",
          measuredAt: at,
        },
      );
    }
  }
  await prisma.measurement.createMany({ data: rows });
  // No ANALYZE: a fresh import below the autoanalyze threshold is what a
  // production account looks like right after its first sync.
}, 120_000);

describe("a dense stream beside sparse history", () => {
  it("answers get_metric_series for weight on every window", async () => {
    for (const window of [
      "last7days",
      "last30days",
      "last90days",
      "lastYear",
      "allTime",
    ] as const) {
      __resetCoachSnapshotCacheForTests();
      const result = (await tool("get_metric_series").run(ctx(), {
        metric: "weight",
        window,
      })) as { present: boolean; reason?: string };
      expect({ window, present: result.present }).toEqual({
        window,
        present: true,
      });
    }
  });

  it("builds the weight and blood pressure blocks in the full extraction", async () => {
    for (const options of [{ sinceDays: 400 }, { sinceDays: 90 }, {}]) {
      const full = (await extractFeatures(
        userId,
        false,
        options,
      )) as AggregatedFeatures;
      expect(full.weight?.coverage?.count).toBe(SPARSE_DAYS);
      expect(full.bloodPressure?.coverage?.count).toBeGreaterThan(0);
      expect(full.pulse).toBeDefined();
      // The span covers the sparse history, not the hours the dense stream
      // fills on its own.
      expect(full.context.dataSpanDays).toBeGreaterThanOrEqual(SPARSE_DAYS);
    }
  });

  it("builds each scoped block exactly as the full extraction does", async () => {
    const full = (await extractFeatures(userId, false, {
      sinceDays: 400,
    })) as AggregatedFeatures;
    for (const block of ["weight", "bloodPressure", "pulse"] as const) {
      const scoped = (await extractFeatures(userId, false, {
        sinceDays: 400,
        only: new Set([block]),
      })) as AggregatedFeatures;
      expect(scoped[block]).toBeDefined();
      expect(JSON.stringify(scoped[block])).toBe(JSON.stringify(full[block]));
    }
  });

  it("carries the weight and blood pressure timelines in the full Coach snapshot", async () => {
    __resetCoachSnapshotCacheForTests();
    const snapshot = await buildCoachSnapshot(userId, {
      sources: ["pulse", "weight", "bp"],
      window: "last90days",
    });
    const weight = snapshot.sections[COACH_SOURCE_SNAPSHOT_KEY.weight!] as
      { timeline?: { recent?: unknown[]; weekly?: unknown[] } } | undefined;
    const bp = snapshot.sections[COACH_SOURCE_SNAPSHOT_KEY.bp!] as
      { timeline?: { recent?: unknown[]; weeklySys?: unknown[] } } | undefined;
    expect(weight?.timeline?.recent?.length ?? 0).toBeGreaterThan(0);
    expect(weight?.timeline?.weekly?.length ?? 0).toBeGreaterThan(0);
    expect(bp?.timeline?.recent?.length ?? 0).toBeGreaterThan(0);
    expect(bp?.timeline?.weeklySys?.length ?? 0).toBeGreaterThan(0);

    // The single-metric read answers the section the full snapshot carries.
    __resetCoachSnapshotCacheForTests();
    const single = (await tool("get_metric_series").run(ctx(), {
      metric: "weight",
      window: "last90days",
    })) as { present: boolean; data?: { section?: unknown } };
    expect(JSON.stringify(single.data?.section)).toBe(JSON.stringify(weight));
  });
});
