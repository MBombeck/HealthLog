/**
 * v1.42 — the timeline's sleep line is the time asleep per night, averaged
 * over the bucket's nights. Against Postgres.
 *
 * Sleep is stored one row per stage. Read like any other type, the timeline
 * averaged those rows as if each were a night (IN_BED, AWAKE and every CORE
 * fragment alike), so a quarter of seven-hour nights read as a little over
 * two and a half hours. A night here is what the sleep page and the day view
 * call one: CORE + DEEP + REM of the night's winning writer, IN_BED and
 * AWAKE left out, keyed by its wake day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-09T12:00:00.000Z");

let user = "";
let seq = 0;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  // A fresh record per test: the long windows are cached per record.
  user = `timeline-sleep-${++seq}`;
  await getPrismaClient().user.create({
    data: {
      id: user,
      username: user,
      email: `${user}@example.test`,
      timezone: TZ,
    },
  });
});

/** A Berlin wall-clock instant (summer and winter offsets both handled). */
function berlin(day: string, hhmm: string): Date {
  const guess = new Date(`${day}T${hhmm}:00.000Z`);
  const wall = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(guess);
  const [d, t] = wall.split(", ");
  const shown = new Date(`${d}T${t}:00.000Z`);
  return new Date(guess.getTime() - (shown.getTime() - guess.getTime()));
}

/**
 * One night that wakes on `wake`: in bed from 22:40 the evening before to
 * 06:40, asleep 50 + 150 + 90 + 100 + `lastCore` minutes around one AWAKE
 * spell, the first segment ending before midnight. Each row's instant is its
 * segment's end, as the importers write it.
 */
async function seedNight(wake: string, lastCore: number) {
  const { shiftDateKey } = await import("@/lib/tz/format");
  const eve = shiftDateKey(wake, -1);
  const rows: Array<[string, number, string, string]> = [
    ["IN_BED", 480, wake, "06:40"],
    ["CORE", 50, eve, "23:50"],
    ["CORE", 150, wake, "02:20"],
    ["DEEP", 90, wake, "03:50"],
    ["REM", 100, wake, "05:30"],
    ["AWAKE", 20, wake, "05:50"],
    ["CORE", lastCore, wake, "06:30"],
  ];
  await getPrismaClient().measurement.createMany({
    data: rows.map(([stage, minutes, day, end], i) => ({
      userId: user,
      type: "SLEEP_DURATION" as const,
      value: minutes,
      unit: "minutes",
      source: "APPLE_HEALTH" as const,
      measuredAt: berlin(day, end),
      externalId: `uuid-${wake}-${i}`,
      sleepStage: stage as "IN_BED" | "CORE" | "DEEP" | "REM" | "AWAKE",
    })),
  });
}

async function sleepSeries(
  from: string,
  to: string,
  bucket: "month" | "quarter",
) {
  const { loadTimelineSeries } = await import("@/lib/timeline/series");
  const [out] = await loadTimelineSeries({
    userId: user,
    keys: ["SLEEP_DURATION"],
    from,
    to,
    tz: TZ,
    bucket,
    priorityJson: null,
    now: NOW,
  });
  return out?.points ?? [];
}

describe("the timeline's sleep line", () => {
  it("averages the nights of a quarter, each night its time asleep", async () => {
    await seedNight("2026-07-03", 40); // 430 min asleep
    await seedNight("2026-08-12", 50); // 440
    await seedNight("2026-09-20", 60); // 450
    expect(await sleepSeries("2026-07-01", "2026-09-30", "quarter")).toEqual([
      { t: "2026-07-01", mean: 440, count: 3 },
    ]);
    expect(await sleepSeries("2026-07-01", "2026-09-30", "month")).toEqual([
      { t: "2026-07-01", mean: 430, count: 1 },
      { t: "2026-08-01", mean: 440, count: 1 },
      { t: "2026-09-01", mean: 450, count: 1 },
    ]);
  });

  it("reads the nights, not the rolled-up stage rows, over a long window", async () => {
    await seedNight("2023-02-03", 40); // 430
    await seedNight("2023-03-04", 60); // 450
    // What the rollup tier holds for those days: the mean of the stage rows.
    await getPrismaClient().measurementRollup.createMany({
      data: ["2023-02-01", "2023-03-01"].map((month) => ({
        userId: user,
        type: "SLEEP_DURATION" as const,
        granularity: "MONTH" as const,
        bucketStart: new Date(`${month}T00:00:00.000Z`),
        source: "APPLE_HEALTH" as const,
        count: 6,
        mean: 155,
        minValue: 20,
        maxValue: 480,
        sumValue: 930,
      })),
    });
    expect(await sleepSeries("2016-10-09", "2026-10-09", "quarter")).toEqual([
      { t: "2023-01-01", mean: 440, count: 2 },
    ]);
  });

  it("keeps a night whole where one year's read ends and the next begins", async () => {
    const { readNightCells } = await import("@/lib/timeline/series");
    const { shiftDateKey } = await import("@/lib/tz/format");
    // The second read starts 366 days after the first.
    const from = "2024-01-01";
    const boundary = shiftDateKey(from, 366);
    await seedNight(boundary, 40);
    const nights = await readNightCells({
      userId: user,
      from,
      to: "2025-12-31",
      tz: TZ,
      priorityJson: null,
    });
    expect([...nights]).toEqual([[boundary, { value: 430, count: 1 }]]);
  });
});
