import { describe, it, expect } from "vitest";

import { steadyWeeks, type StoredScoreDay } from "@/lib/daily/score-steady";
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

describe("steadyWeeks", () => {
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
});
