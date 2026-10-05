import { describe, it, expect } from "vitest";

import {
  STEADY_READ_DAYS,
  steadyRun,
  type StoredScoreDay,
} from "@/lib/daily/score-steady";
import { addDays } from "@/lib/cycle/day-math";

const TODAY = "2026-10-04";

/** `n` consecutive days ending today, all at `composite`. */
function run(
  n: number,
  composite = 94,
  over: Partial<StoredScoreDay> = {},
): StoredScoreDay[] {
  return Array.from({ length: n }, (_, i) => ({
    dayKey: addDays(TODAY, -i),
    composite,
    band: "GREEN",
    scoreVersion: 4,
    composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    ...over,
  }));
}

/** The run's weeks against a ring showing `value` in the green band. */
function steadyWeeks(
  rows: StoredScoreDay[],
  today: string,
  value: number,
): number | null {
  return steadyRun(rows, today, { value, band: "GREEN" })?.weeks ?? null;
}

describe("steadyRun", () => {
  it("counts whole weeks of a held score", () => {
    expect(steadyWeeks(run(29), TODAY, 94)).toBe(4);
  });

  it("stays quiet below two weeks", () => {
    expect(steadyWeeks(run(13), TODAY, 94)).toBeNull();
    expect(steadyWeeks(run(15), TODAY, 94)).toBe(2);
  });

  it("tolerates two points of wobble, not three", () => {
    const rows = run(29).map((r, i) => ({
      ...r,
      composite: i % 2 === 0 ? 94 : 92,
    }));
    expect(steadyWeeks(rows, TODAY, 94)).toBe(4);
    const moved = run(29).map((r, i) =>
      i === 10 ? { ...r, composite: 90 } : r,
    );
    expect(steadyWeeks(moved, TODAY, 94)).toBeNull();
  });

  it("ends the run at a band change, a recipe change or a new algorithm", () => {
    const band = run(29).map((r, i) => (i >= 15 ? { ...r, band: "AMBER" } : r));
    expect(steadyWeeks(band, TODAY, 94)).toBe(2);
    const recipe = run(29).map((r, i) =>
      i >= 15 ? { ...r, composition: ["BLOOD_PRESSURE"] } : r,
    );
    expect(steadyWeeks(recipe, TODAY, 94)).toBe(2);
    const version = run(29).map((r, i) =>
      i >= 15 ? { ...r, scoreVersion: 3 } : r,
    );
    expect(steadyWeeks(version, TODAY, 94)).toBe(2);
  });

  it("does not bridge a gap longer than three days", () => {
    const rows = run(29).filter((_, i) => i < 15 || i > 19);
    expect(steadyWeeks(rows, TODAY, 94)).toBe(2);
    const short = run(29).filter((_, i) => i < 15 || i > 16);
    expect(steadyWeeks(short, TODAY, 94)).toBe(4);
  });

  it("says nothing when the record stopped before today", () => {
    const stale = run(40).filter((r) => r.dayKey <= addDays(TODAY, -5));
    expect(steadyWeeks(stale, TODAY, 94)).toBeNull();
  });

  it("says nothing when the ring shows a number the record does not", () => {
    expect(steadyWeeks(run(29), TODAY, 88)).toBeNull();
  });

  it("reads rows in any order", () => {
    expect(steadyWeeks(run(29).reverse(), TODAY, 94)).toBe(4);
    expect(steadyWeeks([], TODAY, 94)).toBeNull();
  });

  it("says nothing when the ring's band is not the record's", () => {
    // Same number, but the worst pillar pulled the live band down overnight:
    // the score did not hold where it is.
    expect(steadyRun(run(29), TODAY, { value: 94, band: "yellow" })).toBeNull();
    // Case is the enum's, not a difference.
    expect(steadyRun(run(29), TODAY, { value: 94, band: "green" })?.weeks).toBe(
      4,
    );
  });

  it("says nothing when the ring is computed another way than the record", () => {
    expect(
      steadyRun(run(29), TODAY, { value: 94, band: "GREEN", scoreVersion: 5 }),
    ).toBeNull();
    expect(
      steadyRun(run(29), TODAY, {
        value: 94,
        band: "GREEN",
        composition: ["BLOOD_PRESSURE"],
      }),
    ).toBeNull();
  });

  it("says at least, not since, when the run reaches past what was read", () => {
    const all = run(STEADY_READ_DAYS + 1);
    const out = steadyRun(all, TODAY, { value: 94, band: "GREEN" });
    expect(out).toEqual({
      weeks: Math.floor(STEADY_READ_DAYS / 7),
      atLeast: true,
    });
    // A run that ended inside the read has a start and says so.
    const ended = all.map((r, i) => (i >= 40 ? { ...r, composite: 80 } : r));
    expect(steadyRun(ended, TODAY, { value: 94, band: "GREEN" })).toEqual({
      weeks: 5,
      atLeast: false,
    });
  });
});
