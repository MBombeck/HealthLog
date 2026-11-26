import { describe, expect, it } from "vitest";

import { progressIndices } from "../wizard-payload";
import {
  MEDICATION_PHASES,
  PHASE_LANDING_STEP,
  phaseForStep,
} from "../wizard-phases";

const PATHS = [
  progressIndices("oneShot", "daily"),
  progressIndices("asNeeded", "daily"),
  progressIndices("recurring", "daily"),
  progressIndices("recurring", "weekdays"),
];

/** Overall progress, phase plus fill, as one comparable number. */
function position(step: number): number {
  const { phase, fraction } = phaseForStep(step);
  return phase + fraction;
}

describe("medication wizard phases", () => {
  it("has four phases", () => {
    expect(MEDICATION_PHASES).toEqual([
      "medication",
      "dose",
      "schedule",
      "review",
    ]);
  });

  it("maps each raw step to its phase and fill", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(phaseForStep)).toEqual([
      { phase: 0, fraction: 0.5 },
      { phase: 0, fraction: 1 },
      { phase: 1, fraction: 1 },
      { phase: 2, fraction: 0.25 },
      { phase: 2, fraction: 0.5 },
      { phase: 2, fraction: 0.75 },
      { phase: 2, fraction: 1 },
      { phase: 3, fraction: 1 },
    ]);
  });

  it("only moves forward along every cadence path", () => {
    for (const path of PATHS) {
      for (let i = 1; i < path.length; i++) {
        expect(position(path[i])).toBeGreaterThan(position(path[i - 1]));
      }
    }
  });

  it("visits every phase on every path", () => {
    for (const path of PATHS) {
      const phases = new Set(path.map((s) => phaseForStep(s).phase));
      expect([...phases].sort()).toEqual([0, 1, 2, 3]);
    }
  });

  it("lands each phase tap on a step every path walks", () => {
    for (const path of PATHS) {
      for (const landing of PHASE_LANDING_STEP) {
        expect(path).toContain(landing);
      }
    }
    PHASE_LANDING_STEP.forEach((landing, index) => {
      expect(phaseForStep(landing).phase).toBe(index);
    });
  });
});
