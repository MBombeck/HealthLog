/**
 * The start page and `/api/analytics` show one health score for one day.
 *
 * The dashboard snapshot holds its second phase back while the rollup tier
 * does not cover a dense type it reads, and the health score rides that
 * phase. `/api/analytics` computes the score without the gate. An account
 * whose history arrived without the write hooks (seeded, restored, imported
 * straight into the table) keeps readings older than the 90 days the read
 * path folds, so its coverage never closes before the next boot: the start
 * page said "not enough data" while Insights showed a number.
 *
 * Real Postgres, real route, real builder, no fold before the reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

import { buildDashboardSnapshot } from "@/lib/dashboard/snapshot";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";
import { _resetRollupFoldRequestsForTests } from "@/lib/rollups/full-backfill";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

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

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  __resetAllCachesForTests();
  _resetRollupFoldRequestsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Three scored domains (blood pressure, sleep, adiposity), written straight
 * to the table like a seed or a restore, plus one blood-pressure pair 200
 * days back: inside the fold window, outside the 90 days the read path folds.
 */
async function seedHistoryWithoutFold() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "hs-parity",
      email: "hs-parity@example.test",
      role: "USER",
      heightCm: 178,
      dateOfBirth: new Date("1985-07-09"),
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  const now = Date.now();
  const rows: Array<{
    type:
      | "BLOOD_PRESSURE_SYS"
      | "BLOOD_PRESSURE_DIA"
      | "SLEEP_DURATION"
      | "WAIST_CIRCUMFERENCE";
    value: number;
    unit: string;
    measuredAt: Date;
    sleepStage?: "ASLEEP";
  }> = [];
  for (const daysAgo of [...Array.from({ length: 20 }, (_, i) => i), 200]) {
    const at = new Date(now - daysAgo * DAY);
    rows.push(
      { type: "BLOOD_PRESSURE_SYS", value: 122, unit: "mmHg", measuredAt: at },
      { type: "BLOOD_PRESSURE_DIA", value: 78, unit: "mmHg", measuredAt: at },
    );
  }
  for (let i = 0; i < 14; i++) {
    const wake = new Date(now - i * DAY);
    wake.setUTCHours(6, 0, 0, 0);
    rows.push({
      type: "SLEEP_DURATION",
      value: 450,
      unit: "min",
      measuredAt: wake,
      sleepStage: "ASLEEP",
    });
  }
  rows.push({
    type: "WAIST_CIRCUMFERENCE",
    value: 82,
    unit: "cm",
    measuredAt: new Date(now),
  });
  await prisma.measurement.createMany({
    data: rows.map((row) => ({ ...row, userId: user.id })),
  });
  return user;
}

function snapshotFor(user: Awaited<ReturnType<typeof seedHistoryWithoutFold>>) {
  return buildDashboardSnapshot(
    getPrismaClient(),
    {
      id: user.id,
      username: user.username,
      displayName: null,
      timezone: user.timezone,
      heightCm: user.heightCm,
      dateOfBirth: user.dateOfBirth,
      gender: null,
      glucoseUnit: null,
      onboardingTourCompleted: true,
      insightsCachedText: null,
      insightsCachedAt: null,
      insightsCachedLocale: null,
      dashboardWidgetsJson: null,
      thresholdsJson: null,
      healthScoreConfigJson: null,
    },
    { hasProvider: async () => false },
  );
}

async function analyticsScore(): Promise<number | null> {
  const { GET } = await import("@/app/api/analytics/route");
  const res = await (GET as (req: Request) => Promise<Response>)(
    new Request("http://localhost/api/analytics"),
  );
  expect(res.status).toBe(200);
  const env = (await res.json()) as {
    data: {
      healthScore: {
        composite: { status: string; value?: { score: number } };
      } | null;
    };
  };
  const composite = env.data.healthScore?.composite;
  return composite?.status === "ok" ? composite.value!.score : null;
}

describe("health score on the start page and on Insights", () => {
  it("serves the score analytics computed while the snapshot's phase is held back", async () => {
    const user = await seedHistoryWithoutFold();

    const fromAnalytics = await analyticsScore();
    expect(fromAnalytics).not.toBeNull();
    // The read path folds the last 90 days in the background; the reading
    // from 200 days back keeps blood pressure uncovered after it.
    await settleBackgroundTasks();
    _resetRollupFoldRequestsForTests();
    const coverage = await probeRollupCoverage(user.id);
    expect(coverage.get("BLOOD_PRESSURE_SYS")).toBe(false);

    const snap = await snapshotFor(user);

    // The premise: the phase really is held back.
    expect(snap.extras).toBeNull();
    expect(snap.healthScore?.score).toBe(fromAnalytics);
  });

  it("asks for the fold, after which the snapshot computes the same score itself", async () => {
    const user = await seedHistoryWithoutFold();

    const first = await snapshotFor(user);
    expect(first.extras).toBeNull();
    // No queue in this suite, so the requested fold runs in place.
    await settleBackgroundTasks();

    const coverage = await probeRollupCoverage(user.id);
    expect(coverage.get("BLOOD_PRESSURE_SYS")).toBe(true);

    __resetAllCachesForTests();
    const warm = await snapshotFor(user);
    expect(warm.extras).not.toBeNull();
    expect(warm.healthScore).not.toBeNull();

    __resetAllCachesForTests();
    expect(await analyticsScore()).toBe(warm.healthScore!.score);
  });
});
