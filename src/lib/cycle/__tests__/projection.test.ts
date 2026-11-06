/**
 * #1350 — the multi-cycle projection: widening, self-capping, honest about
 * a late period, and the engine's own forecast as its first row.
 */
import { describe, expect, it } from "vitest";

import { addDays, dayDiff } from "../day-math";
import { predictCycle } from "../prediction";
import {
  PROJECTION_BAND_CAP_DAYS,
  PROJECTION_MAX_HORIZON,
  projectCycles,
  type ProjectionInput,
} from "../projection";
import type {
  CycleInput,
  CycleProfileInput,
  CycleTrackingGoal,
  DayLogInput,
} from "../types";

/** Cycles whose consecutive starts are `lengths` apart, the last one open. */
function cyclesFrom(first: string, lengths: number[]): CycleInput[] {
  const starts = [first];
  for (const L of lengths) starts.push(addDays(starts.at(-1)!, L));
  return starts.map((startDate, i) => ({
    startDate,
    endDate: starts[i + 1] ?? null,
    periodEndDate: addDays(startDate, 4),
    ovulationDate: null,
    ovulationConfirmed: false,
  }));
}

/** A flow or "dry" log every day from `from` through `to`: dense logging. */
function denseLogs(from: string, to: string): DayLogInput[] {
  const out: DayLogInput[] = [];
  for (let d = from; dayDiff(to, d) >= 0; d = addDays(d, 1)) {
    out.push({
      date: d,
      flow: "NONE",
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: null,
    });
  }
  return out;
}

function profile(
  goal: CycleTrackingGoal = "GENERAL_HEALTH",
): CycleProfileInput {
  return {
    goal,
    typicalCycleLength: null,
    typicalPeriodLength: null,
    lutealPhaseLength: null,
    predictionEnabled: true,
    rawChartMode: false,
  };
}

function run(
  cycles: CycleInput[],
  today: string,
  options: {
    dayLogs?: DayLogInput[];
    goal?: CycleTrackingGoal;
    horizon?: number;
  } = {},
) {
  const dayLogs = options.dayLogs ?? [];
  const goal = options.goal ?? "GENERAL_HEALTH";
  const input: ProjectionInput = {
    prediction: predictCycle(cycles, dayLogs, profile(goal), today),
    cycles,
    dayLogs,
    goal,
    today,
    horizon: options.horizon ?? PROJECTION_MAX_HORIZON,
  };
  return { input, out: projectCycles(input) };
}

const REGULAR = Array.from({ length: 12 }, () => 28);

describe("projectCycles", () => {
  it("is OFF with no forecast and nothing projected", () => {
    const cycles = cyclesFrom("2026-01-01", REGULAR);
    expect(
      projectCycles({
        prediction: null,
        cycles,
        dayLogs: [],
        goal: "GENERAL_HEALTH",
        today: "2026-11-06",
        horizon: 3,
      }),
    ).toEqual({ state: "OFF", cycles: [] });
  });

  it("projects nothing for a record with no logged cycle", () => {
    // The engine would anchor a population prior on today; that is not
    // this record's forecast.
    const { out } = run([], "2026-11-06");
    expect(out).toEqual({ state: "LEARNING", cycles: [] });
  });

  it("gives the next period only while still learning", () => {
    const cycles = cyclesFrom("2026-09-01", [28, 28]);
    const last = cycles.at(-1)!.startDate;
    const { input, out } = run(cycles, addDays(last, 5));
    expect(out.state).toBe("LEARNING");
    expect(out.cycles).toHaveLength(1);
    expect(out.cycles[0].start).toBe(input.prediction!.nextPeriodStart);
  });

  it("gives the next period only for PERIMENOPAUSE", () => {
    const cycles = cyclesFrom("2025-11-01", REGULAR);
    const last = cycles.at(-1)!.startDate;
    const { out } = run(cycles, addDays(last, 5), { goal: "PERIMENOPAUSE" });
    expect(out.state).toBe("OK");
    expect(out.cycles).toHaveLength(1);
  });

  it("projects nothing once the next period's band has passed (the late rule)", () => {
    const cycles = cyclesFrom("2025-11-01", REGULAR);
    const last = cycles.at(-1)!.startDate;
    const { input } = run(cycles, addDays(last, 5));
    const bandEnd = input.prediction!.nextPeriodStartHigh;

    // On the band's last day the forecast still stands...
    expect(run(cycles, bandEnd).out.state).toBe("OK");
    // ...and the day after, it is withdrawn rather than re-anchored.
    expect(run(cycles, addDays(bandEnd, 1)).out).toEqual({
      state: "LATE",
      cycles: [],
    });
  });

  it("uses the engine's forecast, unchanged, as cycle 1", () => {
    const cycles = cyclesFrom("2025-11-01", REGULAR);
    const last = cycles.at(-1)!.startDate;
    const { input, out } = run(cycles, addDays(last, 5));
    const p = input.prediction!;
    expect(out.cycles[0]).toEqual({
      k: 1,
      start: p.nextPeriodStart,
      periodLength: p.predictedPeriodLength,
      bandStart: p.nextPeriodStartLow,
      bandEnd: p.nextPeriodStartHigh,
    });
  });

  it("widens the band strictly from one cycle to the next", () => {
    const cycles = cyclesFrom("2025-11-01", REGULAR);
    const last = cycles.at(-1)!.startDate;
    const today = addDays(last, 10);
    const { out } = run(cycles, today, {
      dayLogs: denseLogs(last, today),
    });
    expect(out.cycles.length).toBeGreaterThan(2);
    const bands = out.cycles.map((c) => dayDiff(c.bandEnd, c.start));
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]).toBeGreaterThan(bands[i - 1]);
    }
  });

  it("stays monotonic for n = 12 with the sparsity penalty at its maximum", () => {
    // No day logs at all: logSparsity = 0.5. Without the engine's penalty on
    // the later bands, cycle 2 could come out no wider than cycle 1.
    const cycles = cyclesFrom("2025-11-01", REGULAR);
    const last = cycles.at(-1)!.startDate;
    const { out } = run(cycles, addDays(last, 10));
    const bands = out.cycles.map((c) => dayDiff(c.bandEnd, c.start));
    expect(bands.length).toBeGreaterThan(1);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]).toBeGreaterThan(bands[i - 1]);
    }
  });

  it("anchors every later start on cycle 1 with no accumulated rounding drift", () => {
    // A median of 28.5: rounding each cycle to 29 would drift two days by
    // cycle 6; rounding (k − 1) · 28.5 from the anchor does not.
    const lengths = [28, 29, 28, 29, 28, 29, 28, 29, 28, 29, 28, 29];
    const cycles = cyclesFrom("2025-11-01", lengths);
    const last = cycles.at(-1)!.startDate;
    const today = addDays(last, 10);
    const { out } = run(cycles, today, {
      dayLogs: denseLogs(last, today),
      horizon: 6,
    });
    const first = out.cycles[0].start;
    for (const c of out.cycles.slice(1)) {
      expect(c.start).toBe(addDays(first, Math.round((c.k - 1) * 28.5)));
    }
    expect(out.cycles.length).toBeGreaterThan(1);
  });

  it("stops at ±10 days, however many cycles were asked for", () => {
    // Irregular: a robust SD of several days, so the band passes the cap
    // within a few cycles.
    const lengths = [24, 31, 27, 34, 25, 30, 33, 26, 29, 35, 24, 31];
    const cycles = cyclesFrom("2025-10-01", lengths);
    const last = cycles.at(-1)!.startDate;
    const { out } = run(cycles, addDays(last, 3), { horizon: 6 });
    expect(out.cycles.length).toBeLessThan(6);
    for (const c of out.cycles.slice(1)) {
      expect(dayDiff(c.bandEnd, c.start)).toBeLessThanOrEqual(
        PROJECTION_BAND_CAP_DAYS,
      );
    }
  });

  it("stops at half a cycle for short cycles", () => {
    // 21-day cycles: the cap is 10.5, and each later band must sit within it.
    const lengths = [20, 22, 21, 23, 19, 21, 22, 20, 21, 23, 20, 22];
    const cycles = cyclesFrom("2026-01-01", lengths);
    const last = cycles.at(-1)!.startDate;
    const { out } = run(cycles, addDays(last, 3), { horizon: 6 });
    for (const c of out.cycles.slice(1)) {
      expect(dayDiff(c.bandEnd, c.start)).toBeLessThanOrEqual(21 / 2);
    }
  });

  it("is not clamped at the engine's 14 days for later cycles", () => {
    // The engine clamps cycle 1 at ±14. The projection has no such clamp for
    // k ≥ 2; it has the cap, which sits below it. A band the cap admits is
    // therefore the formula's own value, never a clamp's.
    const cycles = cyclesFrom("2025-11-01", REGULAR);
    const last = cycles.at(-1)!.startDate;
    const { out } = run(cycles, addDays(last, 10), { horizon: 6 });
    for (const c of out.cycles.slice(1)) {
      expect(dayDiff(c.bandEnd, c.start)).toBeLessThan(14);
    }
  });

  it("honours the requested horizon and clamps it to 1..6", () => {
    const cycles = cyclesFrom("2025-11-01", REGULAR);
    const last = cycles.at(-1)!.startDate;
    const today = addDays(last, 10);
    const dayLogs = denseLogs(last, today);
    expect(run(cycles, today, { dayLogs, horizon: 2 }).out.cycles).toHaveLength(
      2,
    );
    expect(run(cycles, today, { dayLogs, horizon: 0 }).out.cycles).toHaveLength(
      1,
    );
    expect(
      run(cycles, today, { dayLogs, horizon: 99 }).out.cycles.length,
    ).toBeLessThanOrEqual(PROJECTION_MAX_HORIZON);
  });

  it("carries the predicted period length on every row", () => {
    const cycles = cyclesFrom("2025-11-01", REGULAR);
    const last = cycles.at(-1)!.startDate;
    const { input, out } = run(cycles, addDays(last, 10));
    for (const c of out.cycles) {
      expect(c.periodLength).toBe(input.prediction!.predictedPeriodLength);
    }
  });
});
