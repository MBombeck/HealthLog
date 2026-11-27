import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findMany,
  annotate,
  countReadingsUpTo,
  readHourCells,
  loadUserSourcePriority,
} = vi.hoisted(() => ({
  findMany: vi.fn(),
  annotate: vi.fn(),
  countReadingsUpTo: vi.fn(),
  readHourCells: vi.fn(),
  loadUserSourcePriority: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { measurement: { findMany } } }));
vi.mock("@/lib/rollups/measurement-read", () => ({ loadUserSourcePriority }));
vi.mock("@/lib/logging/context", () => ({ annotate }));
vi.mock("@/lib/measurements/dense-bucket-read", () => ({
  countReadingsUpTo,
  readHourCells,
}));

import {
  DENSE_READ_CAP,
  readRecentReadings,
  RECENT_READINGS,
} from "../recent-readings";

const now = new Date("2026-10-20T12:00:00Z");
const TZ = "Europe/Berlin";
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);

beforeEach(() => {
  findMany.mockReset();
  annotate.mockReset();
  countReadingsUpTo.mockReset();
  readHourCells.mockReset();
  loadUserSourcePriority.mockReset();
  loadUserSourcePriority.mockResolvedValue(null);
});

describe("readRecentReadings", () => {
  it("keeps the latest 365 when they reach back 30 days", async () => {
    // One a day: 365 readings span a year.
    const rows = Array.from({ length: RECENT_READINGS }, (_, i) => ({
      value: 70,
      measuredAt: minutesAgo(i * 1440),
    }));
    findMany.mockResolvedValueOnce(rows);
    const out = await readRecentReadings("u1", "PULSE", TZ, now);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(countReadingsUpTo).not.toHaveBeenCalled();
    expect(out[0].measuredAt < out[out.length - 1].measuredAt).toBe(true);
  });

  it("reads the last 30 days by time when 365 readings are a few hours", async () => {
    const dense = Array.from({ length: RECENT_READINGS }, (_, i) => ({
      value: 70,
      measuredAt: minutesAgo(i),
    }));
    const month = Array.from({ length: 30 * 24 }, (_, i) => ({
      value: 70,
      measuredAt: minutesAgo((30 * 24 - 1 - i) * 60),
    }));
    findMany.mockResolvedValueOnce(dense).mockResolvedValueOnce(month);
    countReadingsUpTo.mockResolvedValueOnce(month.length);
    const out = await readRecentReadings("u1", "PULSE", TZ, now);
    expect(findMany).toHaveBeenCalledTimes(2);
    const window = findMany.mock.calls[1][0] as {
      where: { measuredAt: { gte: Date }; deletedAt: null };
      take?: number;
    };
    expect(window.where.deletedAt).toBeNull();
    expect(window.where.measuredAt.gte.toISOString()).toBe(
      "2026-09-20T12:00:00.000Z",
    );
    // The window's rows are counted first, so the row read itself is uncapped.
    expect(window.take).toBeUndefined();
    expect(countReadingsUpTo.mock.calls[0][0]).toMatchObject({
      cap: DENSE_READ_CAP,
    });
    expect(out).toHaveLength(month.length);
    expect(readHourCells).not.toHaveBeenCalled();
    expect(annotate).not.toHaveBeenCalled();
  });

  it("reads hour cells when the window holds more rows than the cap", async () => {
    const dense = Array.from({ length: RECENT_READINGS }, (_, i) => ({
      value: 70,
      measuredAt: minutesAgo(i),
    }));
    findMany.mockResolvedValueOnce(dense);
    countReadingsUpTo.mockResolvedValueOnce(DENSE_READ_CAP + 1);
    readHourCells.mockResolvedValueOnce([
      {
        measuredAt: minutesAgo(120),
        value: 61.5,
        n: 1400,
        source: "APPLE_HEALTH",
        deviceType: null,
      },
      {
        measuredAt: minutesAgo(60),
        value: 64,
        n: 1450,
        source: "APPLE_HEALTH",
        deviceType: null,
      },
    ]);
    const out = await readRecentReadings("u1", "PULSE", TZ, now);
    // No raw window read: the newest 365 and then the cells.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(readHourCells.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      type: "PULSE",
      timeZone: TZ,
      summed: false,
      // Per source, so the day pick can still choose between them.
      bySource: true,
    });
    expect(out).toEqual([
      { measuredAt: minutesAgo(120), value: 61.5 },
      { measuredAt: minutesAgo(60), value: 64 },
    ]);
    expect(annotate).toHaveBeenCalledOnce();
  });

  it("sums the hours of a summed type", async () => {
    findMany.mockResolvedValueOnce(
      Array.from({ length: RECENT_READINGS }, (_, i) => ({
        value: 3,
        measuredAt: minutesAgo(i),
      })),
    );
    countReadingsUpTo.mockResolvedValueOnce(DENSE_READ_CAP + 1);
    readHourCells.mockResolvedValueOnce([]);
    await readRecentReadings("u1", "ACTIVITY_STEPS", TZ, now);
    expect(readHourCells.mock.calls[0][0]).toMatchObject({ summed: true });
  });

  it("keeps fewer than 365 readings whole", async () => {
    findMany.mockResolvedValueOnce([{ value: 1, measuredAt: minutesAgo(5) }]);
    expect(await readRecentReadings("u1", "PULSE", TZ, now)).toHaveLength(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps each day to the source the ladder puts first", async () => {
    // Withings ranks above a hand-typed reading on the default pulse ladder.
    findMany.mockResolvedValueOnce([
      {
        value: 90,
        measuredAt: minutesAgo(30),
        source: "MANUAL",
        deviceType: null,
      },
      {
        value: 60,
        measuredAt: minutesAgo(20),
        source: "WITHINGS",
        deviceType: null,
      },
      {
        value: 62,
        measuredAt: minutesAgo(10),
        source: "WITHINGS",
        deviceType: null,
      },
      // The day before holds only the hand-typed reading, and keeps it.
      {
        value: 88,
        measuredAt: minutesAgo(1440),
        source: "MANUAL",
        deviceType: null,
      },
    ]);
    const out = await readRecentReadings("u1", "PULSE", TZ, now);
    expect(out).toEqual([
      { value: 88, measuredAt: minutesAgo(1440) },
      { value: 60, measuredAt: minutesAgo(20) },
      { value: 62, measuredAt: minutesAgo(10) },
    ]);
  });

  it("follows the person's own ladder", async () => {
    loadUserSourcePriority.mockResolvedValue({
      metricPriority: { pulse: ["MANUAL", "WITHINGS"] },
    });
    findMany.mockResolvedValueOnce([
      {
        value: 90,
        measuredAt: minutesAgo(30),
        source: "MANUAL",
        deviceType: null,
      },
      {
        value: 60,
        measuredAt: minutesAgo(20),
        source: "WITHINGS",
        deviceType: null,
      },
    ]);
    const out = await readRecentReadings("u1", "PULSE", TZ, now);
    expect(out).toEqual([{ value: 90, measuredAt: minutesAgo(30) }]);
  });

  it("passes a type without a ladder through, every source kept", async () => {
    findMany.mockResolvedValueOnce([
      {
        value: 5.1,
        measuredAt: minutesAgo(30),
        source: "MANUAL",
        deviceType: null,
      },
      {
        value: 5.4,
        measuredAt: minutesAgo(20),
        source: "APPLE_HEALTH",
        deviceType: null,
      },
    ]);
    const out = await readRecentReadings("u1", "BLOOD_GLUCOSE", TZ, now);
    expect(out).toHaveLength(2);
    expect(loadUserSourcePriority).not.toHaveBeenCalled();
  });
});
