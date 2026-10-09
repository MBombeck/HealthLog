/**
 * v1.42 (#615) — the dashboard environment chip stays quiet: no flag, no
 * chip; an unfetched air-quality part raises no air or pollen flag.
 */
import { describe, expect, it } from "vitest";

import { environmentChipFlags } from "../environment-chip";

const POLLEN = {
  alder: 0,
  birch: 0,
  grass: 0,
  mugwort: 0,
  olive: 0,
  ragweed: 0,
};

describe("environmentChipFlags", () => {
  it("raises nothing on an ordinary day", () => {
    expect(
      environmentChipFlags({
        date: "2026-10-07",
        tempMin: 9,
        airQuality: { eaqiMax: 35, pollen: POLLEN },
      }),
    ).toEqual([]);
  });

  it("names the high pollen kinds, the warm night and the very poor air", () => {
    expect(
      environmentChipFlags({
        date: "2026-07-20",
        tempMin: 21,
        airQuality: { eaqiMax: 84, pollen: { ...POLLEN, grass: 70 } },
      }),
    ).toEqual([
      { kind: "pollen", kinds: ["grass"] },
      { kind: "hotNight" },
      { kind: "veryPoorAir" },
    ]);
  });

  it("raises no air flag for a day whose air quality was not fetched", () => {
    expect(
      environmentChipFlags({
        date: "2026-07-20",
        tempMin: 10,
        airQuality: null,
      }),
    ).toEqual([]);
  });
});
