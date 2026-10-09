/**
 * v1.42 — the timeline's long windows read the rolled-up months from the
 * month the rollup fold boundary falls in, whatever the account's zone.
 * Against Postgres.
 *
 * The rollup tier keys its months by the UTC calendar. West of UTC the local
 * midnight of the boundary month comes hours after that month's UTC start, so
 * a read from the local midnight left the month out: a gap in a month series,
 * and a quarter averaged over two of its three months.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Five years before this the fold boundary falls on 2021-10-10, so the first
 * rolled-up month is November 2021 and the first rolled-up quarter Q1 2022.
 */
const NOW = new Date("2026-10-09T12:00:00.000Z");
const TZ = "America/New_York";
const USER = "timeline-west";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: TZ,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** One DAY rollup row of resting heart rate per `[UTC date, mean, count]`. */
async function seedDays(days: Array<[string, number, number]>) {
  await getPrismaClient().measurementRollup.createMany({
    data: days.map(([date, mean, count]) => ({
      userId: USER,
      type: "RESTING_HEART_RATE" as const,
      granularity: "DAY" as const,
      bucketStart: new Date(`${date}T00:00:00.000Z`),
      source: "APPLE_HEALTH" as const,
      count,
      mean,
      minValue: mean,
      maxValue: mean,
      sumValue: mean * count,
    })),
  });
}

async function series(bucket: "month" | "quarter") {
  const { loadTimelineSeries } = await import("@/lib/timeline/series");
  const [out] = await loadTimelineSeries({
    userId: USER,
    keys: ["RESTING_HEART_RATE"],
    from: "2016-10-09",
    to: "2026-10-09",
    tz: TZ,
    bucket,
    priorityJson: null,
    now: NOW,
  });
  return out?.points ?? [];
}

describe("timeline rollup months west of UTC", () => {
  it("keeps the first rolled-up month after the fold boundary", async () => {
    await seedDays([
      ["2021-11-05", 60, 2],
      ["2021-12-05", 62, 2],
      ["2022-01-05", 64, 2],
    ]);
    const points = await series("month");
    expect(points).toEqual([
      { t: "2021-11-01", mean: 60, count: 2 },
      { t: "2021-12-01", mean: 62, count: 2 },
      { t: "2022-01-01", mean: 64, count: 2 },
    ]);
  });

  it("averages the first rolled-up quarter over all three of its months", async () => {
    await seedDays([
      ["2022-01-05", 60, 1],
      ["2022-02-05", 63, 1],
      ["2022-02-06", 63, 1],
      ["2022-03-05", 66, 1],
    ]);
    const points = await series("quarter");
    // Each month weighs its days: (60 + 63 + 63 + 66) / 4.
    expect(points).toEqual([{ t: "2022-01-01", mean: 63, count: 4 }]);
  });
});
