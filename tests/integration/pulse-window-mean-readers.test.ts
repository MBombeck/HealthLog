/**
 * The dashboard's and the insights' window means of pulse weigh each day once,
 * each day the mean of its hours' means; heart-rate variability, seeded with
 * the very same readings, keeps the plain mean over its readings.
 *
 * A workout day: twelve readings at 150 bpm inside one hour, then three
 * resting hours of one reading at 60 bpm. Its day value is (150 + 3 x 60) / 4
 * = 82.5, its readings' mean (12 x 150 + 3 x 60) / 15 = 132. A quiet day: one
 * reading at 60.
 *
 *   last 30 days     workout day + quiet day   71.25   (plain 127.5)
 *   days 30 to 60    workout day + quiet day   71.25   (plain 127.5)
 *   six years ago    workout day alone         82.5    (plain 132)
 *   all time         five days                 73.5    (plain 6060 / 47)
 *
 * Asserted on both paths of the dashboard summaries slice (the rollup tier,
 * with the six-year-old day in the pre-fold remainder, and the live
 * fallback), both paths of the insights aggregate, and the stats strip of the
 * series route's raw window.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import { buildComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// The reads kick off a background rollup refresh; keep it off so the live
// user stays on the live path for the whole file.
vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/measurement-rollups")>();
  return { ...actual, ensureUserRollupsFresh: vi.fn(async () => undefined) };
});

const prisma = getPrismaClient();
const DAY = 86_400_000;
const now = new Date();
const T0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

const LIVE = "pulse-window-live";
const ROLLUP = "pulse-window-rollup";

const WORKOUT_DAYS = [T0 - 3 * DAY, T0 - 45 * DAY, T0 - 6 * 365 * DAY];
const QUIET_DAYS = [T0 - 2 * DAY, T0 - 44 * DAY];

const HOURLY = {
  window: (82.5 + 60) / 2,
  allTime: (82.5 * 3 + 60 * 2) / 5,
};
const PLAIN = {
  window: (12 * 150 + 3 * 60 + 60) / 16,
  allTime: (3 * (12 * 150 + 3 * 60) + 2 * 60) / 47,
};

function rows(
  userId: string,
  type: "PULSE" | "HEART_RATE_VARIABILITY",
): Prisma.MeasurementCreateManyInput[] {
  const unit = type === "PULSE" ? "bpm" : "ms";
  const out: Prisma.MeasurementCreateManyInput[] = [];
  const push = (at: number, value: number) =>
    out.push({
      id: `${userId}-${type}-${at}`,
      userId,
      type,
      unit,
      source: "APPLE_HEALTH",
      value,
      measuredAt: new Date(at),
    });
  for (const d of WORKOUT_DAYS) {
    for (let i = 0; i < 12; i += 1) push(d + 10 * 3_600_000 + i * 300_000, 150);
    for (const h of [12, 14, 16]) push(d + h * 3_600_000, 60);
  }
  for (const d of QUIET_DAYS) push(d + 8 * 3_600_000, 60);
  return out;
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const user of [LIVE, ROLLUP]) {
    await prisma.user.create({
      data: { id: user, username: user, timezone: "UTC" },
    });
    invalidateUserTimezone(user);
    await prisma.measurement.createMany({
      data: [...rows(user, "PULSE"), ...rows(user, "HEART_RATE_VARIABILITY")],
    });
  }
  // The rollup user's DAY tier covers the last 400 days; the six-year-old
  // workout day stays outside it, in the pre-fold remainder.
  await recomputeUserRollups(ROLLUP, {
    types: ["PULSE", "HEART_RATE_VARIABILITY"],
    from: new Date(T0 - 400 * DAY),
    to: new Date(T0 + DAY),
  });
}, 120_000);

describe.each([
  { path: "rollup", user: ROLLUP },
  { path: "live", user: LIVE },
])("dashboard summaries slice, $path path", ({ user }) => {
  it("weighs each day once for pulse", async () => {
    const { summaries } = await computeSummariesSlice(user);
    const pulse = summaries.PULSE;
    expect(pulse.avg7).toBeCloseTo(HOURLY.window, 2);
    expect(pulse.avg30).toBeCloseTo(HOURLY.window, 2);
    expect(pulse.avg30LastMonth).toBeCloseTo(HOURLY.window, 2);
    expect(pulse.mean).toBeCloseTo(HOURLY.allTime, 2);
    // Count, min and max stay over every reading.
    expect(pulse.count).toBe(47);
    expect(pulse.min).toBe(60);
    expect(pulse.max).toBe(150);
  });

  it("keeps the plain mean for HRV", async () => {
    const { summaries } = await computeSummariesSlice(user);
    const hrv = summaries.HEART_RATE_VARIABILITY;
    expect(hrv.avg7).toBeCloseTo(PLAIN.window, 2);
    expect(hrv.avg30).toBeCloseTo(PLAIN.window, 2);
    expect(hrv.avg30LastMonth).toBeCloseTo(PLAIN.window, 2);
    expect(hrv.mean).toBeCloseTo(PLAIN.allTime, 2);
  });
});

describe.each([
  { path: "rollup", user: ROLLUP },
  { path: "live", user: LIVE },
])("insights aggregate, $path path", ({ user }) => {
  it("weighs each day once for pulse and keeps the plain mean for HRV", async () => {
    const { summaries } = await buildComprehensiveAggregate(user);
    expect(summaries.PULSE.avg7).toBeCloseTo(HOURLY.window, 2);
    expect(summaries.PULSE.avg30).toBeCloseTo(HOURLY.window, 2);
    expect(summaries.PULSE.avg30LastMonth).toBeCloseTo(HOURLY.window, 2);
    // The 90-day window holds two workout days and two quiet days.
    expect(summaries.PULSE.mean).toBeCloseTo(HOURLY.window, 2);
    expect(summaries.PULSE.count).toBe(32);
    const hrv = summaries.HEART_RATE_VARIABILITY;
    expect(hrv.avg7).toBeCloseTo(PLAIN.window, 2);
    expect(hrv.avg30LastMonth).toBeCloseTo(PLAIN.window, 2);
    expect(hrv.mean).toBeCloseTo(PLAIN.window, 2);
  });
});

describe("series route, raw window", () => {
  async function stats(kind: string) {
    const s = await prisma.session.create({
      data: { userId: LIVE, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.clear();
    cookieJar.set("healthlog_session", s.id);
    const { GET } = await import("@/app/api/measurements/series/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/measurements/series?kind=${kind}&days=30`,
      ),
    );
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        data: {
          points: unknown[];
          stats: { mean: number; count: number; min: number; max: number };
        };
      }
    ).data;
  }

  it("gives pulse the mean of its days on the stats strip", async () => {
    const data = await stats("pulse");
    // Raw points: every reading of the last 30 days.
    expect(data.points).toHaveLength(16);
    expect(data.stats.mean).toBeCloseTo(HOURLY.window, 2);
    expect(data.stats.count).toBe(16);
    expect(data.stats.min).toBe(60);
    expect(data.stats.max).toBe(150);
  });

  it("keeps the plain mean for HRV", async () => {
    const data = await stats("heartRateVariability");
    expect(data.stats.mean).toBeCloseTo(PLAIN.window, 2);
  });
});
