import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, annotate, countReadingsUpTo, readHourCells } = vi.hoisted(
  () => ({
    findMany: vi.fn(),
    annotate: vi.fn(),
    countReadingsUpTo: vi.fn(),
    readHourCells: vi.fn(),
  }),
);
vi.mock("@/lib/db", () => ({ prisma: { measurement: { findMany } } }));
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
      { measuredAt: minutesAgo(120), value: 61.5, n: 1400, source: null },
      { measuredAt: minutesAgo(60), value: 64, n: 1450, source: null },
    ]);
    const out = await readRecentReadings("u1", "PULSE", TZ, now);
    // No raw window read: the newest 365 and then the cells.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(readHourCells.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      type: "PULSE",
      timeZone: TZ,
      summed: false,
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
});
