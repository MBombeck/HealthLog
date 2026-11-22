/**
 * #1429 — the readers of a dense day answer for the whole day.
 *
 * A watch syncing through Google Health writes about 35 000 heart-rate rows a
 * day. The intraday pulse chart read the day with `take: 6000` and folded the
 * rows in JavaScript, so the chart ended a little after four in the morning;
 * the workout page's curve, the live step and energy profile, the strain
 * score's energy total, the stress score's HRV and the status cards' 30-day
 * window all had the same shape. Each now folds in Postgres
 * (`dense-bucket-read.ts`), and every case below runs against a real
 * database seeded with 30 days of 35 000 pulse rows a day: the answers
 * cover the whole window and equal what an uncapped fold of every row gives.
 *
 * The plan checks EXPLAIN the statements the readers send, on the same
 * 1.05 million rows: an index range on `(user_id, type, measured_at)`, never
 * a sequential scan of `measurements`. The statement budget pins how many
 * statements the chart route sends.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Prisma } from "@/generated/prisma/client";

import { cookieJar } from "./mock-next-headers";
import { countStatements, summariseStatements } from "./query-counter";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  computeTenMinuteMeanSeries,
  makeLocalResolver,
} from "@/lib/analytics/intraday-pulse";
import { runSafetyFloorCheck } from "@/lib/illness/safety-floor-check";
import { readRecentReadings } from "@/lib/insights/recent-readings";
import { readLatestDayMean } from "@/lib/insights/derived/coincident-deviation";
import { computeStrainScore } from "@/lib/insights/strain-score";
import { computeStressScore } from "@/lib/insights/stress-score";
import { readingsMean } from "@/lib/measurements/day-mean";
import {
  hourCellsSql,
  localDayMinuteBucketsSql,
} from "@/lib/measurements/dense-bucket-read";
import {
  readRestingPulseProxy,
  restingPulseProxyBlockKey,
} from "@/lib/analytics/resting-pulse-read";
import { caches } from "@/lib/cache/server-cache";
import { readCumulativeDayProfiles } from "@/lib/measurements/intraday-cumulative-profile";
import { buildWorkoutHrSeries, foldHrBuckets } from "@/lib/workouts/hr-series";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";
import { invalidateUserTimezone } from "@/lib/tz/resolver";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

// The safety-floor cases read the decision the check hands to its notifier.
const { notifySafetyFloor, notifyIllnessRedFlag } = vi.hoisted(() => ({
  notifySafetyFloor: vi.fn(async () => undefined),
  notifyIllnessRedFlag: vi.fn(async () => undefined),
}));
vi.mock("@/lib/illness/safety-floor-notify", () => ({ notifySafetyFloor }));
vi.mock("@/lib/illness/red-flag-notify", () => ({ notifyIllnessRedFlag }));
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  isModuleEnabled: vi.fn(async () => true),
}));

const prisma = getPrismaClient();
const TZ = "America/New_York";
const DENSE = "dense-day-owner";
const SPARSE = "sparse-day-owner";
const ROWS_PER_DAY = 35_000;
const DAYS = 30;
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
/** The viewed day: three local days back, inside every retention window. */
const DAY = shiftDateKey(userDayKey(NOW, TZ), -3);
/** Yesterday: inside the two days the cumulative profile folds live. */
const YESTERDAY = shiftDateKey(userDayKey(NOW, TZ), -1);
/** Statements the chart route sends on a miss (session, zone, five reads). */
const INTRADAY_BUDGET = 12;
/** Statements the daily digest sends on a dense account after a sync (measured 89 to 91). */
const DIGEST_AFTER_SYNC_BUDGET = 95;

async function session(userId: string): Promise<void> {
  const s = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
}

/** `count` rows of `type` spread evenly over `[from, to)`. */
async function seedSpread(opts: {
  userId: string;
  type: string;
  idPrefix: string;
  from: Date;
  to: Date;
  count: number;
  valueSql: string;
  unit: string;
  /** Prefix of a per-row external id; none when omitted. */
  externalIdPrefix?: string;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at, external_id,
       created_at, updated_at, sync_version)
     SELECT $1 || g, $2, $3::measurement_type, ${opts.valueSql}, $4,
       'GOOGLE_HEALTH'::measurement_source,
       ($5::timestamptz AT TIME ZONE 'UTC')
         + (g * ($6::double precision / $7::int)) * interval '1 millisecond',
       CASE WHEN $8::text IS NULL THEN NULL ELSE $8::text || g END,
       now(), now(), 1
     FROM generate_series(0, $7::int - 1) g`,
    opts.idPrefix,
    opts.userId,
    opts.type,
    opts.unit,
    opts.from.toISOString(),
    opts.to.getTime() - opts.from.getTime(),
    opts.count,
    opts.externalIdPrefix ?? null,
  );
}

/** Every raw PULSE row of `[from, to)`, uncapped: the reference fold's input. */
async function rawPulse(userId: string, from: Date, to: Date) {
  return prisma.measurement.findMany({
    where: {
      userId,
      type: "PULSE",
      deletedAt: null,
      measuredAt: { gte: from, lt: to },
    },
    select: { value: true, measuredAt: true },
  });
}

/** Timings for the record, outside the console capture. */
function report(line: string): void {
  process.stderr.write(`[dense-day-readers] ${line}\n`);
}

function planText(rows: Array<{ "QUERY PLAN": unknown }>): {
  text: string;
  ms: number;
} {
  const plan = rows[0]["QUERY PLAN"] as Array<{ "Execution Time": number }>;
  return { text: JSON.stringify(plan), ms: plan[0]["Execution Time"] };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const id of [DENSE, SPARSE]) {
    await prisma.user.create({ data: { id, username: id, timezone: TZ } });
    invalidateUserTimezone(id);
  }
  // Thirty local days ending on DAY, 35 000 pulse rows each, a slow wave
  // over the day so buckets differ.
  for (let d = 0; d < DAYS; d += 1) {
    const { dayStart, dayEnd } = localDayWindow(shiftDateKey(DAY, -d), TZ);
    await seedSpread({
      userId: DENSE,
      type: "PULSE",
      idPrefix: `p${d}-`,
      from: dayStart,
      to: dayEnd,
      count: ROWS_PER_DAY,
      valueSql: "55 + ((g * 37) % 61)",
      unit: "bpm",
    });
  }
  // Yesterday's active energy, a reading every eleven seconds.
  const y = localDayWindow(YESTERDAY, TZ);
  await seedSpread({
    userId: DENSE,
    type: "ACTIVE_ENERGY_BURNED",
    idPrefix: "e-",
    from: y.dayStart,
    to: y.dayEnd,
    count: 8_000,
    valueSql: "0.25 + (g % 4) * 0.125",
    unit: "kcal",
  });
  // The rollup tier a running instance holds, so the readers that sit on it
  // read it rather than folding the raw stream on a coverage miss.
  await recomputeUserRollups(DENSE);
  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
}, 600_000);

describe("GET /api/insights/pulse/intraday on a 35 000-row day", () => {
  async function intraday(date: string) {
    await session(DENSE);
    const { GET } = await import("@/app/api/insights/pulse/intraday/route");
    return GET(
      new NextRequest(
        `http://localhost/api/insights/pulse/intraday?date=${date}`,
      ),
    );
  }

  it("draws the whole day, every row counted, as the uncapped fold does", async () => {
    const res = await intraday(DAY);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        resolution: string;
        series: Array<{
          startMinute: number;
          mean: number;
          count: number;
          min?: number;
          max?: number;
        }>;
      };
    };
    expect(data.resolution).toBe("tenMin");
    expect(data.series).toHaveLength(144);
    // The reporter's chart stopped at 250. The last bucket is 23:50.
    expect(data.series.at(-1)!.startMinute).toBe(23 * 60 + 50);
    expect(data.series.reduce((n, b) => n + b.count, 0)).toBe(ROWS_PER_DAY);

    const { dayStart, dayEnd } = localDayWindow(DAY, TZ);
    const expected = computeTenMinuteMeanSeries(
      await rawPulse(DENSE, dayStart, dayEnd),
      DAY,
      makeLocalResolver(TZ),
    );
    expect(data.series).toEqual(expected);
  });

  it("stays within its statement budget", async () => {
    await intraday(DAY); // warm the process caches a running server holds
    const measured = await countStatements(async () => {
      const res = await intraday(DAY);
      await res.arrayBuffer();
      return res.status;
    });
    expect(measured.result).toBe(200);
    report(`intraday route: ${measured.count} statements`);
    expect(
      measured.count,
      `${measured.count} statements against ${INTRADAY_BUDGET}:\n` +
        summariseStatements(measured.statements),
    ).toBeLessThanOrEqual(INTRADAY_BUDGET);
  });

  it("reads the day as one index range, on 30 days of rows", async () => {
    const day = await prisma.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${localDayMinuteBucketsSql({
        userId: DENSE,
        type: "PULSE",
        dateKey: DAY,
        timeZone: TZ,
        bucketMinutes: 10,
      })}`,
    );
    const { text, ms } = planText(day);
    expect(text).not.toContain("Seq Scan");
    expect(text).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    // A generous ceiling for a shared CI container; the plan is the claim.
    expect(ms).toBeLessThan(5_000);
    report(`day buckets, 35 000 rows: ${ms.toFixed(0)} ms`);
  });
});

describe("the workout curve over a long session", () => {
  it("covers a six-hour ride end to end, as the uncapped fold does", async () => {
    const { dayStart } = localDayWindow(DAY, TZ);
    const startedAt = new Date(dayStart.getTime() + 8 * 3_600_000);
    const endedAt = new Date(startedAt.getTime() + 6 * 3_600_000);
    const durationSec = 6 * 3600;

    const series = await buildWorkoutHrSeries({
      userId: DENSE,
      startedAt,
      endedAt,
      durationSec,
      storedSamples: null,
      now: NOW,
    });
    expect(series).not.toBeNull();
    expect(series!.source).toBe("pulse_window");
    // About 8 750 readings in the session: past the 6 000 the read stopped at.
    const last = series!.points.at(-1)!;
    expect(last.tSec).toBe(durationSec - series!.bucketSec);

    const pad = 5 * 60_000;
    const raw = await rawPulse(
      DENSE,
      new Date(startedAt.getTime() - pad),
      new Date(endedAt.getTime() + pad + 1),
    );
    expect(raw.length).toBeGreaterThan(6_000);
    const expected = foldHrBuckets(
      raw.map((r) => ({ tMs: r.measuredAt.getTime(), hr: r.value })),
      startedAt.getTime(),
      durationSec,
      series!.bucketSec,
    );
    expect(series!.points).toEqual(expected.points);
  });
});

describe("the other dense-day readers", () => {
  it("folds yesterday's live energy profile over every reading", async () => {
    const [profile] = await readCumulativeDayProfiles({
      userId: DENSE,
      type: "ACTIVE_ENERGY_BURNED",
      timezone: TZ,
      endDateKey: YESTERDAY,
      windowDays: 1,
    });
    const { dayStart, dayEnd } = localDayWindow(YESTERDAY, TZ);
    const total = await prisma.measurement.aggregate({
      where: {
        userId: DENSE,
        type: "ACTIVE_ENERGY_BURNED",
        measuredAt: { gte: dayStart, lt: dayEnd },
      },
      _sum: { value: true },
    });
    expect(profile.origin).toBe("live");
    expect(profile.sampleCount).toBe(8_000);
    expect(profile.dayTotal).toBeCloseTo(total._sum.value!, 6);
    expect(profile.hourlyCumulative[23]).toBeCloseTo(total._sum.value!, 6);
  });

  it("totals the strain day's active energy over every reading", async () => {
    // The strain engine scores the UTC day before `now`.
    const { dayStart } = localDayWindow(YESTERDAY, TZ);
    const utcDay = dayStart.toISOString().slice(0, 10);
    const now = new Date(`${shiftDateKey(utcDay, 1)}T12:00:00.000Z`);
    const result = await computeStrainScore(
      prisma,
      DENSE,
      { ageYears: null, sex: null },
      null,
      now,
    );
    const total = await prisma.measurement.aggregate({
      where: {
        userId: DENSE,
        type: "ACTIVE_ENERGY_BURNED",
        measuredAt: {
          gte: new Date(`${utcDay}T00:00:00.000Z`),
          lt: new Date(`${shiftDateKey(utcDay, 1)}T00:00:00.000Z`),
        },
      },
      _sum: { value: true },
    });
    expect(total._sum.value).toBeGreaterThan(0);
    expect(result.dayActiveEnergy).toBeCloseTo(total._sum.value!, 6);
  });

  it("counts every intraday HRV reading of the stress day", async () => {
    const utcDay = "2026-01-15";
    await seedSpread({
      userId: SPARSE,
      type: "HEART_RATE_VARIABILITY",
      idPrefix: "hrv-",
      from: new Date(`${utcDay}T00:00:00.000Z`),
      to: new Date(`${shiftDateKey(utcDay, 1)}T00:00:00.000Z`),
      count: 2_500,
      valueSql: "30 + (g % 20)",
      unit: "ms",
      // The stress read counts raw samples by their external id, as a
      // watch's rows carry one.
      externalIdPrefix: "hk-hrv-",
    });
    const result = await computeStressScore(
      prisma,
      SPARSE,
      { ageYears: null, sex: null },
      new Date(`${shiftDateKey(utcDay, 1)}T12:00:00.000Z`),
    );
    // The read used to stop at 2 000.
    expect(result.intradaySamples).toBe(2_500);
  });

  it("gives the status cards 30 days of a dense stream, as hour cells", async () => {
    const readings = await readRecentReadings(DENSE, "PULSE", TZ, NOW);
    const since = NOW.getTime() - 30 * 86_400_000;
    expect(readings[0].measuredAt.getTime()).toBeGreaterThanOrEqual(since);
    expect(readings[0].measuredAt.getTime()).toBeLessThan(since + 3_600_000);
    // One reading per local hour of the window, not 60 000 rows of two days.
    expect(readings.length).toBeLessThanOrEqual(30 * 24 + 1);
    expect(readings.length).toBeGreaterThan(26 * 24);

    // A day of cells has the day value the day's rows have.
    const { dayStart, dayEnd } = localDayWindow(DAY, TZ);
    const dayCells = readings.filter(
      (r) => r.measuredAt >= dayStart && r.measuredAt < dayEnd,
    );
    expect(dayCells).toHaveLength(24);
    expect(readingsMean("PULSE", dayCells, TZ)).toBeCloseTo(
      readingsMean("PULSE", await rawPulse(DENSE, dayStart, dayEnd), TZ)!,
      9,
    );
  });

  it("means the whole latest day, and only its plausible readings", async () => {
    const user = "latest-day-owner";
    await prisma.user.create({ data: { id: user, username: user } });
    const at = (day: string, hour: number) =>
      new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
    const rows = [
      ...[66, 70, 68].map((v, i) => ({ v, at: at("2026-08-01", 8 + i) })),
      ...[72, 111287531.01, 74].map((v, i) => ({
        v,
        at: at("2026-08-02", 8 + i),
      })),
    ];
    await prisma.measurement.createMany({
      data: rows.map((r) => ({
        userId: user,
        type: "PULSE" as const,
        value: r.v,
        unit: "bpm",
        measuredAt: r.at,
      })),
    });
    const now = new Date("2026-08-03T00:00:00.000Z");
    const latest = await readLatestDayMean(user, "PULSE", 30, now, "UTC");
    expect(latest).not.toBeNull();
    expect(latest!.day).toBe("2026-08-02");
    expect(latest!.value).toBeCloseTo(73, 6);
    expect(latest!.lastAt).toEqual(at("2026-08-02", 10));

    // A day of impossible values only gives way to the day before it.
    await prisma.measurement.createMany({
      data: [36016.75, 111287531.01].map((v, i) => ({
        userId: user,
        type: "PULSE" as const,
        value: v,
        unit: "bpm",
        measuredAt: at("2026-08-03", 1 + i),
      })),
    });
    const later = await readLatestDayMean(
      user,
      "PULSE",
      30,
      new Date("2026-08-04T00:00:00.000Z"),
      "UTC",
    );
    expect(later!.day).toBe("2026-08-02");
  });

  it("reads 30 days of hour cells and the resting proxy by index", async () => {
    const since = new Date(NOW.getTime() - 30 * 86_400_000);
    const rows = await prisma.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${hourCellsSql({
        userId: DENSE,
        type: "PULSE",
        since,
        timeZone: TZ,
        bySource: false,
      })}`,
    );
    // This account is nine tenths of the table, so the planner rightly reads
    // the table in order rather than the index; on a shared instance it is
    // the index range the day read below shows. The claim here is the
    // latency of folding 30 days of a dense stream to hour cells.
    const { ms } = planText(rows);
    expect(ms).toBeLessThan(10_000);
    report(`hour cells, 30 days: ${ms.toFixed(0)} ms`);

    const started = performance.now();
    const proxy = await readRestingPulseProxy({
      userId: DENSE,
      since,
      timeZone: TZ,
    });
    report(
      `resting proxy, 30 days: ${(performance.now() - started).toFixed(0)} ms`,
    );
    expect(proxy.length).toBeGreaterThanOrEqual(26);
  });

  it("confirms a low glucose against the whole hour of a minute-rate sensor", async () => {
    const user = "cgm-owner";
    await prisma.user.create({ data: { id: user, username: user } });
    const candidateAt = new Date("2026-03-10T12:00:00.000Z");
    // A low 55 minutes back, then a reading a minute in range: the newest
    // 50 rows a capped read returned never reached the low.
    await prisma.measurement.createMany({
      data: [
        { at: -55, v: 60 },
        ...Array.from({ length: 54 }, (_, i) => ({ at: -54 + i, v: 110 })),
      ].map((r) => ({
        userId: user,
        type: "BLOOD_GLUCOSE" as const,
        value: r.v,
        unit: "mg/dL",
        measuredAt: new Date(candidateAt.getTime() + r.at * 60_000),
      })),
    });
    notifySafetyFloor.mockClear();
    await runSafetyFloorCheck({
      userId: user,
      written: [{ type: "BLOOD_GLUCOSE", value: 58, measuredAt: candidateAt }],
    });
    expect(notifySafetyFloor).toHaveBeenCalledOnce();
    const [{ decision }] = notifySafetyFloor.mock.calls[0] as unknown as [
      { decision: { reason: string } | null },
    ];
    expect(decision?.reason).toBe("glucose_hypo");
  });

  it("finds a three-night low SpO2 run on a sensor that samples every minute", async () => {
    const user = "spo2-owner";
    await prisma.user.create({ data: { id: user, username: user } });
    const nights = ["2026-03-01", "2026-03-02", "2026-03-03"];
    // Six hundred readings a night, the low one first: the newest 500 rows
    // of the lookback were the last night's alone.
    for (const night of nights) {
      const from = new Date(`${night}T00:00:00.000Z`);
      await seedSpread({
        userId: user,
        type: "OXYGEN_SATURATION",
        idPrefix: `o${night}-`,
        from,
        to: new Date(from.getTime() + 10 * 3_600_000),
        count: 600,
        valueSql: "CASE WHEN g = 0 THEN 88 ELSE 97 END",
        unit: "%",
      });
    }
    notifyIllnessRedFlag.mockClear();
    await runSafetyFloorCheck({
      userId: user,
      timezone: "UTC",
      written: [
        {
          type: "OXYGEN_SATURATION",
          value: 97,
          measuredAt: new Date("2026-03-03T10:00:00.000Z"),
        },
      ],
    });
    expect(notifyIllnessRedFlag).toHaveBeenCalledOnce();
  });
});

/**
 * The 30-day fold as it ran before the closed block: one statement over the
 * whole window. The reference the cached read must equal.
 */
async function referenceProxy(userId: string, since: Date) {
  const rows = await prisma.$queryRaw<Array<{ first_at: Date; p: number }>>(
    Prisma.sql`
    WITH src AS (
      SELECT
        to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day,
        m."measured_at" AS measured_at,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."type" = 'PULSE'::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${since}
    )
    SELECT
      MIN(measured_at) AS first_at,
      (percentile_cont(0.2::double precision) WITHIN GROUP (ORDER BY value))::double precision AS p
    FROM src
    GROUP BY day
    HAVING COUNT(*) >= 3
    ORDER BY first_at ASC
  `,
  );
  return rows.map((r) => ({
    measuredAt: r.first_at,
    value: Math.round(Number(r.p)),
  }));
}

/** The proxy fold's statements, by the start the counter keeps of them. */
const PROXY_STATEMENT =
  /^WITH src AS \( SELECT to_char\(\(m\."measured_at" AT TIME ZONE 'UTC'\) AT TIME ZONE \$\d+, 'YYYY-MM-DD'\) AS day, m\."measured_at" AS measured_at, m\."value" AS value/;

/** Three pulse readings at `at`, a minute apart, and the write tail's eviction. */
async function writePulse(at: Date, value: number, tag: string) {
  const rows = [0, 1, 2].map((i) => ({
    id: `${tag}-${i}`,
    userId: DENSE,
    type: "PULSE" as const,
    value,
    unit: "bpm",
    // Manual readings at odd milliseconds: no seeded row shares the key.
    source: "MANUAL" as const,
    measuredAt: new Date(at.getTime() + i * 60_000 + 777),
  }));
  await prisma.measurement.createMany({ data: rows });
  invalidateUserMeasurements(DENSE, { touchedFrom: rows[0].measuredAt });
}

describe("the 30-day resting-pulse proxy, folded once and shared", () => {
  const since = new Date(NOW.getTime() - 30 * 86_400_000);
  const read = () =>
    readRestingPulseProxy({ userId: DENSE, since, timeZone: TZ, now: NOW });
  /** Whether the closed proxy days of this window are cached. */
  const blockCached = () =>
    caches.analytics.get(
      restingPulseProxyBlockKey(
        DENSE,
        TZ,
        localDayWindow(userDayKey(since, TZ), TZ).dayEnd,
        localDayWindow(userDayKey(NOW, TZ), TZ).dayStart,
      ),
    ) !== null;

  it("equals the one-statement fold cold, warm, after a sync and after a backfill", async () => {
    invalidateUserMeasurements(DENSE, { evict: true });
    expect(blockCached()).toBe(false);
    const started = performance.now();
    const cold = await countStatements(read);
    const coldMs = performance.now() - started;
    expect(cold.result).toEqual(await referenceProxy(DENSE, since));
    expect(cold.result.length).toBeGreaterThanOrEqual(26);
    // A miss is the old single statement, and it keeps the closed days.
    expect(cold.count).toBe(1);
    expect(blockCached()).toBe(true);

    const warmStarted = performance.now();
    const warm = await countStatements(read);
    const warmMs = performance.now() - warmStarted;
    expect(warm.result).toEqual(cold.result);
    // Only the partial first day and today are folded again.
    expect(warm.count).toBe(1);
    report(
      `resting proxy, 30 days: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`,
    );

    // A sync of today's readings leaves the closed days in place.
    await writePulse(new Date(NOW.getTime() - 10 * 60_000), 41, "today");
    expect(blockCached()).toBe(true);
    const synced = await countStatements(read);
    expect(synced.count).toBe(1);
    expect(synced.result).toEqual(await referenceProxy(DENSE, since));
    expect(synced.result.at(-1)!.value).toBe(41);

    // A backfill that reaches into the closed days drops the block.
    const { dayStart } = localDayWindow(shiftDateKey(DAY, -5), TZ);
    await writePulse(new Date(dayStart.getTime() + 3 * 3_600_000), 20, "old");
    expect(blockCached()).toBe(false);
    const backfilled = await countStatements(read);
    expect(backfilled.result).toEqual(await referenceProxy(DENSE, since));
    expect(blockCached()).toBe(true);
  });

  it("keeps the daily digest after a sync off the 30-day fold", async () => {
    await session(DENSE);
    const { GET } = await import("@/app/api/daily/digest/route");
    const digest = async () => {
      const res = await (GET as unknown as (r: Request) => Promise<Response>)(
        new NextRequest("http://localhost/api/daily/digest"),
      );
      await res.arrayBuffer();
      return res.status;
    };
    await digest(); // fill the process-level caches a running server holds

    invalidateUserMeasurements(DENSE, { evict: true });
    expect(blockCached()).toBe(false);
    const coldStarted = performance.now();
    const cold = await countStatements(digest);
    const coldMs = performance.now() - coldStarted;
    expect(cold.result).toBe(200);

    // The sync at launch: today's readings land, the digest rebuilds. Once
    // as the write tail evicts (the closed proxy days stay), once with the
    // block dropped as well, which is what every rebuild paid before it.
    const sync = async (keepBlock: boolean, tag: string) => {
      const at = new Date(NOW.getTime() - (keepBlock ? 5 : 20) * 60_000);
      await writePulse(at, 44, tag);
      invalidateUserMeasurements(DENSE, {
        evict: true,
        ...(keepBlock ? { touchedFrom: at } : {}),
      });
      expect(blockCached()).toBe(keepBlock);
      const started = performance.now();
      const m = await countStatements(digest);
      expect(m.result).toBe(200);
      return { ...m, ms: performance.now() - started };
    };
    const after = await sync(true, "launch");
    const afterMs = after.ms;
    const unshared = await sync(false, "launch-unshared");
    const folds = (m: { statements: string[] }) =>
      m.statements.filter((t) => PROXY_STATEMENT.test(t)).length;
    report(
      `daily digest: cold ${coldMs.toFixed(0)} ms / ${cold.count} statements / ${folds(cold)} proxy folds, ` +
        `after a sync ${afterMs.toFixed(0)} ms / ${after.count} statements / ${folds(after)} proxy folds, ` +
        `after a sync without the block ${unshared.ms.toFixed(0)} ms / ${folds(unshared)} proxy folds`,
    );
    // One proxy fold either way: the whole window on a miss, the two live
    // days on a hit.
    expect(folds(cold)).toBe(1);
    expect(folds(after)).toBe(1);
    expect(folds(unshared)).toBe(1);
    expect(
      after.count,
      `${after.count} statements against ${DIGEST_AFTER_SYNC_BUDGET}:\n` +
        summariseStatements(after.statements),
    ).toBeLessThanOrEqual(DIGEST_AFTER_SYNC_BUDGET);
  });
});
