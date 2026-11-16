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
 * The per-type read and the span probe are also run under `EXPLAIN ANALYZE`
 * on the unanalysed table: the rows their plans touch must track the rows
 * they return, not the size of the dense stream, so the cap still bounds the
 * I/O it exists for.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { prisma as appPrisma } from "@/lib/db";
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
import {
  readLiveMeasurementSpan,
  readNewestRowsPerType,
} from "@/lib/measurements/newest-per-type";
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

  it("reads each type by its own index descent, bounded by the cap", async () => {
    const cap = 6_000;
    const types: MeasurementType[] = [
      "PULSE",
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
    ];
    const [result, plans] = await withPlans(() =>
      readNewestRowsPerType(userId, types, { perTypeCap: cap }),
    );
    const counts = new Map<string, number>();
    for (const row of result.rows) {
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      PULSE: cap,
      WEIGHT: SPARSE_DAYS,
      BLOOD_PRESSURE_SYS: SPARSE_DAYS * 2,
      BLOOD_PRESSURE_DIA: SPARSE_DAYS * 2,
    });
    expect(result.cappedTypes).toEqual(["PULSE"]);
    // Ascending, the order every consumer folds in.
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i].measuredAt.getTime()).toBeGreaterThanOrEqual(
        result.rows[i - 1].measuredAt.getTime(),
      );
    }

    expect(plans).toHaveLength(1);
    expect(JSON.stringify(plans[0])).not.toContain("Seq Scan");
    // Every row the plan's measurement scans returned or threw away, over all
    // their loops: a plan that walked the dense stream would touch all 9,000
    // pulse rows, the descent stops at the cap.
    expect(scanRowVisits(plans[0])).toBeLessThanOrEqual(
      result.rows.length + types.length,
    );
  });

  it("takes the overall span from index probes, not from the rows", async () => {
    const [span, plans] = await withPlans(() =>
      readLiveMeasurementSpan(userId, new Date(Date.now() - 400 * DAY_MS)),
    );
    expect(span.oldest).not.toBeNull();
    expect(span.newest).not.toBeNull();
    expect(
      (span.newest!.getTime() - span.oldest!.getTime()) / DAY_MS,
    ).toBeGreaterThan(SPARSE_DAYS);
    expect(plans).toHaveLength(1);
    expect(JSON.stringify(plans[0])).not.toContain("Seq Scan");
    // One row at each end of each of the four seeded types.
    expect(scanRowVisits(plans[0])).toBeLessThanOrEqual(8);
  });
});

/**
 * Run `read`, then run every `$queryRaw` it issued again under `EXPLAIN
 * ANALYZE` and hand back the plans beside the reader's own result.
 */
async function withPlans<T>(read: () => Promise<T>): Promise<[T, unknown[]]> {
  const original = appPrisma.$queryRaw.bind(appPrisma) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const statements: Array<[TemplateStringsArray, unknown[]]> = [];
  vi.spyOn(appPrisma, "$queryRaw").mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    statements.push([strings, values]);
    return original(strings, ...values);
  }) as never);
  let result: T;
  try {
    result = await read();
  } finally {
    vi.restoreAllMocks();
  }
  const plans: unknown[] = [];
  for (const [strings, values] of statements) {
    const head = "EXPLAIN (ANALYZE, FORMAT JSON) ";
    const explain = Object.assign([head + strings[0], ...strings.slice(1)], {
      raw: [head + strings.raw[0], ...strings.raw.slice(1)],
    });
    const [{ "QUERY PLAN": plan }] = await appPrisma.$queryRaw<
      Array<{ "QUERY PLAN": unknown }>
    >(explain, ...values);
    plans.push(plan);
  }
  return [result, plans];
}

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
  Plan?: PlanNode;
}

/** Rows the scans of `measurements` produced or discarded, over all loops. */
function scanRowVisits(plan: unknown): number {
  const walk = (node: PlanNode): number => {
    const own =
      node["Relation Name"] === "measurements"
        ? ((node["Actual Rows"] ?? 0) +
            (node["Rows Removed by Filter"] ?? 0) +
            (node["Rows Removed by Index Recheck"] ?? 0)) *
          (node["Actual Loops"] ?? 1)
        : 0;
    return own + (node.Plans ?? []).reduce((sum, p) => sum + walk(p), 0);
  };
  const root = (plan as PlanNode[])[0];
  return walk(root.Plan ?? root);
}
