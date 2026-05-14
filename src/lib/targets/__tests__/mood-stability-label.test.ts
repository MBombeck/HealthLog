import { describe, expect, it } from "vitest";

import { moodStabilityLabel } from "../mood-stability-label";

/**
 * v1.4.25 W3e — threshold contract for the verbal MOOD_STABILITY label.
 * The card switches from raw σ to one of three buckets; the rule lives
 * here so the boundaries can be unit-tested without React.
 */

describe("moodStabilityLabel", () => {
  it("returns 'stable' for σ below 1.0", () => {
    expect(moodStabilityLabel(0)).toBe("stable");
    expect(moodStabilityLabel(0.42)).toBe("stable");
    expect(moodStabilityLabel(0.999)).toBe("stable");
  });

  it("returns 'variable' for σ in [1.0, 2.0)", () => {
    expect(moodStabilityLabel(1.0)).toBe("variable");
    expect(moodStabilityLabel(1.5)).toBe("variable");
    expect(moodStabilityLabel(1.999)).toBe("variable");
  });

  it("returns 'highlyVariable' for σ ≥ 2.0", () => {
    expect(moodStabilityLabel(2.0)).toBe("highlyVariable");
    expect(moodStabilityLabel(3.5)).toBe("highlyVariable");
  });
});
