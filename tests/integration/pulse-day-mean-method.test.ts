/**
 * The pulse day-mean method against a real Postgres (#1107 follow-up).
 *
 * The worked example: one sparse hour (a single reading at 120 bpm) and 23
 * dense hours (six readings each at 60 bpm). Every hour weighing one gives
 * (120 + 23 x 60) / 24 = 62.5; an hour weighing min(1, n / 3) gives
 * (120 / 3 + 23 x 60) / (23 + 1 / 3) = 60.86.
 *
 *   1. Every SQL reader that folds a day from its hours follows the active
 *      method: the chart's live per-day read, the day view's per-day cells,
 *      the per-day aggregates, the doctor report's dense buckets, the window
 *      helpers, and the TypeScript helper beside them.
 *   2. The dry run writes its result and nothing else: every other table is
 *      the same, row for row, before and after, the rollup tier included.
 *   3. The rebuild after apply rewrites the PULSE DAY rollups with the stored
 *      method.
 *   4. A large account stays well under the production heap through the dry
 *      run and the rebuild, because both work a window at a time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { readLocalDailyCells } from "@/lib/day/daily-stats";
import { loadDenseMeasurementBuckets } from "@/lib/doctor-report/dense-buckets";
import {
  computePulseDayMeanDryRun,
  handlePulseDayMean,
  type PulseDayMeanPayload,
} from "@/lib/jobs/pulse-day-mean";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import { dayValue } from "@/lib/measurements/day-mean";
import {
  setActivePulseDayMeanMethod,
  type PulseDayMeanMethod,
} from "@/lib/measurements/day-statistic";
import { readLiveBuckets } from "@/lib/measurements/daily-series-read";
import { readCanonicalRollupBuckets } from "@/lib/rollups/measurement-read";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { invalidateUserTimezone } from "@/lib/tz/resolver";
import { pulseDayMeanStoredRunsSchema } from "@/lib/validations/pulse-day-mean";
import type { Job } from "pg-boss";

const prisma = getPrismaClient();
const DAY = 86_400_000;
const HOUR = 3_600_000;

const A = "pulse-method-a";
const B = "pulse-method-b";

/** Two weeks back, 00:00 UTC: the sparse-hour day; the next day is dense. */
const now = new Date();
const D1 = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate() - 14,
);
const D2 = D1 + DAY;

const V1 = 62.5;
const V2 = (120 / 3 + 23 * 60) / (23 + 1 / 3);

function row(
  userId: string,
  id: string,
  value: number,
  at: number,
): Prisma.MeasurementCreateManyInput {
  return {
    id,
    userId,
    type: "PULSE",
    unit: "bpm",
    source: "APPLE_HEALTH",
    value,
    measuredAt: new Date(at),
  };
}

function sparseHourDay(userId: string, day: number) {
  const rows = [row(userId, `${userId}-${day}-sparse`, 120, day + 30 * 60_000)];
  for (let h = 1; h < 24; h++) {
    for (let i = 0; i < 6; i++) {
      rows.push(
        row(
          userId,
          `${userId}-${day}-${h}-${i}`,
          60,
          day + h * HOUR + i * 600_000,
        ),
      );
    }
  }
  return rows;
}

function denseDay(userId: string, day: number) {
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  for (let h = 0; h < 24; h++) {
    for (let i = 0; i < 6; i++) {
      rows.push(
        row(
          userId,
          `${userId}-${day}-d${h}-${i}`,
          70,
          day + h * HOUR + i * 600_000,
        ),
      );
    }
  }
  return rows;
}

const job = (action: PulseDayMeanPayload["action"]) =>
  [
    { id: `job-${action}`, data: { action } },
  ] as unknown as Job<PulseDayMeanPayload>[];

beforeAll(async () => {
  await truncateAllTables(prisma);
  setActivePulseDayMeanMethod("hour_mean_v1");
  await prisma.appSettings.create({ data: { id: "singleton" } });
  // Created in order: A is account #1, B account #2.
  await prisma.user.create({
    data: {
      id: A,
      username: A,
      timezone: "UTC",
      createdAt: new Date(D1 - 30 * DAY),
    },
  });
  await prisma.user.create({
    data: {
      id: B,
      username: B,
      timezone: "UTC",
      createdAt: new Date(D1 - 20 * DAY),
    },
  });
  invalidateUserTimezone(A);
  invalidateUserTimezone(B);
  // B: one hour of one reading at 100, one hour of three at 60.
  // Every hour equal: 80. Weighted: (100 / 3 + 60) / (4 / 3) = 70.
  await prisma.measurement.createMany({
    data: [
      ...sparseHourDay(A, D1),
      ...denseDay(A, D2),
      row(B, "b-1", 100, D1 + 8 * HOUR),
      row(B, "b-2", 60, D1 + 9 * HOUR),
      row(B, "b-3", 60, D1 + 9 * HOUR + 600_000),
      row(B, "b-4", 60, D1 + 9 * HOUR + 1_200_000),
    ],
  });
  for (const id of [A, B]) {
    await recomputeUserRollups(id, {
      types: ["PULSE"],
      from: new Date(D1 - 7 * DAY),
      to: new Date(D2 + 7 * DAY),
    });
  }
}, 120_000);

afterAll(() => setActivePulseDayMeanMethod("hour_mean_v1"));

/** The sparse-hour day as each reader sees it, under `method`. */
async function readersOfD1(method: PulseDayMeanMethod) {
  setActivePulseDayMeanMethod(method);
  const live = await readLiveBuckets({
    userId: A,
    type: "PULSE",
    from: new Date(D1),
    to: new Date(D2 + DAY - 1),
    cap: 10,
    priorityJson: null,
    grain: "daily",
    timeZone: "UTC",
  });
  const cells = await readLocalDailyCells({
    userId: A,
    types: ["PULSE"],
    from: new Date(D1),
    to: new Date(D2 + DAY),
    tz: "UTC",
    priorityJson: null,
  });
  const aggregates = await readDayAggregates({
    userId: A,
    type: "PULSE",
    since: new Date(D1),
    timeZone: "UTC",
  });
  const dense = await loadDenseMeasurementBuckets({
    userId: A,
    start: new Date(D1),
    end: new Date(D1 + DAY - 1),
    reportTz: "UTC",
    denseTypes: ["PULSE"],
  });
  const rows = await prisma.measurement.findMany({
    where: { userId: A, measuredAt: { gte: new Date(D1), lt: new Date(D2) } },
    select: { value: true, measuredAt: true },
  });
  const dayKey = new Date(D1).toISOString().slice(0, 10);
  const agg = aggregates.find((r) => r.day === dayKey)!;
  return {
    live: live.find((r) => new Date(r.measuredAt).getTime() === D1)?.value,
    cells: cells.get("PULSE")?.get(dayKey)?.value,
    aggregates: agg.dayMean,
    dense: dense[0].hourWeightedSum! / dense[0].hourWeight!,
    helper: dayValue("PULSE", rows, "UTC"),
  };
}

describe("every reader follows the active method", () => {
  it("weighs every hour alike under hour_mean_v1", async () => {
    const seen = await readersOfD1("hour_mean_v1");
    for (const [reader, value] of Object.entries(seen)) {
      expect(value, reader).toBeCloseTo(V1, 6);
    }
  });

  it("weighs the lone reading's hour a third under weighted_hour_mean_v2", async () => {
    const seen = await readersOfD1("weighted_hour_mean_v2");
    for (const [reader, value] of Object.entries(seen)) {
      expect(value, reader).toBeCloseTo(V2, 6);
    }
    expect(Number(V2.toFixed(1))).toBe(60.9);
    setActivePulseDayMeanMethod("hour_mean_v1");
  });
});

/** Every table except the settings row, as one digest per table. */
async function snapshotTables(): Promise<Record<string, string>> {
  const tables = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('app_settings', '_prisma_migrations')
    ORDER BY table_name
  `;
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`table name ${name}`);
    const [r] = await prisma.$queryRawUnsafe<Array<{ n: number; d: string }>>(
      `SELECT count(*)::int AS n,
              coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS d
       FROM "${name}" t`,
    );
    out[name] = `${r.n}:${r.d}`;
  }
  return out;
}

/** The settings row without the dry-run column. */
async function settingsWithoutDryRun() {
  const [r] = await prisma.$queryRaw<Array<{ j: Record<string, unknown> }>>`
    SELECT to_jsonb(s) - 'pulse_day_mean_dry_run_json' - 'updated_at' AS j
    FROM app_settings s WHERE s.id = 'singleton'
  `;
  return r.j;
}

describe("the dry run", () => {
  it("writes its result and nothing else", async () => {
    const tablesBefore = await snapshotTables();
    const settingsBefore = await settingsWithoutDryRun();
    expect(tablesBefore.measurement_rollups).not.toMatch(/^0:/);

    const outcome = await handlePulseDayMean(job("dry_run"));
    expect(outcome.ok).toBe(true);

    expect(await snapshotTables()).toEqual(tablesBefore);
    expect(await settingsWithoutDryRun()).toEqual(settingsBefore);

    const stored = await prisma.appSettings.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    const run = pulseDayMeanStoredRunsSchema.parse(
      stored.pulseDayMeanDryRunJson,
    );
    expect(run.status).toBe("done");
    expect(run.finishedAt).not.toBeNull();
    expect(run.result).toEqual({
      accounts: 2,
      daysCompared: 3,
      daysChangedOver1Bpm: 2,
      maxChangeBpm: 10,
      distribution: [
        { bucket: "0-1", days: 1 },
        { bucket: "1-2", days: 1 },
        { bucket: "2-5", days: 0 },
        { bucket: "5+", days: 1 },
      ],
      perAccount: [
        { account: "#1", days: 2, changedOver1Bpm: 1 },
        { account: "#2", days: 1, changedOver1Bpm: 1 },
      ],
    });
    // No account id leaves the job.
    expect(JSON.stringify(stored.pulseDayMeanDryRunJson)).not.toContain(A);
    expect(stored.pulseDayMeanMethod).toBe("hour_mean_v1");
  });
});

describe("the rebuild after apply", () => {
  const dayMean = async (userId: string, day: number) =>
    (
      await readCanonicalRollupBuckets({
        userId,
        type: "PULSE",
        granularity: "DAY",
        from: new Date(day),
        to: new Date(day),
        toInclusive: true,
      })
    )[0]?.mean;

  it("rewrites the PULSE rollups under the stored method", async () => {
    expect(await dayMean(A, D1)).toBeCloseTo(V1, 6);
    expect(await dayMean(B, D1)).toBeCloseTo(80, 6);

    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: { pulseDayMeanMethod: "weighted_hour_mean_v2" },
    });
    const outcome = await handlePulseDayMean(job("rebuild"));
    expect(outcome.ok).toBe(true);
    // The rebuild is on the record beside the dry run, with what it did.
    const { readPulseDayMeanStatus } =
      await import("@/lib/jobs/pulse-day-mean");
    const status = await readPulseDayMeanStatus();
    expect(status.lastRebuild).toMatchObject({ status: "done" });
    expect(status.lastRebuild?.accounts).toBeGreaterThan(0);
    expect(status.lastDryRun?.status).toBe("done");

    expect(await dayMean(A, D1)).toBeCloseTo(V2, 6);
    expect(await dayMean(A, D2)).toBeCloseTo(70, 6);
    expect(await dayMean(B, D1)).toBeCloseTo(70, 6);

    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: { pulseDayMeanMethod: "hour_mean_v1" },
    });
  });
});

describe("a large account under the production heap", () => {
  const BIG = "pulse-method-big";
  const YEARS = 2;
  /** The production container's heap ceiling. */
  const PROD_HEAP_MB = 524;
  /**
   * The seed's transactions run past Prisma's 5 s default under a loaded
   * host: a month took at most 0.55 s on a quiet machine and 9.9 s at a load
   * average near 95, which expired the transaction. The bound is the
   * fixture's, not the code's under test.
   */
  const SEED_TRANSACTION = { maxWait: 30_000, timeout: 120_000 };

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: BIG, username: BIG, timezone: "UTC" },
    });
    // One reading a minute for two years, about a million rows, and every
    // seventh hour holding a single reading so the two methods disagree.
    //
    // Written a month at a time, each month in its own transaction with the
    // statement timeout lifted for that transaction only and a transaction
    // timeout sized for a loaded host (`SEED_TRANSACTION`): as one statement
    // the million-row insert outran the timeout on CI's shared Postgres, and
    // both timeouts guard the code under test, not this fixture.
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    const start = new Date(end.getTime() - YEARS * 365 * DAY);
    const CHUNK = 30 * DAY;
    for (let from = start.getTime(); from < end.getTime(); from += CHUNK) {
      const chunkFrom = new Date(from);
      const chunkTo = new Date(Math.min(from + CHUNK, end.getTime()));
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = 0`;
        await tx.$executeRaw`
          INSERT INTO measurements (id, user_id, type, unit, source, value, measured_at, created_at, updated_at)
          SELECT 'big-' || (extract(epoch FROM ts)::bigint / 60)::text, ${BIG}, 'PULSE', 'bpm', 'APPLE_HEALTH',
                 60 + ((extract(epoch FROM ts)::bigint / 60) % 40),
                 ts, now(), now()
          FROM generate_series(
                 ${chunkFrom}::timestamptz,
                 ${chunkTo}::timestamptz - interval '1 minute',
                 interval '1 minute'
               ) AS s(ts)
          WHERE extract(hour FROM ts)::int % 7 <> 3 OR extract(minute FROM ts)::int = 0
        `;
      }, SEED_TRANSACTION);
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = 0`;
      await tx.$executeRaw`ANALYZE measurements`;
    }, SEED_TRANSACTION);
  }, 600_000);

  async function peakHeapMb(work: () => Promise<unknown>) {
    const base = process.memoryUsage().heapUsed;
    let peak = base;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 25);
    try {
      await work();
    } finally {
      clearInterval(timer);
    }
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    return {
      grewMb: (peak - base) / 1_048_576,
      peakMb: peak / 1_048_576,
    };
  }

  it("stays flat through the dry run and the rebuild", async () => {
    const rows = await prisma.measurement.count({ where: { userId: BIG } });
    expect(rows).toBeGreaterThan(900_000);

    const dry = await peakHeapMb(() => computePulseDayMeanDryRun());
    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: { pulseDayMeanMethod: "weighted_hour_mean_v2" },
    });
    const rebuild = await peakHeapMb(() => handlePulseDayMean(job("rebuild")));
    process.stderr.write(
      `[pulse-day-mean heap] rows=${rows} dryRun grew=${dry.grewMb.toFixed(1)} MB peak=${dry.peakMb.toFixed(1)} MB; rebuild grew=${rebuild.grewMb.toFixed(1)} MB peak=${rebuild.peakMb.toFixed(1)} MB\n`,
    );
    // A window's aggregate rows, never the readings: a few MB at most. The
    // bound leaves room for the test runner's own churn and is still a small
    // slice of the production ceiling.
    expect(dry.grewMb).toBeLessThan(64);
    expect(rebuild.grewMb).toBeLessThan(64);
    expect(dry.grewMb).toBeLessThan(PROD_HEAP_MB / 8);

    const days = await readCanonicalRollupBuckets({
      userId: BIG,
      type: "PULSE",
      granularity: "DAY",
      from: new Date(Date.now() - 400 * DAY),
      to: new Date(),
      toInclusive: true,
    });
    expect(days.length).toBeGreaterThan(300);
  }, 900_000);
});
