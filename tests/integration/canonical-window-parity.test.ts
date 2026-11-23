/**
 * The 90-day canonical window aggregate (`readCanonicalWindow`) against the
 * statement it replaced, kept verbatim below as the reference: one window
 * function ranking every raw reading per (type, UTC day), the hour and day
 * weights as two more windows over the canonical readings, and the means and
 * the median per type.
 *
 * The fixture carries what could tell the two apart: a dense pulse stream
 * (a reading a minute) with a second source on some days, including the
 * days the 7-, 30- and 60-day edges cut and the window's first day and today;
 * readings exactly on each edge; a type off every ladder from two sources
 * (the tie breaks on the source name); tombstones; a reading dated tomorrow;
 * and a user whose ladder reverses the pulse order. Each comparison runs at
 * several instants and under both pulse day-mean methods, cold (the closed
 * block built), warm (read from it), after a sync of today (it stays) and
 * after a backfill into a closed day (it is dropped and rebuilt).
 *
 * The means may differ in the last bits: the old statement summed in
 * whatever order its parallel sort left equal keys, the new one sums per
 * hour first. They are compared to 1e-9 relative and must round to the same
 * cents the slice serves; the median is exact.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closedWindowKey,
  readCanonicalWindow,
  windowCuts,
  type CanonicalWindowRow,
} from "@/lib/analytics/canonical-window";
import {
  boundInstantSql,
  windowMeanColumnsSql,
} from "@/lib/analytics/request-clock-sql";
import {
  buildSourceRankCase,
  canonicalMeasurementsCte,
} from "@/lib/analytics/source-rank-sql";
import { caches } from "@/lib/cache/server-cache";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import {
  SESSION_DAY_FRAME,
  dayWeightedRows,
} from "@/lib/measurements/day-mean";
import {
  activePulseDayMeanMethod,
  setActivePulseDayMeanMethod,
  type PulseDayMeanMethod,
} from "@/lib/measurements/day-statistic";

import { countStatements } from "./query-counter";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DEFAULT_USER = "window-default-ladder";
const LADDER_USER = "window-user-ladder";
const LADDER = { pulse: ["GOOGLE_HEALTH", "APPLE_HEALTH"] };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
const METHOD = activePulseDayMeanMethod();

/** The statement the slice ran before, as it stood. */
function referenceWindow(
  userId: string,
  now: Date,
  priorityJson: unknown,
): Promise<CanonicalWindowRow[]> {
  const rank = buildSourceRankCase(priorityJson, '"type"', '"source"');
  return prisma.$queryRawUnsafe<CanonicalWindowRow[]>(
    `
      WITH cm AS (${canonicalMeasurementsCte(rank, { from: boundInstantSql(2), interval: "90 days" })}
      )
      SELECT
        m."type"::text                                                AS type,
        ${windowMeanColumnsSql(boundInstantSql(2))},
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY m."value"
        )::double precision                                           AS median
      FROM ${dayWeightedRows("cm", SESSION_DAY_FRAME)} m
      GROUP BY m."type"
    `,
    userId,
    now,
  );
}

/** The comprehensive aggregate's anomaly count before, as it stood. */
async function referenceAnomalies(
  userId: string,
  now: Date,
  priorityJson: unknown,
): Promise<Map<string, number>> {
  const rank = buildSourceRankCase(priorityJson, '"type"', '"source"');
  const rows = await prisma.$queryRawUnsafe<
    Array<{ type: string; anomaly_count: bigint }>
  >(
    `
      WITH cm AS (${canonicalMeasurementsCte(rank, { from: boundInstantSql(2), interval: "90 days" })}
      ),
      window_stats AS (
        SELECT m."type", AVG(m."value") AS mean_value,
          STDDEV_POP(m."value") AS stddev_value
        FROM cm m
        GROUP BY m."type"
      )
      SELECT m."type"::text AS type,
        COUNT(*) FILTER (
          WHERE ws.stddev_value IS NOT NULL
            AND ws.stddev_value > 0
            AND ABS(
              (ROUND(((m."value" - ws.mean_value) / ws.stddev_value)::numeric, 2))
            ) > 2
        ) AS anomaly_count
      FROM cm m
      JOIN window_stats ws ON ws."type" = m."type"
      GROUP BY m."type", ws.stddev_value
    `,
    userId,
    now,
  );
  return new Map(rows.map((r) => [r.type, Number(r.anomaly_count)]));
}

function read(userId: string, now: Date) {
  const priorityJson = userId === LADDER_USER ? LADDER : null;
  return readCanonicalWindow(
    userId,
    now,
    priorityJson,
    buildSourceRankCase(priorityJson, '"type"', '"source"'),
  );
}

const round2 = (v: number | null) =>
  v === null ? null : Math.round(v * 100) / 100;

function expectSameWindow(
  actual: CanonicalWindowRow[],
  expected: CanonicalWindowRow[],
): void {
  const byType = (rows: CanonicalWindowRow[]) =>
    new Map(rows.map((r) => [r.type, r]));
  const a = byType(actual);
  const e = byType(expected);
  expect([...a.keys()].sort()).toEqual([...e.keys()].sort());
  for (const [type, ref] of e) {
    const row = a.get(type)!;
    expect(row.median, `${type} median`).toBe(ref.median);
    for (const field of ["avg7", "avg30", "avg30_last_month"] as const) {
      const want = ref[field];
      const got = row[field];
      if (want === null) {
        expect(got, `${type} ${field}`).toBeNull();
        continue;
      }
      expect(got, `${type} ${field}`).not.toBeNull();
      expect(
        Math.abs(got! - want) / Math.max(1, Math.abs(want)),
        `${type} ${field}: ${got} against ${want}`,
      ).toBeLessThan(1e-9);
      expect(round2(got), `${type} ${field} as served`).toBe(round2(want));
    }
  }
}

async function insert(
  userId: string,
  rows: Array<{
    type: string;
    source: string;
    at: number;
    value: number;
    deleted?: boolean;
  }>,
  tag: string,
): Promise<void> {
  await prisma.measurement.createMany({
    data: rows.map((r, i) => ({
      id: `${userId}-${tag}-${i}`,
      userId,
      type: r.type as never,
      source: r.source as never,
      value: r.value,
      unit: "u",
      measuredAt: new Date(r.at),
      deletedAt: r.deleted ? new Date(NOW.getTime() - DAY) : null,
    })),
    skipDuplicates: true,
  });
}

/** A reading a minute over `[from, to)`, as a dense watch stream writes. */
async function seedDense(
  userId: string,
  source: string,
  from: number,
  to: number,
  base: number,
  prefix: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source,
       measured_at, created_at, updated_at, sync_version)
     SELECT $1 || g, $2, 'PULSE', $3 + ((g * 37) % 41), 'bpm',
       $4::measurement_source,
       ($5::timestamptz AT TIME ZONE 'UTC') + g * interval '1 minute' + interval '17 seconds',
       now(), now(), 1
     FROM generate_series(0, $6::int - 1) g`,
    `${userId}-${prefix}-`,
    userId,
    base,
    source,
    new Date(from).toISOString(),
    Math.floor((to - from) / MIN),
  );
}

async function seed(userId: string): Promise<void> {
  await prisma.user.create({
    data: {
      id: userId,
      username: userId,
      sourcePriorityJson: userId === LADDER_USER ? LADDER : undefined,
    },
  });
  const now = NOW.getTime();
  const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
  // Ninety-two days of a reading a minute, through the end of today.
  await seedDense(
    userId,
    "GOOGLE_HEALTH",
    dayStart(now - 92 * DAY),
    dayStart(now) + DAY,
    55,
    "g",
  );
  // A second pulse source on the days every edge falls on, and on every
  // fifth day, a reading every ten minutes.
  const second = new Set<number>(
    [0, 7, 30, 60, 90].map((d) => dayStart(now - d * DAY)),
  );
  for (let d = 0; d < 92; d += 5) second.add(dayStart(now - d * DAY));
  for (const day of second) {
    const rows = [];
    for (let m = 0; m < 24 * 6; m += 1) {
      rows.push({
        type: "PULSE",
        source: "APPLE_HEALTH",
        at: day + m * 10 * MIN + 31_000,
        value: 62 + ((m * 7) % 23),
      });
    }
    await insert(userId, rows, `a${day}`);
  }
  const rows: Array<{
    type: string;
    source: string;
    at: number;
    value: number;
    deleted?: boolean;
  }> = [];
  for (let d = 0; d < 95; d += 1) {
    const at = dayStart(now - d * DAY) + 8 * HOUR + (d % 5) * 7 * MIN;
    rows.push({
      type: "RESTING_HEART_RATE",
      source: "GOOGLE_HEALTH",
      at,
      value: 52 + (d % 9) + 0.25,
    });
    if (d % 3 === 0) {
      rows.push({
        type: "RESTING_HEART_RATE",
        source: "OURA",
        at: at + HOUR,
        value: 50 + (d % 4) + 0.5,
      });
    }
    rows.push({
      type: "WEIGHT",
      source: "WITHINGS",
      at: at + 2 * HOUR,
      value: 80 + (d % 11) * 0.1,
    });
    // A type off every ladder from two sources: the tie breaks on the name.
    rows.push({
      type: "BLOOD_GLUCOSE",
      source: d % 2 === 0 ? "MANUAL" : "NIGHTSCOUT",
      at: at + 3 * HOUR,
      value: 90 + (d % 13),
    });
    if (d % 4 === 0) {
      rows.push({
        type: "BLOOD_GLUCOSE",
        source: "EXTERNAL",
        at: at + 3 * HOUR + 5 * MIN,
        value: 95 + (d % 7),
      });
    }
    // A tombstone that would otherwise win its day.
    if (d % 6 === 0) {
      rows.push({
        type: "RESTING_HEART_RATE",
        source: "WHOOP",
        at: at + 30 * MIN,
        value: 40,
        deleted: true,
      });
    }
  }
  // Outliers for the anomaly count: pulse spikes on a few days, a weight
  // far off its trend.
  for (const d of [2, 11, 33, 47, 71, 88]) {
    for (let m = 0; m < 20; m += 1) {
      rows.push({
        type: "PULSE",
        source: "GOOGLE_HEALTH",
        at: dayStart(now - d * DAY) + 15 * HOUR + m * MIN + 45_000,
        value: 150 + m,
      });
    }
    rows.push({
      type: "WEIGHT",
      source: "WITHINGS",
      at: dayStart(now - d * DAY) + 20 * HOUR,
      value: 95 + d / 10,
    });
  }
  // Readings exactly on each edge, and a reading dated tomorrow.
  for (const d of [7, 30, 60, 90]) {
    rows.push({
      type: "WEIGHT",
      source: "WITHINGS",
      at: now - d * DAY,
      value: 79.5 + d / 100,
    });
  }
  rows.push({
    type: "WEIGHT",
    source: "MANUAL",
    at: now + DAY,
    value: 81.25,
  });
  await insert(userId, rows, "v");
}

const INSTANTS: Array<[string, Date]> = [
  ["now", NOW],
  ["mid-hour, earlier today", new Date(NOW.getTime() - 5 * HOUR - 37 * MIN)],
  [
    "on an hour boundary",
    new Date(Math.floor(NOW.getTime() / HOUR) * HOUR - 2 * HOUR),
  ],
];

const METHODS: PulseDayMeanMethod[] = ["hour_mean_v1", "weighted_hour_mean_v2"];

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seed(DEFAULT_USER);
  await seed(LADDER_USER);
  await prisma.$executeRawUnsafe("ANALYZE measurements");
}, 300_000);

afterAll(() => {
  setActivePulseDayMeanMethod(METHOD);
});

describe("canonical window aggregate parity", () => {
  it("has a fixture worth comparing", async () => {
    const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM measurements`,
    );
    expect(n).toBeGreaterThan(250_000);
    const anomalies = await referenceAnomalies(DEFAULT_USER, NOW, null);
    expect(anomalies.get("PULSE")).toBeGreaterThan(0);
    expect(anomalies.get("WEIGHT")).toBeGreaterThan(0);
    // The pulse pick changes between the two ladders on the second source's days.
    const a = await referenceWindow(DEFAULT_USER, NOW, null);
    const b = await referenceWindow(LADDER_USER, NOW, LADDER);
    expect(a.find((r) => r.type === "PULSE")!.avg7).not.toBe(
      b.find((r) => r.type === "PULSE")!.avg7,
    );
  });

  for (const userId of [DEFAULT_USER, LADDER_USER]) {
    const priorityJson = userId === LADDER_USER ? LADDER : null;
    for (const method of METHODS) {
      it.each(INSTANTS)(
        `${userId}, ${method}: cold and warm equal the reference at %s`,
        async (_label, now) => {
          setActivePulseDayMeanMethod(method);
          const expected = await referenceWindow(userId, now, priorityJson);
          caches.analytics.__resetForTests();
          const cold = await countStatements(() => read(userId, now));
          expectSameWindow(cold.result, expected);
          const anomalies = await referenceAnomalies(userId, now, priorityJson);
          expect(
            new Map(cold.result.map((r) => [r.type, r.anomalies])),
          ).toEqual(anomalies);
          // The closed block and the edge.
          expect(cold.count).toBe(2);
          const warm = await countStatements(() => read(userId, now));
          expect(warm.result).toEqual(cold.result);
          // Only the edge.
          expect(warm.count).toBe(1);
        },
      );
    }
  }

  it("keeps the closed block through a sync of today and drops it on a backfill", async () => {
    setActivePulseDayMeanMethod(METHOD);
    const userId = DEFAULT_USER;
    const now = NOW;
    const cuts = windowCuts(now);
    const blockCached = () =>
      caches.analytics.get(closedWindowKey(userId, null, cuts)) !== null;
    caches.analytics.__resetForTests();
    await read(userId, now);
    expect(blockCached()).toBe(true);

    // Today's sync: a new source for today, and more of the dense stream.
    const today = cuts.blockTo.getTime();
    await insert(
      userId,
      [
        { type: "PULSE", source: "OURA", at: today + 90_000, value: 47 },
        { type: "PULSE", source: "WHOOP", at: today + 95_000, value: 45 },
        {
          type: "RESTING_HEART_RATE",
          source: "WHOOP",
          at: today + 100_000,
          value: 44,
        },
      ],
      "sync",
    );
    invalidateUserMeasurements(userId, {
      evict: true,
      touchedFrom: new Date(today + 90_000),
    });
    expect(blockCached()).toBe(true);
    const synced = await countStatements(() => read(userId, now));
    expect(synced.count).toBe(1);
    expectSameWindow(synced.result, await referenceWindow(userId, now, null));

    // A backfill into a closed day, the 30-day edge's: the block goes.
    const edgeDay = Math.floor((now.getTime() - 30 * DAY) / DAY) * DAY;
    await insert(
      userId,
      [
        { type: "PULSE", source: "WHOOP", at: edgeDay + HOUR, value: 99 },
        { type: "WEIGHT", source: "MANUAL", at: edgeDay + HOUR, value: 70 },
      ],
      "backfill",
    );
    invalidateUserMeasurements(userId, {
      evict: true,
      touchedFrom: new Date(edgeDay + HOUR),
    });
    expect(blockCached()).toBe(false);
    const backfilled = await countStatements(() => read(userId, now));
    expect(backfilled.count).toBe(2);
    expectSameWindow(
      backfilled.result,
      await referenceWindow(userId, now, null),
    );
  });
});
