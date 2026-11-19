/**
 * The per-type reads must descend the live index once per type and stop at
 * the cap, whatever the planner statistics say.
 *
 * `readNewestRowsPerType`, `readLiveMeasurementSpan`,
 * `readLatestReadingsPerType` and the dashboard's latest-reading probes
 * (`readLatestEver`, `readLatestCanonical`, both its latest-instant probe and
 * its read of that day) exist so the rows a dense stream makes the database
 * touch track the rows returned, not the length of the stream. That
 * only holds while the planner picks the per-type descent, and its pick
 * follows its row estimates. The estimates go wrong in exactly the states a
 * dense account passes through, so each state is built here on purpose and
 * the plans are held to the bound in every one of them:
 *
 *   - no statistics at all (a fresh install);
 *   - statistics gathered before the account's rows arrived, over other
 *     accounts with many types: the account is absent from them, so the
 *     planner expects it to hold almost nothing (a first sync on a running
 *     instance, until the next ANALYZE);
 *   - the same, but the other accounts held a single type, so the type
 *     condition looks as if it removes nothing;
 *   - analysed with the account among the others: its per-type estimate is
 *     one generic share of its rows, far below the cap of a dense type.
 *
 * Under the old statement the second and third state walked the
 * type-less `(user_id, measured_at)` index once per type through every row
 * of the account, and the fourth read every row of every type into a sort.
 * The full suite reached the second state by accident (another file's
 * statistics survive its TRUNCATE), which is how the bound came to fail there
 * and pass alone. Autovacuum is off for the file so no state drifts into
 * another mid-test, and every table stays under the ANALYZE sample size, so
 * the statistics are the whole table rather than a random sample of it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { prisma as appPrisma } from "@/lib/db";
import { readLatestEver } from "@/lib/dashboard/summary-reads";
import { readLatestReadingsPerType } from "@/lib/insights/recent-readings";
import { readLatestCanonical } from "@/lib/measurements/latest-canonical";
import {
  readLiveMeasurementSpan,
  readNewestRowsPerType,
} from "@/lib/measurements/newest-per-type";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import type { MeasurementType } from "@/generated/prisma/client";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const DAY_MS = 86_400_000;
const ACCOUNT = "dense-account";
/** Above the 6,000-row cap on its own. */
const PULSE_ROWS = 9_000;
const SPARSE_DAYS = 60;
const OTHER_ACCOUNTS = 20;
/** Rows per other account; with the dense account, below 30,000 in all. */
const OTHER_ROWS = 1_000;
const CAP = 6_000;
const TYPES: MeasurementType[] = [
  "PULSE",
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
];

type StatisticsState = "none" | "predate-many" | "predate-one" | "analysed";

const prisma = getPrismaClient();
/** The overview reads every type the API accepts. */
const MEASUREMENT_TYPES = measurementTypeEnum.options;

/** The dense account: heart rate every ten seconds, sparse history behind. */
async function seedAccount(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements
       (id, user_id, type, value, unit, source, measured_at, updated_at)
     SELECT 'p' || i, $1, 'PULSE'::measurement_type, 60 + (i % 25), 'bpm',
            'APPLE_HEALTH'::measurement_source,
            now() - interval '1 minute' - i * interval '10 seconds', now()
       FROM generate_series(0, ${PULSE_ROWS - 1}) i
     UNION ALL
     SELECT 'w' || d, $1, 'WEIGHT'::measurement_type, 81, 'kg',
            'WITHINGS'::measurement_source,
            now() - d * interval '1 day' - interval '2 hours', now()
       FROM generate_series(2, ${SPARSE_DAYS + 1}) d
     UNION ALL
     SELECT t || d || '-' || h, $1, t::measurement_type, 120, 'mmHg',
            'WITHINGS'::measurement_source,
            now() - d * interval '1 day' - h * interval '1 hour', now()
       FROM generate_series(2, ${SPARSE_DAYS + 1}) d,
            unnest(ARRAY[8, 20]) h,
            unnest(ARRAY['BLOOD_PRESSURE_SYS', 'BLOOD_PRESSURE_DIA']) t`,
    ACCOUNT,
  );
}

/**
 * Other accounts' rows: twenty types each, or WEIGHT alone. Twenty types
 * cycle through the enum so none of them is one the dense account holds
 * more of than the rest.
 */
async function seedOthers(oneType: boolean): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements
       (id, user_id, type, value, unit, source, measured_at, updated_at)
     SELECT 'o' || u || '-' || i, 'other-' || u,
            ${
              oneType
                ? `'WEIGHT'::measurement_type`
                : `(enum_range(NULL::measurement_type))[1 + (i % 20)]`
            },
            1, 'x', 'MANUAL', now() - i * interval '1 hour', now()
       FROM generate_series(1, ${OTHER_ACCOUNTS}) u,
            generate_series(0, ${OTHER_ROWS - 1}) i`,
  );
}

async function buildState(state: StatisticsState): Promise<void> {
  await prisma.$executeRawUnsafe("TRUNCATE measurements CASCADE");
  await prisma.$executeRawUnsafe(
    "DELETE FROM pg_statistic WHERE starelid = 'measurements'::regclass",
  );
  switch (state) {
    case "none":
      await seedAccount();
      return;
    case "predate-many":
    case "predate-one":
      await seedOthers(state === "predate-one");
      await prisma.$executeRawUnsafe("ANALYZE measurements");
      await seedAccount();
      return;
    case "analysed":
      await seedOthers(false);
      await seedAccount();
      await prisma.$executeRawUnsafe("ANALYZE measurements");
      return;
  }
}

/** What the statistics say, so a state cannot pass for one it is not. */
async function readStatistics(): Promise<{
  columns: number;
  accountKnown: boolean;
  typesKnown: number;
}> {
  const [row] = await prisma.$queryRawUnsafe<
    Array<{ columns: number; account_known: boolean; types_known: number }>
  >(
    `SELECT
       (SELECT COUNT(*) FROM pg_statistic
         WHERE starelid = 'measurements'::regclass)::int AS columns,
       COALESCE((SELECT $1 = ANY (most_common_vals::text::text[])
                   FROM pg_stats WHERE tablename = 'measurements'
                    AND attname = 'user_id'), false) AS account_known,
       COALESCE((SELECT array_length(most_common_vals::text::text[], 1)
                   FROM pg_stats WHERE tablename = 'measurements'
                    AND attname = 'type'), 0)::int AS types_known`,
    ACCOUNT,
  );
  return {
    columns: row.columns,
    accountKnown: row.account_known,
    typesKnown: row.types_known,
  };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$executeRawUnsafe(
    "ALTER TABLE measurements SET (autovacuum_enabled = false)",
  );
  await prisma.user.createMany({
    data: [
      { id: ACCOUNT, username: ACCOUNT },
      ...Array.from({ length: OTHER_ACCOUNTS }, (_, i) => ({
        id: `other-${i + 1}`,
        username: `other-${i + 1}`,
      })),
    ],
  });
}, 120_000);

afterAll(async () => {
  await prisma.$executeRawUnsafe(
    "ALTER TABLE measurements RESET (autovacuum_enabled)",
  );
});

describe.each<
  [
    StatisticsState,
    { columns: boolean; accountKnown: boolean; typesKnown: number | null },
  ]
>([
  ["none", { columns: false, accountKnown: false, typesKnown: 0 }],
  ["predate-many", { columns: true, accountKnown: false, typesKnown: 20 }],
  ["predate-one", { columns: true, accountKnown: false, typesKnown: 1 }],
  ["analysed", { columns: true, accountKnown: true, typesKnown: null }],
])("per-type reads with statistics: %s", (state, expected) => {
  beforeAll(async () => {
    await buildState(state);
  }, 120_000);

  it("runs against the statistics the state names", async () => {
    const stats = await readStatistics();
    expect(stats.columns > 0).toBe(expected.columns);
    expect(stats.accountKnown).toBe(expected.accountKnown);
    if (expected.typesKnown !== null) {
      expect(stats.typesKnown).toBe(expected.typesKnown);
    } else {
      expect(stats.typesKnown).toBeGreaterThan(TYPES.length);
    }
  });

  it.each([
    ["the whole history", null],
    ["a 400-day window", 400],
  ] as const)(
    "reads each type by its own descent, bounded by the cap: %s",
    async (_label, sinceDays) => {
      const since =
        sinceDays === null ? null : new Date(Date.now() - sinceDays * DAY_MS);
      const [result, plans] = await withPlans(() =>
        readNewestRowsPerType(ACCOUNT, TYPES, { perTypeCap: CAP, since }),
      );
      const counts = new Map<string, number>();
      for (const row of result.rows) {
        counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
      }
      expect(Object.fromEntries(counts)).toEqual({
        PULSE: CAP,
        WEIGHT: SPARSE_DAYS,
        BLOOD_PRESSURE_SYS: SPARSE_DAYS * 2,
        BLOOD_PRESSURE_DIA: SPARSE_DAYS * 2,
      });
      expect(result.cappedTypes).toEqual(["PULSE"]);
      expectBounded(plans, result.rows.length + TYPES.length);
    },
  );

  it("keeps the descent under a shared total", async () => {
    const [result, plans] = await withPlans(() =>
      readNewestRowsPerType(ACCOUNT, TYPES, {
        perTypeCap: CAP,
        totalCap: 2_000,
      }),
    );
    expect(result.rows).toHaveLength(2_000);
    // The descent reads at most the cap per type before the total cuts.
    expectBounded(plans, CAP + SPARSE_DAYS * 5 + TYPES.length);
  });

  it("takes the span from one probe at each end of each type", async () => {
    const [span, plans] = await withPlans(() =>
      readLiveMeasurementSpan(ACCOUNT, new Date(Date.now() - 400 * DAY_MS)),
    );
    expect(span.oldest).not.toBeNull();
    expect(span.newest).not.toBeNull();
    expect(
      (span.newest!.getTime() - span.oldest!.getTime()) / DAY_MS,
    ).toBeGreaterThan(SPARSE_DAYS);
    // One row at each end of each of the four seeded types.
    expectBounded(plans, 2 * TYPES.length);
  });

  it("bounds the overview's latest readings of every type", async () => {
    const perType = 365;
    const [rows, plans] = await withPlans(() =>
      readLatestReadingsPerType(ACCOUNT, [...MEASUREMENT_TYPES], perType),
    );
    expect(rows).toHaveLength(perType + SPARSE_DAYS * 5);
    expectBounded(plans, rows.length + MEASUREMENT_TYPES.length);
  });

  it("finds the dashboard's latest reading of every type by one probe each", async () => {
    const [rows, plans] = await withPlans(() =>
      readLatestEver(appPrisma, ACCOUNT, [...MEASUREMENT_TYPES]),
    );
    expect(rows.map((r) => r.type).sort()).toEqual([...TYPES].sort());
    expectBounded(plans, TYPES.length);
  });

  it("finds the dashboard's canonical latest instant by one probe per type", async () => {
    const [rows, plans] = await withPlans(() =>
      readLatestCanonical(ACCOUNT, null),
    );
    expect(rows.map((r) => r.type).sort()).toEqual([...TYPES].sort());
    expectBounded(plans, TYPES.length, "d");
  });

  it("reads only the latest day's rows of each type for the canonical reading", async () => {
    // The day is ranked by source, so all of its rows are read; no more.
    const [{ rows: latestDayRows }] = await prisma.$queryRawUnsafe<
      Array<{ rows: number }>
    >(
      `SELECT COUNT(*)::int AS rows
         FROM measurements m
        WHERE m.user_id = $1 AND m.deleted_at IS NULL
          AND date_trunc('day', m.measured_at) = (
            SELECT max(date_trunc('day', l.measured_at)) FROM measurements l
             WHERE l.user_id = m.user_id AND l.type = m.type
               AND l.deleted_at IS NULL)`,
      ACCOUNT,
    );
    const [rows, plans] = await withPlans(() =>
      readLatestCanonical(ACCOUNT, null),
    );
    expect(rows).toHaveLength(TYPES.length);
    expectBounded(plans, latestDayRows, "m");
  });
});

/**
 * One statement, no sequential scan, and every row its measurement scans
 * (those aliased `alias`, when given) produced or threw away within `bound`.
 * A plan with no such scan fails rather than passing on zero.
 */
function expectBounded(plans: unknown[], bound: number, alias?: string): void {
  expect(plans).toHaveLength(1);
  const text = JSON.stringify(plans[0]);
  expect(text).not.toContain("Seq Scan");
  const { scans, visits } = scanRowVisits(plans[0], alias);
  expect(scans).toBeGreaterThan(0);
  expect(
    visits,
    `${visits} row visits against a bound of ${bound}:\n${JSON.stringify(plans[0], null, 1)}`,
  ).toBeLessThanOrEqual(bound);
}

/**
 * Run `read`, then run every `$queryRaw` and `$queryRawUnsafe` it issued
 * again under `EXPLAIN ANALYZE` and hand back the plans beside the reader's
 * own result.
 */
async function withPlans<T>(read: () => Promise<T>): Promise<[T, unknown[]]> {
  const head = "EXPLAIN (ANALYZE, FORMAT JSON) ";
  const tagged = appPrisma.$queryRaw.bind(appPrisma) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const unsafe = appPrisma.$queryRawUnsafe.bind(appPrisma) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const explains: Array<() => Promise<Array<{ "QUERY PLAN": unknown }>>> = [];
  vi.spyOn(appPrisma, "$queryRaw").mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const explain = Object.assign([head + strings[0], ...strings.slice(1)], {
      raw: [head + strings.raw[0], ...strings.raw.slice(1)],
    });
    explains.push(
      () =>
        tagged(explain, ...values) as Promise<Array<{ "QUERY PLAN": unknown }>>,
    );
    return tagged(strings, ...values);
  }) as never);
  vi.spyOn(appPrisma, "$queryRawUnsafe").mockImplementation(((
    sql: string,
    ...values: unknown[]
  ) => {
    explains.push(
      () =>
        unsafe(head + sql, ...values) as Promise<
          Array<{ "QUERY PLAN": unknown }>
        >,
    );
    return unsafe(sql, ...values);
  }) as never);
  let result: T;
  try {
    result = await read();
  } finally {
    vi.restoreAllMocks();
  }
  const plans: unknown[] = [];
  for (const explain of explains) {
    const [{ "QUERY PLAN": plan }] = await explain();
    plans.push(plan);
  }
  return [result, plans];
}

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  Alias?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
  Plan?: PlanNode;
}

/**
 * Rows the scans of `measurements` (only those aliased `alias`, when given)
 * produced or discarded, over all loops.
 */
function scanRowVisits(
  plan: unknown,
  alias?: string,
): { scans: number; visits: number } {
  let scans = 0;
  const walk = (node: PlanNode): number => {
    let own = 0;
    if (
      node["Relation Name"] === "measurements" &&
      (alias === undefined || node.Alias === alias)
    ) {
      scans += 1;
      const loops = node["Actual Loops"] ?? 1;
      const perLoop =
        (node["Actual Rows"] ?? 0) +
        (node["Rows Removed by Filter"] ?? 0) +
        (node["Rows Removed by Index Recheck"] ?? 0);
      // EXPLAIN prints these per-loop averages rounded to two decimals
      // (Postgres 18), so a scan run once per enum value over a handful of
      // rows multiplies the rounding by the loop count: four rows over 101
      // probes print as 0.04 a loop and read back as 4.04. The true total is
      // a whole number within half a hundredth a loop of the print; take the
      // smallest one consistent with it, never less than the print allows.
      own = Math.max(0, Math.ceil((perLoop - 0.005) * loops - 1e-9));
    }
    return own + (node.Plans ?? []).reduce((sum, p) => sum + walk(p), 0);
  };
  const root = (plan as PlanNode[])[0];
  const visits = walk(root.Plan ?? root);
  return { scans, visits };
}
