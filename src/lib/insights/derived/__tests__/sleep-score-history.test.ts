import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

import { prisma } from "@/lib/db";
import {
  blendSleepSubScores,
  circularMeanMinutes,
  computeSleepScore,
  computeSleepScoreHistory,
  scoreComposition,
  scoreConsistency,
  scoreEfficiency,
  scoreNightsAgainstTrailingWindow,
  scoreSufficiency,
  scoreTiming,
  sleepNeedMinutes,
  type NightSummary,
} from "../sleep-score";

/**
 * v1.42 — the sleep score's history: every night scored the way the
 * headline scores its latest night, against the trailing window that ends
 * on it.
 */

const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

function summary(night: string, midpoint: number, asleep = 420): NightSummary {
  return {
    night,
    asleepMinutes: asleep,
    awakeMinutes: 20,
    remMinutes: 90,
    deepMinutes: 60,
    inBedMinutes: asleep + 30,
    hasStageBreakdown: true,
    midpoint,
  };
}

const NEED = sleepNeedMinutes(40);

describe("scoreNightsAgainstTrailingWindow", () => {
  it("scores each night with the window that ends on it", () => {
    const nights = [
      summary("2026-06-01", 180),
      summary("2026-06-02", 200),
      summary("2026-06-03", 240, 300),
    ];
    const out = scoreNightsAgainstTrailingWindow(nights, NEED, "2026-06-01");
    expect(out.map((n) => n.night)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
    // The third night by hand: its own sub-scores, the window's yardstick.
    const mids = [180, 200, 240];
    const expected = blendSleepSubScores({
      sufficiency: scoreSufficiency(300, NEED),
      efficiency: scoreEfficiency(300, 330),
      consistency: scoreConsistency(mids),
      timing: scoreTiming(240, circularMeanMinutes(mids), 3),
      composition: scoreComposition(90, 60, 300, true),
    }).score;
    expect(out[2]!.score).toBe(expected);
    // The first night has only itself behind it: no timing, no consistency.
    const first = blendSleepSubScores({
      sufficiency: scoreSufficiency(420, NEED),
      efficiency: scoreEfficiency(420, 450),
      consistency: scoreConsistency([180]),
      timing: scoreTiming(180, 180, 1),
      composition: scoreComposition(90, 60, 420, true),
    }).score;
    expect(out[0]!.score).toBe(first);
  });

  it("returns only nights from fromDay, using the earlier ones as the window", () => {
    const nights = [
      summary("2026-05-20", 100),
      summary("2026-05-21", 400),
      summary("2026-06-01", 180),
    ];
    const withWindow = scoreNightsAgainstTrailingWindow(
      nights,
      NEED,
      "2026-06-01",
    );
    const alone = scoreNightsAgainstTrailingWindow(
      [nights[2]!],
      NEED,
      "2026-06-01",
    );
    expect(withWindow.map((n) => n.night)).toEqual(["2026-06-01"]);
    expect(withWindow[0]!.score).not.toBe(alone[0]!.score);
  });

  it("drops a night that fell out of the window", () => {
    const old = summary("2026-04-01", 600);
    const recent = summary("2026-06-01", 180);
    const out = scoreNightsAgainstTrailingWindow(
      [old, recent],
      NEED,
      "2026-06-01",
    );
    const alone = scoreNightsAgainstTrailingWindow(
      [recent],
      NEED,
      "2026-06-01",
    );
    expect(out[0]!.score).toBe(alone[0]!.score);
  });
});

describe("computeSleepScoreHistory", () => {
  it("ends on the score the headline shows for the latest night", async () => {
    const rows = ["2026-05-30", "2026-05-31", "2026-06-01", "2026-06-02"].map(
      (day, i) => ({
        value: 400 + i * 15,
        measuredAt: new Date(`${day}T06:00:00Z`),
        sleepStage: "ASLEEP",
        source: "APPLE_HEALTH",
        deviceType: null,
      }),
    );
    findMany.mockResolvedValue(rows);
    const now = new Date("2026-06-02T10:00:00Z");
    const profile = { ageYears: 40, sex: "MALE" as const };
    const history = await computeSleepScoreHistory("u1", profile, {
      fromDay: "2026-05-27",
      now,
      tz: "UTC",
      priorityJson: null,
    });
    expect(history.map((n) => n.night)).toEqual([
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
    ]);
    const headline = await computeSleepScore("u1", profile, {
      now,
      tz: "UTC",
      priorityJson: null,
    });
    expect(headline.status).toBe("ok");
    if (headline.status === "ok") {
      expect(history.at(-1)!.score).toBe(headline.value.score);
    }
  });

  it("reads from the window before fromDay", async () => {
    findMany.mockResolvedValue([]);
    await computeSleepScoreHistory(
      "u1",
      { ageYears: 40, sex: null },
      {
        fromDay: "2026-06-01",
        now: new Date("2026-06-02T10:00:00Z"),
        tz: "UTC",
        priorityJson: null,
      },
    );
    const where = findMany.mock.calls[0]![0].where;
    expect(where.type).toBe("SLEEP_DURATION");
    expect(where.measuredAt.gte.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
