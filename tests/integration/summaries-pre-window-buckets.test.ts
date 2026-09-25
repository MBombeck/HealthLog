/**
 * The all-time `count / min / max / mean` the summaries slice reports on the
 * rollup path is composed from two halves: DAY buckets for the fold window,
 * and one raw aggregate for the readings older than it. Each reading has to
 * land in exactly one half.
 *
 * It did not. The bucket half read every DAY bucket the account had, while
 * the raw half read every reading older than `now − ROLLUP_FOLD_WINDOW_MS`.
 * Buckets do exist before that instant, from several writers:
 *
 *   - the Apple Health import up to v1.39.0 folded from the account's first
 *     reading to its last, whatever the window;
 *   - the per-write hook folds the one day it touched, however old;
 *   - every fold aligns its start down to a whole day, so the day the window
 *     starts on is a bucket that also holds readings from before the instant;
 *   - and nothing prunes a bucket once the moving window has passed it, so
 *     the buckets the first backfill wrote age out of the window by one day
 *     every day.
 *
 * A reading on such a day was counted twice, and the all-time mean was
 * weighted towards it. The live fallback, which reads the table once,
 * reported the true figures, so the same account read differently depending
 * on its coverage.
 *
 * Real Postgres, real fold, real slice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import {
  recomputeUserRollups,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Midday UTC, so the window's first day has twelve hours before the instant
// the window starts at and twelve after it.
const NOW = new Date("2026-09-25T12:00:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedWeights(
  readings: Array<{ at: Date; kg: number }>,
): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "pre-window-buckets",
      email: "pre-window-buckets@example.test",
      role: "USER",
      timezone: "UTC",
    },
  });
  await prisma.measurement.createMany({
    data: readings.map((r) => ({
      userId: user.id,
      type: "WEIGHT" as const,
      value: r.kg,
      unit: "kg",
      source: "MANUAL" as const,
      measuredAt: r.at,
    })),
  });
  return user.id;
}

const windowStart = () => new Date(NOW.getTime() - ROLLUP_FOLD_WINDOW_MS);
const recent = { at: new Date(NOW.getTime() - DAY_MS), kg: 80 };

async function expectTrueFigures(userId: string, readings: number[]) {
  // The premise of every case: the slice is on the rollup path, not the live
  // fallback, which never had the defect.
  const buckets = await getPrismaClient().measurementRollup.count({
    where: { userId, type: "WEIGHT", granularity: "DAY" },
  });
  expect(buckets).toBeGreaterThan(0);

  const slice = await computeSummariesSlice(userId);
  const weight = slice.summaries.WEIGHT;
  const mean = readings.reduce((a, b) => a + b, 0) / readings.length;
  expect(weight?.count).toBe(readings.length);
  expect(weight?.min).toBe(Math.min(...readings));
  expect(weight?.max).toBe(Math.max(...readings));
  expect(weight?.mean).toBe(Math.round(mean * 100) / 100);
}

describe("all-time summaries with DAY buckets older than the fold window", () => {
  it("counts once what the v1.39.0 import folded from the first reading on", async () => {
    const old = { at: new Date(NOW.getTime() - 6 * 365 * DAY_MS), kg: 70 };
    const userId = await seedWeights([old, recent]);
    // The pre-v1.39.1 import fold: the account's whole span.
    await recomputeUserRollups(userId, {
      from: old.at,
      to: new Date(recent.at.getTime() + 1),
    });

    await expectTrueFigures(userId, [70, 80]);
  });

  it("counts once an old day the per-write hook folded", async () => {
    const old = { at: new Date(NOW.getTime() - 7 * 365 * DAY_MS), kg: 64 };
    const userId = await seedWeights([old, recent]);
    await recomputeUserRollups(userId);
    // A backdated reading, as a manual entry or a sync of old samples writes
    // it: the hook folds that one day, window or not.
    await afterMeasurementMutation(userId, [
      { type: "WEIGHT", measuredAt: old.at },
    ]);

    await expectTrueFigures(userId, [64, 80]);
  });

  it("counts once a day an earlier fold wrote while it was still in the window", async () => {
    // Folded when the day was inside the window; the window has moved on and
    // nothing removed the bucket.
    const aged = {
      at: new Date(windowStart().getTime() - 30 * DAY_MS),
      kg: 72,
    };
    const userId = await seedWeights([aged, recent]);
    vi.setSystemTime(new Date(NOW.getTime() - 60 * DAY_MS));
    await recomputeUserRollups(userId);
    // Today's fold covers today's window and leaves the aged bucket alone.
    vi.setSystemTime(NOW);
    await recomputeUserRollups(userId);

    await expectTrueFigures(userId, [72, 80]);
  });

  it("counts once a reading on the window's first day before the instant it starts", async () => {
    const dayStart = startOfUtcDay(windowStart());
    const early = { at: new Date(dayStart.getTime() + HOUR_MS), kg: 66 };
    expect(early.at < windowStart()).toBe(true);
    const userId = await seedWeights([early, recent]);
    // The default fold, which is also what the v1.39.1 import clamp amounts
    // to: its start snaps down to the whole day.
    await recomputeUserRollups(userId);

    await expectTrueFigures(userId, [66, 80]);
  });
});
