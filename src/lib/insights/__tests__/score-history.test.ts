import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    healthScoreRecord: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/insights/derived/sleep-score", () => ({
  computeSleepScoreHistory: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { computeSleepScoreHistory } from "@/lib/insights/derived/sleep-score";
import { readScoreHistory } from "../score-history";

/**
 * v1.42 — the score-history reader: the window, the seams in the health
 * score's line, and the usual range behind the newest point. The rows are
 * stubbed; the integration suite reads them from Postgres.
 */

const records = prisma.healthScoreRecord.findMany as ReturnType<typeof vi.fn>;
const measurements = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
const sleep = computeSleepScoreHistory as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-06-30T10:00:00Z");
const TZ = "UTC";
const day = (offset: number) =>
  new Date(Date.parse("2026-06-30T12:00:00Z") + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

function args(
  score: "HEALTH_SCORE" | "READINESS" | "SLEEP_SCORE",
  days: number,
) {
  return {
    userId: "u1",
    score,
    days,
    now: NOW,
    tz: TZ,
    profile: vi.fn().mockResolvedValue({ ageYears: 40, sex: null }),
    priorityJson: vi.fn().mockResolvedValue(null),
  };
}

function row(
  offset: number,
  composite: number,
  configVersion: number | null = 1,
  scoreVersion = 1,
) {
  return { dayKey: day(offset), composite, configVersion, scoreVersion };
}

beforeEach(() => vi.clearAllMocks());

describe("readScoreHistory — health score", () => {
  it("reads thirty days back on a short window and keeps only the window's days", async () => {
    records.mockResolvedValue(
      Array.from({ length: 31 }, (_, i) => row(i - 30, 70 + (i % 3))),
    );
    const out = await readScoreHistory(args("HEALTH_SCORE", 7));
    const where = records.mock.calls[0]![0].where;
    expect(where.dayKey).toEqual({ gte: day(-30), lte: day(0) });
    expect(out.points.map((p) => p.day)).toEqual(
      [-6, -5, -4, -3, -2, -1, 0].map(day),
    );
    expect(out.band?.n).toBe(30);
  });

  it("reads the whole window when it is longer than thirty days", async () => {
    records.mockResolvedValue([]);
    await readScoreHistory(args("HEALTH_SCORE", 90));
    expect(records.mock.calls[0]![0].where.dayKey.gte).toBe(day(-89));
  });

  it("flags a seam on a recipe change, an algorithm change and an unknown recipe", async () => {
    records.mockResolvedValue([
      row(-5, 60, 1),
      row(-4, 61, 1),
      row(-3, 70, 2),
      row(-2, 71, 2, 2),
      row(-1, 72, null, 2),
      row(0, 73, null, 2),
    ]);
    const out = await readScoreHistory(args("HEALTH_SCORE", 30));
    expect(out.points.map((p) => p.seamBreak)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it("never opens the window on a seam", async () => {
    records.mockResolvedValue([row(-8, 50, 1), row(-6, 80, 2), row(-5, 80, 2)]);
    const out = await readScoreHistory(args("HEALTH_SCORE", 7));
    expect(out.points[0]).toEqual({
      day: day(-6),
      value: 80,
      seamBreak: false,
    });
  });

  it("forms the usual range from the newest point's side of the last seam", async () => {
    records.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, i) => row(i - 20, 30, 1)),
      ...Array.from({ length: 10 }, (_, i) => row(i - 9, 80 + (i % 2), 2)),
    ]);
    const out = await readScoreHistory(args("HEALTH_SCORE", 30));
    expect(out.band).not.toBeNull();
    expect(out.band!.n).toBe(9);
    expect(out.band!.lo).toBeGreaterThanOrEqual(79);
  });

  it("gives no range with fewer than seven days behind the newest point", async () => {
    records.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => row(i - 5, 70)),
    );
    expect((await readScoreHistory(args("HEALTH_SCORE", 30))).band).toBeNull();
  });

  it("gives no range for an empty window, even with older days on record", async () => {
    records.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => row(i - 29, 70)),
    );
    const out = await readScoreHistory(args("HEALTH_SCORE", 7));
    expect(out).toEqual({
      score: "HEALTH_SCORE",
      days: 7,
      points: [],
      band: null,
    });
  });

  it("does not load the sleep inputs for another score", async () => {
    records.mockResolvedValue([]);
    const a = args("HEALTH_SCORE", 7);
    await readScoreHistory(a);
    expect(a.profile).not.toHaveBeenCalled();
    expect(a.priorityJson).not.toHaveBeenCalled();
  });
});

describe("readScoreHistory — readiness", () => {
  it("reads only the nightly blend and files it on its wake day", async () => {
    measurements.mockResolvedValue([
      { value: 64.6, measuredAt: new Date(`${day(-3)}T12:00:00Z`) },
      // A same-night re-score: the later row wins.
      { value: 70, measuredAt: new Date(`${day(-2)}T12:00:00Z`) },
      { value: 71.2, measuredAt: new Date(`${day(-2)}T18:00:00Z`) },
    ]);
    const out = await readScoreHistory(args("READINESS", 7));
    const where = measurements.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      type: "RECOVERY_SCORE",
      source: "COMPUTED",
      deletedAt: null,
    });
    expect(out.points).toEqual([
      { day: day(-2), value: 65, seamBreak: false },
      { day: day(-1), value: 71, seamBreak: false },
    ]);
  });
});

describe("readScoreHistory — sleep score", () => {
  it("rounds each night and keeps the nights inside the window", async () => {
    sleep.mockResolvedValue([
      { night: day(-40), score: 50 },
      { night: day(-1), score: 77.4 },
      { night: day(0), score: 80.5 },
    ]);
    const a = args("SLEEP_SCORE", 7);
    const out = await readScoreHistory(a);
    expect(sleep.mock.calls[0]![2]).toMatchObject({
      fromDay: day(-30),
      now: NOW,
      tz: TZ,
      priorityJson: null,
    });
    expect(out.points).toEqual([
      { day: day(-1), value: 77, seamBreak: false },
      { day: day(0), value: 81, seamBreak: false },
    ]);
  });
});
