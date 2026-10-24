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
 * Every read runs on a miss: the user's caches are evicted before the
 * measured call, after one warm-up call that fills the process-level caches
 * a running server already holds. The large-account numbers (latency and
 * statements on 1.26 million rows) come from `scripts/bench/run.ts`; see
 * docs/contributing/benchmarks.md.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
  SleepStage,
} from "@/generated/prisma/client";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const USER_ID = "user-query-budget";
const DAY_MS = 86_400_000;

/**
 * Statements per request on this fixture. Each is the measured count; see
 * the header for how to move one.
 */
const BUDGET = {
  authMe: 13,
  dashboardSummary: 28,
  dashboardSnapshot: 99,
  series30: 6,
  series365: 5,
  series3650: 5,
  dayView: 47,
  healthStatus: 59,
  correlations: 43,
  batchIngest500: 28,
} as const;

type Handler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

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
    await truncateAllTables(getPrismaClient());
    cookieJar.clear();
    await seed();
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
    const m = await countStatements(async () => {
      const res = await (POST as unknown as Handler)(
        new NextRequest("http://localhost/api/measurements/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries }),
        }),
        { params: Promise.resolve({}) },
      );
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
