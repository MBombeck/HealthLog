import { describe, expect, it } from "vitest";

import { findUngroundedBriefingNumbers } from "@/lib/ai/briefing-grounding";

import { computeSignalsOfDay } from "../signals-of-day";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Glucose climbs after every meal, so a fasting morning reading held against
 * the mean of whole days (fasting, lunch, dinner) reads as low every morning.
 * Twenty days of a fasting value near 90 at 07:00 local, about 140 after lunch
 * and about 150 after dinner; today one fasting reading so far. Berlin is
 * UTC+2 in October, so 07:00 local is 05:00 UTC.
 */
const TZ = "Europe/Berlin";
const TODAY_0700 = Date.UTC(2026, 9, 5, 5, 0);

function glucose(todayValues: Array<{ value: number; at: number }>) {
  const out: Array<{ value: number; measuredAt: Date }> = [];
  for (let d = 20; d >= 1; d -= 1) {
    const morning = TODAY_0700 - d * DAY;
    const wobble = (d % 3) - 1; // -1, 0, +1
    out.push({ value: 90 + wobble, measuredAt: new Date(morning) });
    out.push({ value: 140 + wobble, measuredAt: new Date(morning + 6 * HOUR) });
    out.push({
      value: 150 + wobble,
      measuredAt: new Date(morning + 12 * HOUR),
    });
  }
  for (const t of todayValues) {
    out.push({ value: t.value, measuredAt: new Date(t.at) });
  }
  return out;
}

function signalFor(
  rows: Array<{ value: number; measuredAt: Date }>,
  now: number,
) {
  return computeSignalsOfDay(
    (type) => (type === "BLOOD_GLUCOSE" ? rows : []),
    now,
    TZ,
  ).find((s) => s.metric === "glucose");
}

describe("the glucose signal of the day compares like with like", () => {
  it("holds a fasting morning against earlier mornings, not whole days", () => {
    const now = TODAY_0700 + 2 * HOUR; // 09:00 local
    const signal = signalFor(glucose([{ value: 90, at: TODAY_0700 }]), now);
    expect(signal).toBeDefined();
    expect(signal?.basis).toBe("sameHours");
    expect(signal?.avg30).toBeCloseTo(90, 0);
    expect(Math.abs(signal?.deltaVs30 ?? 99)).toBeLessThan(2);
    expect(signal?.outsideNormalSwing).toBe(false);
    expect(signal?.recentAnomaly).toBeNull();
  });

  it("still flags a fasting value well above the usual mornings", () => {
    const now = TODAY_0700 + 2 * HOUR;
    const signal = signalFor(glucose([{ value: 120, at: TODAY_0700 }]), now);
    expect(signal?.basis).toBe("sameHours");
    expect(signal?.latest).toBe(120);
    expect(signal?.deltaVs30).toBeCloseTo(30, 0);
    expect(signal?.outsideNormalSwing).toBe(true);
  });

  it("hands the briefing grounding check the figures it states", () => {
    const now = TODAY_0700 + 2 * HOUR;
    const signal = signalFor(glucose([{ value: 120, at: TODAY_0700 }]), now)!;
    const briefing = {
      paragraph: `Glucose so far today is ${signal.latest}, ${signal.deltaVs30} above the ${signal.avg30} you usually sit at by this time of day.`,
    };
    expect(findUngroundedBriefingNumbers(briefing, [signal])).toEqual([]);
    // The whole-day mean the old comparison stated is no longer a figure.
    expect(
      findUngroundedBriefingNumbers({ paragraph: "against 127.4" }, [signal]),
    ).toHaveLength(1);
  });

  it("cuts the earlier days at the time of today's latest reading", () => {
    // Today: fasting and lunch so far, read in the afternoon. Earlier days
    // count their fasting and lunch readings, not their dinner.
    const now = TODAY_0700 + 8 * HOUR; // 15:00 local
    const signal = signalFor(
      glucose([
        { value: 90, at: TODAY_0700 },
        { value: 140, at: TODAY_0700 + 6 * HOUR },
      ]),
      now,
    );
    expect(signal?.latest).toBe(115);
    expect(signal?.avg30).toBeCloseTo(115, 0);
    expect(signal?.outsideNormalSwing).toBe(false);
  });

  it("gives no signal without a week of earlier days in the same hours", () => {
    const rows = glucose([{ value: 91, at: TODAY_0700 }]).filter(
      (r) => r.measuredAt.getTime() >= TODAY_0700 - 5 * DAY,
    );
    expect(signalFor(rows, TODAY_0700 + 2 * HOUR)).toBeUndefined();
  });

  it("leaves pulse on the reading-against-window comparison", () => {
    const pulse: Array<{ value: number; measuredAt: Date }> = [];
    for (let d = 20; d >= 1; d -= 1) {
      pulse.push({ value: 64, measuredAt: new Date(TODAY_0700 - d * DAY) });
    }
    pulse.push({ value: 70, measuredAt: new Date(TODAY_0700) });
    const [signal] = computeSignalsOfDay(
      (type) => (type === "PULSE" ? pulse : []),
      TODAY_0700 + 2 * HOUR,
      TZ,
    );
    expect(signal?.metric).toBe("pulse");
    expect(signal?.basis).toBeUndefined();
    expect(signal?.latest).toBe(70);
  });
});
