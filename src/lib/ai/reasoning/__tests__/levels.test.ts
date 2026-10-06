import { describe, expect, it } from "vitest";

import {
  BACKGROUND_REASONING_JOBS,
  BACKGROUND_REASONING_LEVEL,
  DEFAULT_REASONING_LEVEL,
  DEFAULT_REASONING_MAX_EFFORT,
  REASONING_LEVELS,
  REASONING_MAX_EFFORTS,
  REASONING_THINKING_BUDGET,
  capReasoningLevel,
  isReasoningLevel,
} from "../levels";

describe("reasoning levels", () => {
  it("defaults to medium for a person and to no cap for an instance", () => {
    expect(DEFAULT_REASONING_LEVEL).toBe("medium");
    expect(DEFAULT_REASONING_MAX_EFFORT).toBe("high");
    expect(REASONING_MAX_EFFORTS).toEqual(
      REASONING_LEVELS.filter((level) => level !== "off"),
    );
  });

  it("recognises exactly the four levels", () => {
    for (const level of REASONING_LEVELS) {
      expect(isReasoningLevel(level)).toBe(true);
    }
    for (const other of ["none", "minimal", "xhigh", "", null, 2]) {
      expect(isReasoningLevel(other)).toBe(false);
    }
  });

  it("caps a level at the operator's maximum and never raises one", () => {
    expect(capReasoningLevel("high", "medium")).toBe("medium");
    expect(capReasoningLevel("high", "low")).toBe("low");
    expect(capReasoningLevel("medium", "high")).toBe("medium");
    expect(capReasoningLevel("low", "medium")).toBe("low");
    expect(capReasoningLevel("off", "low")).toBe("off");
  });

  it("gives every level above off a growing thinking budget of at least 1024", () => {
    const budgets = REASONING_LEVELS.filter((level) => level !== "off").map(
      (level) => REASONING_THINKING_BUDGET[level as "low"],
    );
    expect(budgets[0]).toBeGreaterThanOrEqual(1_024);
    expect([...budgets].sort((a, b) => a - b)).toEqual(budgets);
  });

  it("has a level for every background job, operator-paid never above its own", () => {
    expect(Object.keys(BACKGROUND_REASONING_LEVEL).sort()).toEqual(
      [...BACKGROUND_REASONING_JOBS].sort(),
    );
    for (const job of BACKGROUND_REASONING_JOBS) {
      const { level, operatorLevel } = BACKGROUND_REASONING_LEVEL[job];
      expect(level).not.toBe("off");
      expect(REASONING_LEVELS.indexOf(operatorLevel)).toBeLessThanOrEqual(
        REASONING_LEVELS.indexOf(level),
      );
    }
  });
});
