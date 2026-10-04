/**
 * The shared pulse day weight (`dayWeightedRows`) must not depend on planner
 * statistics. A new account importing a year of pulse lands below the
 * autoanalyze threshold, so the first reads run against a table the planner
 * believes is empty. The earlier shape joined the CTE to an hour grouping of
 * itself; on such a table the planner chose a nested loop and the all-time
 * pulse aggregate ran into the 60 s production statement timeout.
 *
 * This file seeds a year of dense pulse (well over 100k rows) with autovacuum
 * off for the table and no ANALYZE, then:
 *
 *   - times the real all-time reader (`readAllTimeExtremes`) and a bare
 *     day-weighted mean, each well under the timeout;
 *   - after ANALYZE, compares the weights per day, per frame and per source
 *     against the earlier self-join SQL kept below as the oracle.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { readAllTimeExtremes } from "@/lib/insights/feature-blocks";
import {
  SESSION_DAY_FRAME,
  dayWeightedRows,
  zoneDayFrame,
  type DayFrame,
} from "@/lib/measurements/day-mean";

const prisma = getPrismaClient();
const USER = "day-weight-scale";
const DAY = 86_400_000;
const MINUTE = 60_000;
const DAYS = 365;
/** Generous against a 60 s production timeout, far above what one scan takes. */
const BOUND_MS = 15_000;

const start =
  Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  ) -
  DAYS * DAY;

/**
 * About 330 readings a day, unevenly spread so hours carry different counts,
 * plus a second source on every fifth day so the per-source weights differ.
 */
function seedRows(): Prisma.MeasurementCreateManyInput[] {
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  let i = 0;
  for (let d = 0; d < DAYS; d += 1) {
    for (let m = 0; m < 24 * 60; m += 4) {
      if ((m + d) % 13 === 0) continue;
      const hour = Math.floor(m / 60);
      // Night hours sparse, day hours dense.
      if (hour < 6 && m % 12 !== 0) continue;
      rows.push({
        id: `${USER}-a-${i}`,
        userId: USER,
        type: "PULSE",
        unit: "bpm",
        source: "APPLE_HEALTH",
        value: 55 + ((i * 7 + d) % 50),
        measuredAt: new Date(start + d * DAY + m * MINUTE + (i % 3) * 1000),
      });
      i += 1;
    }
    if (d % 5 === 0) {
      for (const h of [7, 7, 13, 22]) {
        rows.push({
          id: `${USER}-w-${i}`,
          userId: USER,
          type: "PULSE",
          unit: "bpm",
          source: "WITHINGS",
          value: 60 + (i % 20),
          measuredAt: new Date(
            start + d * DAY + h * 3_600_000 + (i % 50) * MINUTE,
          ),
        });
        i += 1;
      }
    }
  }
  return rows;
}

/** The earlier self-join, kept verbatim as the oracle for the weights. */
function oracleWeightedRows(
  source: string,
  frame: DayFrame,
  bySource: boolean,
): string {
  const ts = (column: string) =>
    frame.kind === "session"
      ? column
      : `((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${frame.tzSql})`;
  const hourOf = (alias: string) =>
    `date_trunc('hour', ${ts(`${alias}."measured_at"`)})`;
  const dayOf = (alias: string) =>
    `date_trunc('day', ${ts(`${alias}."measured_at"`)})`;
  const src = bySource ? `, t."source"` : "";
  const part = bySource ? `, x."source"` : "";
  const join = bySource ? ` AND hw."source" = s."source"` : "";
  return `(
      SELECT s.*,
        (CASE WHEN (s."type")::text IN ('PULSE')
              THEN 1.0 / (hw.n * hw.hours)
              ELSE 1.0 END)::double precision AS day_weight
      FROM ${source} s
      LEFT JOIN (
        SELECT x."type"${part}, x.local_hour, x.n,
               COUNT(*) OVER (PARTITION BY x."type"${part}, x.local_day) AS hours
        FROM (
          SELECT t."type"${src},
                 ${hourOf("t")} AS local_hour,
                 ${dayOf("t")} AS local_day,
                 COUNT(*) AS n
          FROM ${source} t
          WHERE (t."type")::text IN ('PULSE')
          GROUP BY ${bySource ? "1, 2, 3, 4" : "1, 2, 3"}
        ) x
      ) hw
        ON hw."type" = s."type"${join}
       AND hw.local_hour = ${hourOf("s")}
    )`;
}

const SRC_CTE = `WITH src AS (
  SELECT m."id", m."type", m."source", m."measured_at", m."value"
  FROM measurements m
  WHERE m."user_id" = $1 AND m."deleted_at" IS NULL AND m."type" = 'PULSE'
)`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const out = await fn();
  return [out, performance.now() - t0];
}

let rowCount = 0;

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$executeRawUnsafe(
    "ALTER TABLE measurements SET (autovacuum_enabled = false)",
  );
  await prisma.user.create({ data: { id: USER, username: USER } });
  const rows = seedRows();
  rowCount = rows.length;
  for (let k = 0; k < rows.length; k += 20_000) {
    await prisma.measurement.createMany({ data: rows.slice(k, k + 20_000) });
  }
}, 180_000);

afterAll(async () => {
  await prisma.$executeRawUnsafe(
    "ALTER TABLE measurements RESET (autovacuum_enabled)",
  );
});

describe("day weight on an unanalysed table", () => {
  it("seeds a year of dense pulse", () => {
    expect(rowCount).toBeGreaterThan(100_000);
  });

  it("answers the all-time pulse aggregate well under the timeout", async () => {
    const [out, ms] = await timed(() => readAllTimeExtremes(USER, ["PULSE"]));
    console.info(`[day-weight] readAllTimeExtremes ${ms.toFixed(0)} ms`);
    expect(out.get("PULSE")?.mean).toBeGreaterThan(55);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("answers a bare day-weighted mean well under the timeout", async () => {
    const [rows, ms] = await timed(() =>
      prisma.$queryRawUnsafe<Array<{ mean: number }>>(
        `${SRC_CTE}
         SELECT (SUM(w."value" * w.day_weight) / SUM(w.day_weight))::double precision AS mean
         FROM ${dayWeightedRows("src", zoneDayFrame("$2"), { bySource: true })} w`,
        USER,
        "Europe/Berlin",
      ),
    );
    console.info(`[day-weight] zone + bySource mean ${ms.toFixed(0)} ms`);
    expect(rows[0].mean).toBeGreaterThan(55);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("day weight against the earlier self-join", () => {
  beforeAll(async () => {
    // Statistics now, so the oracle plans the way it did in production.
    await prisma.$executeRawUnsafe("ANALYZE measurements");
  }, 120_000);

  const cases: Array<[string, DayFrame, boolean, unknown[]]> = [
    ["session frame", SESSION_DAY_FRAME, false, []],
    ["session frame by source", SESSION_DAY_FRAME, true, []],
    ["Berlin frame", zoneDayFrame("$2"), false, ["Europe/Berlin"]],
    ["Kolkata frame by source", zoneDayFrame("$2"), true, ["Asia/Kolkata"]],
  ];

  it.each(cases)(
    "%s gives every row the same weight",
    async (_label, frame, bySource, extra) => {
      const query = (sub: string) =>
        prisma.$queryRawUnsafe<Array<{ id: string; w: number }>>(
          `${SRC_CTE}
           SELECT w."id" AS id, w.day_weight AS w
           FROM ${sub} w
           ORDER BY w."id"`,
          USER,
          ...extra,
        );
      const fresh = await query(dayWeightedRows("src", frame, { bySource }));
      const oracle = await query(oracleWeightedRows("src", frame, bySource));
      expect(fresh.length).toBe(rowCount);
      expect(fresh.length).toBe(oracle.length);
      let mismatches = 0;
      for (let k = 0; k < fresh.length; k += 1) {
        if (
          fresh[k].id !== oracle[k].id ||
          Math.abs(fresh[k].w - oracle[k].w) > 1e-12
        ) {
          mismatches += 1;
        }
      }
      expect(mismatches).toBe(0);
    },
  );
});
