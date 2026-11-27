/**
 * Statement budgets for the hot routes, against a real Postgres.
 *
 * Latency on a testcontainer says little; the number of statements a request
 * sends says a lot, and it is exact on a fixed fixture. A loop that reads per
 * row instead of per set (an N+1), a second read of something already loaded,
 * or a fan-out that grew with the data all show up here as a count over its
 * budget, on a change that every other test would let through.
 *
 * Each budget is the count measured on this fixture when it was written. A
 * route that needs fewer statements passes; lower the budget in the same
 * change so the gain is held. A route that needs more fails with every
 * statement it sent, grouped, so the new one is visible. Raising a budget is
 * a reviewed change with the reason beside the number.
 *
 * The clock is pinned to the next noon in Berlin. Several reads exist only
 * on one side of a local hour (the day projection's occupancy read before a
 * slot it can still project, the resting-pulse edge read after the morning
 * window), so on the live clock a budget measured by day failed when the
 * suite ran after midnight. Only `Date` is faked; timers stay real.
 *
 * Every read runs on a miss: the user's caches are evicted before the
 * measured call, after one warm-up call that fills the process-level caches
 * a running server already holds. The large-account numbers (latency and
 * statements on 1.26 million rows) come from `scripts/bench/run.ts`; see
 * docs/contributing/benchmarks.md.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
  SleepStage,
} from "@/generated/prisma/client";

import { localHmAsUtc } from "@/lib/tz/local-day";

import { cookieJar } from "./mock-next-headers";
import { countStatements, summariseStatements } from "./query-counter";
import { getPrismaClient, truncateAllTables } from "./setup";

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

const USER_ID = "user-query-budget";
const DAY_MS = 86_400_000;

/**
 * Statements per request on this fixture. Each is the measured count; see
 * the header for how to move one.
 */
const BUDGET = {
  // 13 → 14: the `push.relay` block reads the instance's relay registration
  // (`push_relay_registrations`, one point read by relay host), which says
  // whether the relay is offered and which sender keys the app pins.
  authMe: 14,
  // 28 → 36 (#176): each measured card reads its month-over-month comparison
  // (one rollup read per card, the sleep card its nights), the same read
  // `GET /api/analytics/range` makes, so the card's arrow and the metric
  // page's agree. Bounded by the card count, not the data.
  // 36 → 37, snapshot 99 → 101 (1.49.0): the medications tile takes each
  // medication's next dose from the dose resolver over the batched dose
  // ledger (the courses and schedule eras the ledger needs, its window and
  // anchor reads) instead of the feeder reads of its own due computation.
  // A fixed number, whatever the number of medications.
  // 37 → 38, snapshot 89 → 90: no new read. The day projection's occupancy
  // read (which of today's slots already hold a row) runs on every read of a
  // medication created before today's slot, which is every real one; the
  // fixture's medication was created at seed time, so by day it had no slot
  // left to project and the read went uncounted (see the clock note above).
  // 38 → 37: the user's source order is read once per GET request
  // (`loadUserSourcePriority`): every reader shares one pending read, where
  // before each read on its own and Prisma batched whichever landed in the
  // same tick, so the count followed the scheduling.
  dashboardSummary: 37,
  // 101 → 89 (1.49.0): the summaries slice reads the source ladder and the
  // zone once instead of four and two times, and the year-ago baseline of
  // every type in one statement instead of one per type.
  // 90 → 88 (1.49.0): the rollup coverage probe is answered once per GET
  // request (`coverage-inflight.ts`); the score narrative probed again after
  // the snapshot's own probe had settled.
  // 88 → 86: one read of the source order per GET request (see the summary).
  dashboardSnapshot: 86,
  // The digest composes the snapshot (its own cell, rebuilt here) and adds
  // its rail's reads; 143 before the slice change above.
  // 133 → 134, targets 21 → 22 (1.49.0): the 90-day window aggregate folds
  // the readings before it ranks the sources and keeps the whole days before
  // today as a closed block, so a cold read (every cache evicted, as here)
  // sends the block and the edge read where it sent one statement over every
  // raw reading; once the block is cached (a sync of today keeps it) it is
  // the edge read alone, one statement as before.
  // 134 → 131 (1.49.0): one coverage probe per GET request. Sharing only the
  // probe in flight left the count to scheduling: the snapshot, the digest
  // and their two score readers sent two to four probes on the same fixture,
  // and a run that sent four failed at 134. The readers of the user's source
  // order now meet in one batched read instead of two.
  // 131 → 132 (1.50.0): the rail names a source that has gone quiet, so it
  // reads the stall stamps (`loadQuietSources`). Both stamp tables, the
  // integration watches and the iPhones, come back in one statement; a
  // connection's health is read only when one is stamped, never on this
  // fixture.
  // 132 → 133 (1.50.0): a readiness left with too few fresh inputs reads
  // the stored day before today ("last N on D") instead of answering
  // nothing, one statement, on this fixture through the snapshot's ring.
  // 133 → 130: one read of the source order per GET request (see the
  // summary); the digest sent it in up to five statements and flickered
  // between 131 and 132.
  // 130 → 131: last night is read once per user and day (`readLastNight`),
  // shared with the morning, instead of peeking into the morning's cell.
  // 131 → 133: the start page's asks read the asks set aside today (one
  // indexed prefix read of the dismiss ledger) and whether a dose snooze
  // runs (a bare count; the full snooze read only when one does).
  dailyDigest: 133,
  // The morning read (1.50.0): the snapshot (its own cell, rebuilt here, 88
  // of them), the coincident engine, readiness and the sleep score in one day
  // cell, the floor ledger, the quiet-source stamps and the day's first
  // visit. A fixed number, whatever the data. Readiness and the sleep score
  // run side by side and each asks for the source order; whether the second
  // joins the first one's read in flight is timing (123 locally, 124 on the
  // CI runner), so the budget holds the higher count.
  // 124 → 126 (1.50.0): the floor window is read on every request, not
  // only after a confirmed floor (the cuff readings, and glucose as its two
  // extremes), so a single reading past a floor keeps the sentence from
  // calling the day in range.
  // 126 → 127 (1.50.0): readiness with too few fresh inputs reads its stored
  // day before today, one statement (126 locally, the runner's extra
  // source-order read on top).
  // 127 → 122: one read of the source order per GET request (see the
  // summary); readiness and the sleep score share it, so the in-flight
  // timing between them no longer moves the count.
  // 122 → 123: last night is read once per user and day (`readLastNight`),
  // shared with the digest, instead of taken from the snapshot's newest row.
  dailyMorning: 123,
  // The target cards; their seven-day means come from the slice when a
  // fresh one is cached, here (evicted) from the slice's window aggregate.
  // 22 → 23, health status 59 → 60 (1.49.0): both grade weight and BMI, and
  // during a pregnancy or its postpartum weeks they must not, so each reads
  // the state once (one point read of `cycle_profiles`). Once: every reader in
  // a GET request shares that read (`loadPregnancyFields`), which is what
  // keeps the summary and the snapshot, with several such readers, at their
  // old counts. The series reads it only for a weight chart.
  // The second-factor policy is decided on every request of an account
  // without TOTP. It reads the operator row and, for a covered account, its
  // factor presence, and holds both for a minute in the process (dropped on
  // any write of either), so a warm route pays nothing for it.
  insightsTargets: 23,
  // 6/5/5 → 5/4/4 (1.50.0): the source ladder comes with the record's
  // profile read instead of a read of its own.
  series30: 5,
  series365: 4,
  series3650: 4,
  // `?kinds=` (1.50.0): eight series in one request. The account lookups,
  // the dense-window count and the pregnancy state are read once for all
  // kinds; what grows with the kinds is the one read each kind needs.
  // Eight single requests send far more (asserted below against their sum).
  seriesKinds8: 14,
  dayView: 47,
  // 60 → 59: one coverage probe per GET request (see the digest).
  // 59 → 51: one read of the source order per GET request (see the summary).
  healthStatus: 51,
  correlations: 43,
  batchIngest500: 28,
  // The Apple Health card and the phone's sync read (1.49.0). The newest and
  // the oldest reading of each type are two index probes per type in ONE
  // statement, so `oldestSeenAt` costs no statement of its own. One more for
  // the account's quiet iPhones (`quietDevices`), an indexed read of its own
  // devices.
  integrationsHealthkit: 18,
  // The navigation's two counts (1.49.0): the session and the user, the
  // active medications with their schedules, schedule eras and courses, the
  // ledgers' anchor and window reads in one batch, and the due check-ups.
  // Fixed, whatever the number of medications.
  navCounts: 9,
  // The sleep page's night timeline (1.50.0, #1419): the session and the
  // user, the instance settings and module reads (cycle included), the
  // source order, the latest-night probe, the night's stage rows (two
  // reads), and the lines over it. The lines are one statement for every
  // metric, folded per bucket in Postgres, whatever the density of the
  // streams; the module check for HRV shares the sleep gate's read.
  sleepNight: 10,
} as const;

type Handler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** The first 12:00 in Berlin at or after `from`: the pinned "now" of every budget. */
function nextBerlinNoon(from: Date): Date {
  const noon = localHmAsUtc(from, "Europe/Berlin", 12, 0);
  return noon >= from
    ? noon
    : localHmAsUtc(new Date(from.getTime() + DAY_MS), "Europe/Berlin", 12, 0);
}

/** Midnight UTC `n` days before today. */
function daysAgo(n: number): Date {
  const d = new Date(Date.now() - n * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * A small account with the shape of a real one: dense and sparse types,
 * overlapping sources, cumulative `stats:` rows, sleep stages, glucose, a
 * medication with its intake history, workouts and mood.
 */
async function seed(): Promise<void> {
  const db = getPrismaClient();
  await db.user.create({
    data: {
      id: USER_ID,
      username: "query-budget",
      email: "query-budget@example.test",
      timezone: "Europe/Berlin",
      locale: "en",
      onboardingCompletedAt: new Date(),
    },
  });

  const rows: Prisma.MeasurementCreateManyInput[] = [];
  const push = (
    type: MeasurementType,
    unit: string,
    source: MeasurementSource,
    at: Date,
    value: number,
    sleepStage?: SleepStage,
  ) =>
    rows.push({
      userId: USER_ID,
      type,
      unit,
      source,
      measuredAt: at,
      value,
      externalId: `${source}-${type}-${at.getTime()}${sleepStage ?? ""}`,
      ...(sleepStage ? { sleepStage } : {}),
    });

  for (let d = 1; d <= 120; d++) {
    const day = daysAgo(d).getTime();
    for (let h = 0; h < 24; h += 2) {
      push(
        "PULSE",
        "bpm",
        "APPLE_HEALTH",
        new Date(day + h * 3_600_000),
        60 + ((d + h) % 20),
      );
    }
    push(
      "HEART_RATE_VARIABILITY",
      "ms",
      "APPLE_HEALTH",
      new Date(day + 3 * 3_600_000),
      40 + (d % 15),
    );
    push(
      "RESTING_HEART_RATE",
      "bpm",
      "APPLE_HEALTH",
      new Date(day + 6 * 3_600_000),
      55 + (d % 5),
    );
    push(
      "BLOOD_PRESSURE_SYS",
      "mmHg",
      "WITHINGS",
      new Date(day + 7 * 3_600_000),
      120 + (d % 12),
    );
    push(
      "BLOOD_PRESSURE_DIA",
      "mmHg",
      "WITHINGS",
      new Date(day + 7 * 3_600_000),
      78 + (d % 8),
    );
    push(
      "PULSE",
      "bpm",
      "WITHINGS",
      new Date(day + 7 * 3_600_000),
      66 + (d % 6),
    );
    push(
      "WEIGHT",
      "kg",
      "WITHINGS",
      new Date(day + 6 * 3_600_000),
      82 + (d % 10) / 10,
    );
    if (d % 7 === 0) {
      push("WEIGHT", "kg", "MANUAL", new Date(day + 19 * 3_600_000), 82.3);
    }
    push(
      "OXYGEN_SATURATION",
      "%",
      "APPLE_HEALTH",
      new Date(day + 4 * 3_600_000),
      96 + (d % 3),
    );
    for (let s = 0; s < 8; s++) {
      push(
        "SLEEP_DURATION",
        "minutes",
        "APPLE_HEALTH",
        new Date(day - 3_600_000 + s * 45 * 60_000),
        45,
        (
          [
            "CORE",
            "DEEP",
            "REM",
            "CORE",
            "AWAKE",
            "CORE",
            "REM",
            "CORE",
          ] as const
        )[s],
      );
    }
    const key = new Date(day).toISOString().slice(0, 10);
    rows.push({
      userId: USER_ID,
      type: "ACTIVITY_STEPS",
      unit: "steps",
      source: "APPLE_HEALTH",
      measuredAt: new Date(day + 11 * 3_600_000),
      value: 7000 + (d % 9) * 300,
      externalId: `stats:HKQuantityTypeIdentifierStepCount:${key}`,
    });
  }
  for (let i = 0; i < 7 * 96; i++) {
    push(
      "BLOOD_GLUCOSE",
      "mg/dL",
      "NIGHTSCOUT",
      new Date(daysAgo(7).getTime() + i * 15 * 60_000),
      95 + (i % 30),
    );
  }
  await db.measurement.createMany({ data: rows });

  await db.workout.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({
      userId: USER_ID,
      sportType: ["running", "walking", "cycling"][i % 3]!,
      startedAt: new Date(daysAgo(i * 3 + 1).getTime() + 17 * 3_600_000),
      endedAt: new Date(daysAgo(i * 3 + 1).getTime() + 18 * 3_600_000),
      durationSec: 3600,
      totalEnergyKcal: 400,
      source: "APPLE_HEALTH" as const,
      externalId: `workout-${i}`,
    })),
  });
  await db.moodEntry.createMany({
    data: Array.from({ length: 60 }, (_, i) => {
      const at = new Date(daysAgo(i + 1).getTime() + 18 * 3_600_000);
      return {
        userId: USER_ID,
        date: at.toISOString().slice(0, 10),
        mood: ["GUT", "OKAY", "SUPER_GUT"][i % 3]!,
        score: [4, 3, 5][i % 3]!,
        source: "MANUAL",
        moodLoggedAt: at,
        tz: "Europe/Berlin",
      };
    }),
  });
  const med = await db.medication.create({
    data: {
      userId: USER_ID,
      name: "Budget A",
      dose: "5 mg",
      // Created before its history, the way a running account has it. The
      // column default is the database's clock, not the pinned one: today's
      // 08:00 slot then predated the medication whenever the suite ran after
      // 08:00 Berlin time, and the day projection skipped its occupancy read.
      createdAt: daysAgo(90),
      schedules: { create: { windowStart: "08:00", windowEnd: "09:00" } },
    },
  });
  await db.medicationIntakeEvent.createMany({
    data: Array.from({ length: 60 }, (_, i) => {
      const at = new Date(daysAgo(i + 1).getTime() + 6 * 3_600_000);
      return {
        userId: USER_ID,
        medicationId: med.id,
        scheduledFor: at,
        takenAt: i % 10 === 0 ? null : new Date(at.getTime() + 300_000),
        skipped: i % 10 === 0,
      };
    }),
  });

  // Both rollup tiers are minted here, the way a running account has them.
  // Seeded rows without their rollups make the first read start a full
  // recompute in the background, and that is a warm-up cost, not the read's.
  const { recomputeUserRollups } =
    await import("@/lib/rollups/measurement-rollups");
  await recomputeUserRollups(USER_ID);
  const { recomputeUserMoodRollups } =
    await import("@/lib/rollups/mood-rollups");
  await recomputeUserMoodRollups(USER_ID);

  const session = await db.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function evictUserCaches(): Promise<void> {
  const { invalidateUserMeasurements } = await import("@/lib/cache/invalidate");
  invalidateUserMeasurements(USER_ID, { evict: true });
}

/**
 * Call a route once to fill the process-level caches, evict the user's, and
 * count the statements of a second call: the miss a reader meets after a
 * sync on a server that is already running.
 */
async function measureRead(
  handler: Handler,
  url: string,
  params: Record<string, string> = {},
) {
  const call = () =>
    handler(new NextRequest(url), { params: Promise.resolve(params) });
  const warm = await call();
  expect(warm.status, `${url} warm-up`).toBe(200);
  await evictUserCaches();
  const measured = await countStatements(async () => {
    const res = await call();
    await res.arrayBuffer();
    return res.status;
  });
  expect(measured.result, url).toBe(200);
  return measured;
}

function expectWithin(
  label: string,
  measured: { count: number; statements: string[] },
  budget: number,
) {
  expect(
    measured.count,
    `${label}: ${measured.count} statements against a budget of ${budget}.\n` +
      summariseStatements(measured.statements),
  ).toBeLessThanOrEqual(budget);
}

describe("statement budgets on the hot routes (real Postgres)", () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nextBerlinNoon(new Date()));
    await truncateAllTables(getPrismaClient());
    cookieJar.clear();
    await seed();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("GET /api/auth/me", async () => {
    const { GET } = await import("@/app/api/auth/me/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/auth/me",
    );
    expectWithin("/api/auth/me", m, BUDGET.authMe);
  });

  it("GET /api/dashboard/summary", async () => {
    const { GET } = await import("@/app/api/dashboard/summary/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/dashboard/summary",
    );
    expectWithin("/api/dashboard/summary", m, BUDGET.dashboardSummary);
  });

  it("GET /api/dashboard/snapshot", async () => {
    const { GET } = await import("@/app/api/dashboard/snapshot/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/dashboard/snapshot",
    );
    expectWithin("/api/dashboard/snapshot", m, BUDGET.dashboardSnapshot);
  });

  it("GET /api/daily/digest", async () => {
    const { GET } = await import("@/app/api/daily/digest/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/daily/digest",
    );
    expectWithin("/api/daily/digest", m, BUDGET.dailyDigest);
  });

  it("GET /api/daily/morning", async () => {
    const { GET } = await import("@/app/api/daily/morning/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/daily/morning",
    );
    expectWithin("/api/daily/morning", m, BUDGET.dailyMorning);
  });

  it("GET /api/insights/targets", async () => {
    const { GET } = await import("@/app/api/insights/targets/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/insights/targets",
    );
    expectWithin("/api/insights/targets", m, BUDGET.insightsTargets);
  });

  it.each([
    [30, BUDGET.series30],
    [365, BUDGET.series365],
    [3650, BUDGET.series3650],
  ])("GET /api/measurements/series, %i days", async (days, budget) => {
    const { GET } = await import("@/app/api/measurements/series/route");
    const m = await measureRead(
      GET as unknown as Handler,
      `http://localhost/api/measurements/series?kind=pulse&days=${days}`,
    );
    expectWithin(`/api/measurements/series ${days} d`, m, budget);
  });

  it("GET /api/measurements/series?kinds=, eight kinds", async () => {
    const { GET } = await import("@/app/api/measurements/series/route");
    const kinds = [
      "weight",
      "bloodPressure",
      "pulse",
      "restingHeartRate",
      "oxygenSaturation",
      "glucose",
      "sleep",
      "vo2Max",
    ];
    const batch = await measureRead(
      GET as unknown as Handler,
      `http://localhost/api/measurements/series?kinds=${kinds.join(",")}&days=30`,
    );
    expectWithin(
      "/api/measurements/series kinds=8",
      batch,
      BUDGET.seriesKinds8,
    );

    let singles = 0;
    for (const kind of kinds) {
      singles += (
        await measureRead(
          GET as unknown as Handler,
          `http://localhost/api/measurements/series?kind=${kind}&days=30`,
        )
      ).count;
    }
    // Sharing has to show: the batch costs less than its kinds one by one.
    expect(
      batch.count,
      `kinds=8 sent ${batch.count}, eight singles ${singles}`,
    ).toBeLessThan(singles);
  });

  it("GET /api/measurements/series?kinds= answers in the order asked, like the singles", async () => {
    const { GET } = await import("@/app/api/measurements/series/route");
    const call = (query: string) =>
      (GET as unknown as Handler)(
        new NextRequest(`http://localhost/api/measurements/series?${query}`),
        { params: Promise.resolve({}) },
      );
    const res = await call("kinds=pulse,weight,bloodPressure&days=30");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { series: Array<{ kind: string }> };
    };
    expect(body.data.series.map((s) => s.kind)).toEqual([
      "pulse",
      "weight",
      "bloodPressure",
    ]);
    for (const one of body.data.series) {
      const single = (await (
        await call(`kind=${one.kind}&days=30`)
      ).json()) as { data: unknown };
      expect(single.data).toEqual(one);
    }

    for (const bad of [
      "kind=weight&kinds=pulse",
      "days=30",
      "kinds=pulse,pulse",
      "kinds=pulse,garbage",
      "kinds=weight,bloodPressure,pulse,bodyFat,glucose,sleep,steps,boneMass,vo2Max",
    ]) {
      expect((await call(bad)).status, bad).toBe(422);
    }
  });

  it("GET /api/day/[date]", async () => {
    const { GET } = await import("@/app/api/day/[date]/route");
    const date = daysAgo(2).toISOString().slice(0, 10);
    const m = await measureRead(
      GET as unknown as Handler,
      `http://localhost/api/day/${date}`,
      { date },
    );
    expectWithin("/api/day/[date]", m, BUDGET.dayView);
  });

  it("GET /api/insights/health-status", async () => {
    const { GET } = await import("@/app/api/insights/health-status/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/insights/health-status",
    );
    expectWithin("/api/insights/health-status", m, BUDGET.healthStatus);
  });

  it("GET /api/insights/correlations", async () => {
    const { GET } = await import("@/app/api/insights/correlations/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/insights/correlations",
    );
    expectWithin("/api/insights/correlations", m, BUDGET.correlations);
  });

  it("GET /api/nav/counts", async () => {
    const { GET } = await import("@/app/api/nav/counts/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/nav/counts",
    );
    expectWithin("/api/nav/counts", m, BUDGET.navCounts);
  });

  it("GET /api/integrations/healthkit", async () => {
    const { GET } = await import("@/app/api/integrations/healthkit/route");
    const m = await measureRead(
      GET as unknown as Handler,
      "http://localhost/api/integrations/healthkit",
    );
    expectWithin(
      "/api/integrations/healthkit",
      m,
      BUDGET.integrationsHealthkit,
    );
  });

  it("GET /api/sleep/night", async () => {
    const { GET } = await import("@/app/api/sleep/night/route");
    const url = "http://localhost/api/sleep/night";
    const m = await measureRead(GET as unknown as Handler, url);
    expectWithin("/api/sleep/night", m, BUDGET.sleepNight);
    // The count is the one with the lines in it.
    const res = await (GET as unknown as Handler)(new NextRequest(url), {
      params: Promise.resolve({}),
    });
    const body = (await res.json()) as {
      data: { overlays: { metrics: Array<{ kind: string }> } | null };
    };
    expect(body.data.overlays?.metrics.map((x) => x.kind)).toContain("pulse");
  });

  it("POST /api/measurements/batch, 500 fresh rows", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");
    const start = daysAgo(3).getTime() + 30_000;
    const entries = Array.from({ length: 500 }, (_, i) => {
      const at = new Date(start + i * 60_000).toISOString();
      return {
        hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
        value: 55 + (i % 40),
        unit: "count/min",
        startDate: at,
        endDate: at,
        externalId: `budget-hr-${i}`,
      };
    });
    const post = (body: unknown) =>
      (POST as unknown as Handler)(
        new NextRequest("http://localhost/api/measurements/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({}) },
      );
    // One reading a month earlier first, as the reads warm up: it fills the
    // process-level caches a running server holds, which this case would
    // otherwise pay for whenever it runs before the reads do.
    const warmAt = daysAgo(30).toISOString();
    const warm = await post({
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
          value: 60,
          unit: "count/min",
          startDate: warmAt,
          endDate: warmAt,
          externalId: "budget-hr-warm",
        },
      ],
    });
    expect(warm.status, "batch warm-up").toBe(200);
    await evictUserCaches();
    const m = await countStatements(async () => {
      const res = await post({ entries });
      return {
        status: res.status,
        body: (await res.json()) as { data: { inserted: number } },
      };
    });
    expect(m.result.status).toBe(200);
    expect(m.result.body.data.inserted).toBe(500);
    expectWithin(
      "POST /api/measurements/batch (500)",
      m,
      BUDGET.batchIngest500,
    );
  });
});
