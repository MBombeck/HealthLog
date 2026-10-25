/**
 * The canonical-source pick (`canonicalMeasurementsCte`) must not depend on
 * planner statistics. A new install, or an account whose import is still
 * under the autoanalyze threshold, reads against a `measurements` table the
 * planner has no statistics for. The pick used to join its per-day choices
 * back to the rows; on such a table the planner estimated one row on each
 * side and ran the join as a nested loop, rescanning the whole pick for every
 * reading. `GET /api/analytics` on 6,000 blood-pressure rows took seconds,
 * and on a ten-year account the all-time read ran past the statement timeout.
 *
 * Latency on a testcontainer says little, and the statement count did not
 * move at all, so this file holds the work instead: every reader shape the
 * helper serves is run under `EXPLAIN ANALYZE` on a table with no statistics,
 * and the rows its plan nodes produce or discard, times their loops, must
 * stay within a small multiple of the rows seeded. A plan that revisits the
 * table per row lands thousands of times over that budget, whatever the
 * machine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";
import {
  boundInstantSql,
  instantLiteralSql,
} from "@/lib/analytics/request-clock-sql";
import {
  buildSourceRankCase,
  canonicalMeasurementsCte,
  type CanonicalWindow,
} from "@/lib/analytics/source-rank-sql";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const USER = "canonical-pick-unanalysed";
const DAY = 86_400_000;

/**
 * Rows produced or discarded, summed over the plan, per row seeded. The
 * window pick sits at 4 or under on every shape below; the nested loop this
 * guards against measured 200 on the 90-day read and over 3,000 on the
 * one-type read, and ran past a minute on the all-time read.
 */
const WORK_PER_ROW = 8;

/**
 * Long enough for any linear plan on this fixture many times over, short
 * enough that a quadratic one fails here instead of at the test timeout.
 */
const STATEMENT_TIMEOUT = "10s";

/**
 * Ten years of paired blood pressure from one source with a second source on
 * every third day, and a year of pulse from two sources a day: overlapping
 * sources, so the pick has days to decide.
 */
function seedRows(): Prisma.MeasurementCreateManyInput[] {
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  const now = Date.now();
  const push = (
    type: MeasurementType,
    source: MeasurementSource,
    value: number,
    at: number,
  ) =>
    rows.push({
      userId: USER,
      type,
      source,
      value,
      unit: type === "PULSE" ? "bpm" : "mmHg",
      measuredAt: new Date(at),
    });
  for (let d = 0; d < 3000; d += 1) {
    const at = now - (d + 0.25) * DAY;
    push("BLOOD_PRESSURE_SYS", "WITHINGS", 120 + (d % 30), at);
    push("BLOOD_PRESSURE_DIA", "WITHINGS", 75 + (d % 15), at);
    if (d % 3 === 0) {
      push("BLOOD_PRESSURE_SYS", "MANUAL", 130 + (d % 20), at + 600_000);
      push("BLOOD_PRESSURE_DIA", "MANUAL", 80 + (d % 10), at + 600_000);
    }
  }
  for (let d = 0; d < 365; d += 1) {
    for (const h of [7, 13, 21]) {
      const at = now - d * DAY - h * 3_600_000;
      push("PULSE", "WITHINGS", 60 + ((d + h) % 20), at);
      push("PULSE", "APPLE_HEALTH", 62 + ((d + h) % 18), at + 60_000);
    }
  }
  return rows;
}

interface PlanNode {
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Join Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

/**
 * Every row a node returned or threw away, over all its loops. EXPLAIN
 * reports both per loop, so a node rescanned once per outer row counts every
 * rescan.
 */
function rowVisits(node: PlanNode): number {
  const perLoop =
    (node["Actual Rows"] ?? 0) +
    (node["Rows Removed by Filter"] ?? 0) +
    (node["Rows Removed by Join Filter"] ?? 0) +
    (node["Rows Removed by Index Recheck"] ?? 0);
  const own = perLoop * (node["Actual Loops"] ?? 1);
  return own + (node.Plans ?? []).reduce((sum, p) => sum + rowVisits(p), 0);
}

const NOW = new Date();

const SHAPES: Array<
  [
    label: string,
    window: CanonicalWindow | undefined,
    type: MeasurementType | undefined,
    from: Date | undefined,
  ]
> = [
  // The summaries slice's all-time read.
  [
    "every type, 15 years",
    { from: boundInstantSql(2), interval: "15 years" },
    undefined,
    NOW,
  ],
  // The summaries slice's and the comprehensive aggregator's 90-day reads.
  [
    "every type, 90 days",
    { from: boundInstantSql(2), interval: "90 days" },
    undefined,
    NOW,
  ],
  // The BP-in-target fast path: from its 365-day start, no interval.
  [
    "every type, from an instant",
    { from: boundInstantSql(2) },
    undefined,
    new Date(NOW.getTime() - 365 * DAY),
  ],
  // A metric series: one type, from a literal instant one day wider.
  [
    "one type, ten years",
    {
      from: instantLiteralSql(new Date(NOW.getTime() - 3650 * DAY)),
      interval: "1 day",
    },
    "BLOOD_PRESSURE_SYS",
    undefined,
  ],
  ["every type, no window", undefined, undefined, undefined],
];

let seeded = 0;

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$executeRawUnsafe(
    "ALTER TABLE measurements SET (autovacuum_enabled = false)",
  );
  // Statistics another file in this worker gathered survive its TRUNCATE.
  await prisma.$executeRawUnsafe(
    "DELETE FROM pg_statistic WHERE starelid = 'measurements'::regclass",
  );
  await prisma.user.create({ data: { id: USER, username: USER } });
  const rows = seedRows();
  seeded = rows.length;
  await prisma.measurement.createMany({ data: rows });
}, 120_000);

afterAll(async () => {
  await prisma.$executeRawUnsafe(
    "ALTER TABLE measurements RESET (autovacuum_enabled)",
  );
});

describe("canonical-source pick on a table without statistics", () => {
  it("runs against a table the planner has no statistics for", async () => {
    expect(seeded).toBeGreaterThan(10_000);
    const [stats] = await prisma.$queryRawUnsafe<
      Array<{ columns: number; reltuples: number }>
    >(
      `SELECT (SELECT COUNT(*) FROM pg_statistic
                WHERE starelid = 'measurements'::regclass)::int AS columns,
              reltuples::float8 AS reltuples
         FROM pg_class WHERE oid = 'measurements'::regclass`,
    );
    expect(stats).toEqual({ columns: 0, reltuples: -1 });
  });

  it.each(SHAPES)(
    "reads the window a bounded number of times: %s",
    async (_label, window, onlyType, from) => {
      const rank = buildSourceRankCase(null, '"type"', '"source"');
      const sql = `WITH cm AS (${canonicalMeasurementsCte(rank, window, onlyType)}
        )
        SELECT COUNT(*)::int AS n, SUM(cm."value")::float8 AS total FROM cm`;
      const params: unknown[] = from ? [USER, from] : [USER];
      const [{ "QUERY PLAN": plan }] = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
        );
        return tx.$queryRawUnsafe<
          Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, ...params);
      });
      const visits = rowVisits(plan[0].Plan);
      expect(
        visits,
        `${visits} row visits for ${seeded} rows seeded:\n` +
          JSON.stringify(plan[0].Plan, null, 1),
      ).toBeLessThanOrEqual(WORK_PER_ROW * seeded);
      // The pick kept rows and dropped the second source's.
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        sql,
        ...params,
      );
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(seeded);
    },
  );
});
