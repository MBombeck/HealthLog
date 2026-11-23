import { describe, it, expect, vi, beforeEach } from "vitest";

const findUniqueUser = vi.fn();
const findFirstMeasurement = vi.fn();
const findManyProfiles = vi.fn();
const findManyMeasurements = vi.fn();

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

import { computeSameTimeBaseline } from "../same-time-baseline";
import { SAME_TIME_BASELINE_MIN_HISTORY_DAYS } from "../registry";

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
});

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
    if (d.status !== "ok") throw new Error("unreachable");
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
    // The permanent state for every daily-total source. Honest absence, and
    // it must never be confused with a day of zero activity.
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
    if (d.status !== "ok") throw new Error("unreachable");
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
    if (d.status !== "ok") throw new Error("unreachable");
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
    if (d.status !== "ok") throw new Error("unreachable");
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
    if (d.status !== "ok") throw new Error("unreachable");
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
    if (d.status !== "ok") throw new Error("unreachable");
    expect(Object.keys(d.value)).not.toContain("projectedDayTotal");
  });
});
