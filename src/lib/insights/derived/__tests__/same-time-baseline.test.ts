import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MeasurementSource } from "@/generated/prisma/client";

const findUniqueUser = vi.fn();
const findFirstMeasurement = vi.fn();
const findManyProfiles = vi.fn();
const findManyMeasurements = vi.fn();
const readDayTotals = vi.fn();

// The canonical day totals fold in SQL (`cumulative-day-totals.ts`, pinned on
// Postgres in `tests/integration/same-time-baseline-daily-totals.test.ts`);
// here they are served as the reader returns them.
vi.mock("@/lib/measurements/cumulative-day-totals", () => ({
  readCanonicalCumulativeDayTotals: (...a: unknown[]) => readDayTotals(...a),
}));

// Dense reads fold in SQL; the fake folds the rows the mocked `findMany` serves.
vi.mock("@/lib/measurements/dense-bucket-read", async () => {
  const { makeFakeDenseBucketRead } =
    await import("@/lib/measurements/__tests__/fake-dense-bucket-read");
  const { prisma } = await import("@/lib/db");
  return makeFakeDenseBucketRead((args) =>
    (prisma.measurement.findMany as (a: unknown) => never)(args),
  );
});
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => findUniqueUser(...a) },
    measurement: {
      findFirst: (...a: unknown[]) => findFirstMeasurement(...a),
      findMany: (...a: unknown[]) => findManyMeasurements(...a),
    },
    intradayCumulativeProfile: {
      findMany: (...a: unknown[]) => findManyProfiles(...a),
    },
  },
}));

import {
  computeSameTimeBaseline,
  ownedByDayTotalSource,
} from "../same-time-baseline";
import {
  SAME_TIME_BASELINE_MIN_HISTORY_DAYS,
  SAME_TIME_DAILY_TOTAL_MIN_HISTORY_DAYS,
} from "../registry";

/**
 * The honesty contract, pinned.
 *
 * A same-time comparison is only worth anything if it refuses to speak when it
 * cannot. Most of what follows tests silence, on purpose: the failure this
 * feature must never have is a confident "you are behind" derived from three
 * days of history, or from an account that has no intraday stream at all and
 * therefore has today's total wrong.
 */

const TZ = "UTC";
// 20:30 UTC, so the last COMPLETED local hour is 19.
const NOW = new Date("2026-06-10T20:30:00Z");
const TODAY = "2026-06-10";

/** A curve that reaches `total` linearly across the day. */
function curve(total: number): number[] {
  return Array.from({ length: 24 }, (_, h) =>
    Math.round((total * (h + 1)) / 24),
  );
}

function profileRow(dateKey: string, total: number, sampleCount = 200) {
  return {
    dateKey,
    timezone: TZ,
    hourlyCumulative: curve(total),
    dayTotal: total,
    sampleCount,
  };
}

/** `days` historical profiles, newest first, ending the day before today. */
function history(days: number, total: number, sampleCount = 200) {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (i + 1));
    return profileRow(d.toISOString().slice(0, 10), total, sampleCount);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueUser.mockResolvedValue({ timezone: TZ });
  findFirstMeasurement.mockResolvedValue({ unit: "steps" });
  // No live rows by default — every day under test comes off a stored profile.
  findManyMeasurements.mockResolvedValue([]);
  // No day totals by default: the hourly comparison answers alone.
  readDayTotals.mockResolvedValue([]);
});

/** One canonical day total, as the reader returns it. */
function dayTotal(
  dateKey: string,
  total: number,
  source: MeasurementSource = "GARMIN",
  lastUpdatedAt = new Date(`${dateKey}T19:05:00Z`),
) {
  return { dateKey, total, source, lastUpdatedAt };
}

/** `days` complete days before today, oldest first, all at `total`. */
function dayTotals(
  days: number,
  total: number | ((i: number) => number),
  source: MeasurementSource = "GARMIN",
) {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (days - i));
    return dayTotal(
      d.toISOString().slice(0, 10),
      typeof total === "number" ? total : total(i),
      source,
    );
  });
}

describe("computeSameTimeBaseline", () => {
  it("refuses to speak below the history floor", async () => {
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 4000),
      ...history(SAME_TIME_BASELINE_MIN_HISTORY_DAYS - 1, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("insufficient");
    if (d.status !== "insufficient") throw new Error("unreachable");
    expect(d.reason).toBe("learning_usual_day");
    expect(d.coverage.historyDays).toBe(
      SAME_TIME_BASELINE_MIN_HISTORY_DAYS - 1,
    );
  });

  it("speaks once the floor is reached", async () => {
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 4000),
      ...history(SAME_TIME_BASELINE_MIN_HISTORY_DAYS, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok" || d.value.mode !== "hourly") {
      throw new Error("unreachable");
    }
    expect(d.value.baselineDays).toBe(SAME_TIME_BASELINE_MIN_HISTORY_DAYS);
    expect(d.value.asOfHour).toBe(19);
    // Both curves cover hour 0 … 19 and are index-aligned.
    expect(d.value.todayCurve).toHaveLength(20);
    expect(d.value.typicalCurve).toHaveLength(20);
    expect(d.value.todayValue).toBe(d.value.todayCurve[19]);
    expect(d.value.typicalValue).toBe(d.value.typicalCurve[19]);
    expect(d.value.delta).toBe(d.value.todayValue - d.value.typicalValue);
    expect(d.value.band).toBe("below");
    expect(d.value.unit).toBe("steps");
  });

  it("says nothing when the account has no intraday rows today", async () => {
    // A phone account before its first sample of the day, with no day total
    // to stand in. Honest absence, never a day of zero activity.
    findManyProfiles.mockResolvedValue(history(20, 10_000));

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("insufficient");
    if (d.status !== "insufficient") throw new Error("unreachable");
    expect(d.reason).toBe("no_intraday_today");
  });

  it("says nothing before the day's first hour has finished", async () => {
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 100),
      ...history(20, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: new Date("2026-06-10T00:20:00Z"),
    });

    expect(d.status).toBe("insufficient");
    if (d.status !== "insufficient") throw new Error("unreachable");
    expect(d.reason).toBe("day_too_young");
  });

  it("drops days that were cut on another timezone", async () => {
    // After a move, "by 21:00" means a different moment. Averaging the two
    // would quietly compare unlike hours.
    const moved = history(20, 10_000).map((p) => ({
      ...p,
      timezone: "Pacific/Auckland",
    }));
    findManyProfiles.mockResolvedValue([profileRow(TODAY, 4000), ...moved]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("insufficient");
    if (d.status !== "insufficient") throw new Error("unreachable");
    // Twenty stored days, none of them usable, and the metric says so rather
    // than comparing hours that mean different things.
    expect(d.reason).toBe("learning_usual_day");
    expect(d.coverage.historyDays).toBe(0);
  });

  it("drops days too sparsely sampled to be a shape", async () => {
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 4000),
      ...history(20, 10_000, 2),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("insufficient");
    if (d.status !== "insufficient") throw new Error("unreachable");
    expect(d.reason).toBe("learning_usual_day");
    expect(d.coverage.historyDays).toBe(0);
  });

  it("calls a day inside its own band 'within'", async () => {
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 10_000),
      ...history(20, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok" || d.value.mode !== "hourly") {
      throw new Error("unreachable");
    }
    expect(d.value.band).toBe("within");
    expect(d.value.percentOfTypical).toBe(100);
  });

  it("calls a busy day 'above'", async () => {
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 30_000),
      ...history(20, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok" || d.value.mode !== "hourly") {
      throw new Error("unreachable");
    }
    expect(d.value.band).toBe("above");
    expect(d.value.delta).toBeGreaterThan(0);
  });

  it("never puts the band's lower edge below zero", async () => {
    // A cumulative total cannot be negative, and a sub-zero edge would widen
    // the "within" verdict on the low side for free.
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 0),
      ...history(20, 200),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok" || d.value.mode !== "hourly") {
      throw new Error("unreachable");
    }
    expect(d.value.typicalLow).toBeGreaterThanOrEqual(0);
  });

  it("reports no percentage rather than a fabricated one at an empty hour", async () => {
    // At 05:00 the typical total is legitimately zero. A ratio against zero is
    // undefined, not a hundred percent.
    findManyProfiles.mockResolvedValue([
      { ...profileRow(TODAY, 0), hourlyCumulative: new Array(24).fill(0) },
      ...history(20, 0).map((p) => ({
        ...p,
        hourlyCumulative: new Array(24).fill(0),
      })),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok" || d.value.mode !== "hourly") {
      throw new Error("unreachable");
    }
    expect(d.value.percentOfTypical).toBeNull();
  });

  it("ships no projected day total", async () => {
    // Extrapolating a partial day is a guess, and this feature exists to
    // replace guesses with the person's own history.
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 4000),
      ...history(20, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok" || d.value.mode !== "hourly") {
      throw new Error("unreachable");
    }
    expect(Object.keys(d.value)).not.toContain("projectedDayTotal");
  });

  it("answers a day-total account with its running total against the usual full day", async () => {
    // Garmin, Withings, Gadgetbridge: the day arrives as one total. There is
    // no hour to compare at, so the usual FULL day is the reference.
    readDayTotals.mockResolvedValue([
      ...dayTotals(14, (i) => 4000 + i * 500),
      dayTotal(TODAY, 2926),
    ]);
    findManyProfiles.mockResolvedValue([]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok" || d.value.mode !== "daily_total") {
      throw new Error("unreachable");
    }
    // 4000 … 10 500 in steps of 500: median 7250, quartiles 5625 and 8875.
    expect(d.value.todayValue).toBe(2926);
    expect(d.value.typicalValue).toBe(7250);
    expect(d.value.typicalLow).toBe(5625);
    expect(d.value.typicalHigh).toBe(8875);
    expect(d.value.dayRangeReached).toBe("not_yet");
    expect(d.value.percentOfTypical).toBe(40);
    expect(d.value.source).toBe("GARMIN");
    expect(d.value.updatedAt).toBe(`${TODAY}T19:05:00.000Z`);
    expect(d.value.baselineDays).toBe(14);
    expect(d.value.unit).toBe("steps");
    // No hour and no curve: a client that only knows the hourly payload finds
    // them missing instead of misreading a day total as a curve.
    expect(d.value).not.toHaveProperty("asOfHour");
    expect(d.value).not.toHaveProperty("todayCurve");
    expect(d.value).not.toHaveProperty("band");
    // The Apple Health hours are not read for a day a day-total source owns.
    expect(findManyProfiles).not.toHaveBeenCalled();
  });

  it("keeps the phone's hours out of a day the watch owns", async () => {
    // Source order puts the watch first: today's total is the watch's, so the
    // comparison is the watch's day total, never the phone's curve or a sum.
    readDayTotals.mockResolvedValue([
      ...dayTotals(14, 8000),
      dayTotal(TODAY, 9100, "GARMIN"),
    ]);
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 4000),
      ...history(20, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok" || d.value.mode !== "daily_total") {
      throw new Error("unreachable");
    }
    expect(d.value.todayValue).toBe(9100);
    expect(d.value.dayRangeReached).toBe("above");
  });

  it("answers in hours when the phone owns the day", async () => {
    readDayTotals.mockResolvedValue([
      ...dayTotals(14, 10_000, "APPLE_HEALTH"),
      dayTotal(TODAY, 4000, "APPLE_HEALTH"),
    ]);
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 4000),
      ...history(20, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok") throw new Error("unreachable");
    expect(d.value.mode).toBe("hourly");
  });

  it("stands in with the full day while the phone's hours are still learning", async () => {
    // An imported history has day totals but no hours yet: the range is
    // already known, so the card does not wait two weeks for it.
    readDayTotals.mockResolvedValue([
      ...dayTotals(10, 10_000, "APPLE_HEALTH"),
      dayTotal(TODAY, 4000, "APPLE_HEALTH"),
    ]);
    findManyProfiles.mockResolvedValue([
      profileRow(TODAY, 4000),
      ...history(3, 10_000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("ok");
    if (d.status !== "ok") throw new Error("unreachable");
    expect(d.value.mode).toBe("daily_total");
  });

  it("learns the usual full day below its own floor", async () => {
    readDayTotals.mockResolvedValue([
      ...dayTotals(SAME_TIME_DAILY_TOTAL_MIN_HISTORY_DAYS - 1, 8000),
      dayTotal(TODAY, 3000),
    ]);

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("insufficient");
    if (d.status !== "insufficient") throw new Error("unreachable");
    expect(d.reason).toBe("learning_usual_total");
    expect(d.coverage.historyDays).toBe(
      SAME_TIME_DAILY_TOTAL_MIN_HISTORY_DAYS - 1,
    );
  });

  it("says nothing before the day-total source has reported today", async () => {
    // Before the first sync of the day there is no running total, and a zero
    // would be invented.
    readDayTotals.mockResolvedValue(dayTotals(14, 8000));

    const d = await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });

    expect(d.status).toBe("insufficient");
    if (d.status !== "insufficient") throw new Error("unreachable");
    expect(d.reason).toBe("no_total_today");
    expect(findManyProfiles).not.toHaveBeenCalled();
  });

  it("reads the window's day totals in the account's source order", async () => {
    findUniqueUser.mockResolvedValue({
      timezone: TZ,
      sourcePriorityJson: { steps: ["GARMIN", "APPLE_HEALTH"] },
    });
    await computeSameTimeBaseline("u1", null, {
      type: "ACTIVITY_STEPS",
      now: NOW,
    });
    expect(readDayTotals).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        type: "ACTIVITY_STEPS",
        timeZone: TZ,
        fromDateKey: "2026-05-27",
        toDateKey: TODAY,
        priorityJson: { steps: ["GARMIN", "APPLE_HEALTH"] },
      }),
    );
  });
});

describe("ownedByDayTotalSource", () => {
  it("follows today's owner, and the newest earlier day before today has one", () => {
    expect(ownedByDayTotalSource([dayTotal(TODAY, 1, "GARMIN")], TODAY)).toBe(
      true,
    );
    expect(
      ownedByDayTotalSource([dayTotal(TODAY, 1, "APPLE_HEALTH")], TODAY),
    ).toBe(false);
    expect(
      ownedByDayTotalSource(
        [
          dayTotal("2026-06-08", 1, "APPLE_HEALTH"),
          dayTotal("2026-06-09", 1, "WITHINGS"),
        ],
        TODAY,
      ),
    ).toBe(true);
    expect(ownedByDayTotalSource([], TODAY)).toBe(false);
  });
});
