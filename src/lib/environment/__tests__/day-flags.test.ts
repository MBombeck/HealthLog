/**
 * v1.42 (#615) — the notable-day flags the chips and the Coach summary share.
 * Null is "not covered" and never raises a flag; each mark is inclusive.
 */
import { describe, expect, it } from "vitest";

import {
  highPollenKinds,
  isHotNight,
  isVeryPoorAir,
  pollenMax,
} from "../day-flags";

const NONE = {
  alder: null,
  birch: null,
  grass: null,
  mugwort: null,
  olive: null,
  ragweed: null,
};

describe("day flags", () => {
  it("marks a tropical night at 20 °C and not below, and never for null", () => {
    expect(isHotNight(20)).toBe(true);
    expect(isHotNight(19.9)).toBe(false);
    expect(isHotNight(null)).toBe(false);
  });

  it("marks very poor air from the index's very-poor band", () => {
    expect(isVeryPoorAir(80)).toBe(true);
    expect(isVeryPoorAir(79)).toBe(false);
    expect(isVeryPoorAir(null)).toBe(false);
  });

  it("marks pollen per kind at its own high mark", () => {
    expect(highPollenKinds({ ...NONE, birch: 100, grass: 49 })).toEqual([
      "birch",
    ]);
    expect(highPollenKinds({ ...NONE, grass: 50, ragweed: 50 })).toEqual([
      "grass",
      "ragweed",
    ]);
    expect(highPollenKinds(NONE)).toEqual([]);
  });

  it("takes the pollen high over covered kinds only", () => {
    expect(pollenMax(NONE)).toBeNull();
    expect(pollenMax({ ...NONE, alder: 0 })).toBe(0);
    expect(pollenMax({ ...NONE, alder: 3, grass: 12 })).toBe(12);
  });
});
