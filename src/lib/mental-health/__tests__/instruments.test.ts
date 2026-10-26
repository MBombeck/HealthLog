import { describe, it, expect } from "vitest";

import {
  INSTRUMENTS,
  INSTRUMENT_MEASUREMENT_TYPE,
  isSafetyFlagged,
  needsFollowUp,
  scoreTotal,
  severityBand,
} from "../instruments";

/**
 * v1.25.0 — pin the highest-consequence numbers in the release: the PHQ-9 /
 * GAD-7 totals, the validated severity-band edges (5 / 10 / 15 / 20 and
 * 5 / 10 / 15), the ≥10 action threshold, and the item-9 ANY-non-zero safety
 * flag. A future off-by-one on any band edge or the safety predicate must fail
 * here. Ground truth: Kroenke 2001 (PHQ-9) / Spitzer 2006 (GAD-7).
 *
 * v1.27.9 — the WHO-5 / SCI pins join. Ground truth: the official WHO
 * publication WHO/UCN/MSD/MHE/2024.1 ("raw score … zero to 25 … multiplied by
 * four" → 0–100; "a percentage score below 50 … an indication for further
 * assessment") and Espie et al., BMJ Open 2014;4:e004183 ("total score ranges
 * from 0 to 32, with higher values indicative of better sleep"; "an SCI
 * cut-off ≤16 … 'probable insomnia disorder'").
 */
describe("mental-health instruments", () => {
  describe("scoreTotal", () => {
    it("sums the item answers for PHQ-9 / GAD-7 (multiplier 1)", () => {
      expect(scoreTotal("PHQ9", [0, 1, 2, 3, 0, 1, 2, 3, 1])).toBe(13);
      expect(scoreTotal("GAD7", [0, 0, 0, 0, 0, 0, 0])).toBe(0);
    });

    it("returns the max when every item is 3", () => {
      expect(scoreTotal("PHQ9", Array(9).fill(3))).toBe(27); // PHQ-9 max
      expect(scoreTotal("GAD7", Array(7).fill(3))).toBe(21); // GAD-7 max
    });

    it("WHO-5 reports raw-sum × 4 (the official 0–100 percentage)", () => {
      // WHO scoring page: raw 0–25, "multiplied by four" → 0–100.
      expect(scoreTotal("WHO5", [0, 0, 0, 0, 0])).toBe(0);
      expect(scoreTotal("WHO5", [5, 5, 5, 5, 5])).toBe(100);
      expect(scoreTotal("WHO5", [3, 3, 3, 3, 3])).toBe(60);
      // Raw 12 (below the raw-13 cut) → 48 on the percentage scale.
      expect(scoreTotal("WHO5", [3, 3, 2, 2, 2])).toBe(48);
    });

    it("SCI sums to 0–32 (higher = better sleep)", () => {
      expect(scoreTotal("SCI", Array(8).fill(0))).toBe(0);
      expect(scoreTotal("SCI", Array(8).fill(4))).toBe(32);
      expect(scoreTotal("SCI", [4, 3, 2, 1, 0, 4, 1, 1])).toBe(16);
    });
  });

  describe("severityBand — PHQ-9 edges (0–4 / 5–9 / 10–14 / 15–19 / 20–27)", () => {
    const cases: Array<[number, string]> = [
      [0, "minimal"],
      [4, "minimal"],
      [5, "mild"],
      [9, "mild"],
      [10, "moderate"],
      [14, "moderate"],
      [15, "modSevere"],
      [19, "modSevere"],
      [20, "severe"],
      [27, "severe"],
    ];
    it.each(cases)("PHQ9 total %i → %s", (total, band) => {
      expect(severityBand("PHQ9", total)).toBe(band);
    });
  });

  describe("severityBand — GAD-7 edges (0–4 / 5–9 / 10–14 / 15–21)", () => {
    const cases: Array<[number, string]> = [
      [0, "minimal"],
      [4, "minimal"],
      [5, "mild"],
      [9, "mild"],
      [10, "moderate"],
      [14, "moderate"],
      [15, "severe"],
      [21, "severe"],
    ];
    it.each(cases)("GAD7 total %i → %s", (total, band) => {
      expect(severityBand("GAD7", total)).toBe(band);
    });
  });

  describe("severityBand — WHO-5 (below 50 = low; achievable totals are ×4)", () => {
    const cases: Array<[number, string]> = [
      [0, "low"],
      [48, "low"], // raw 12 — below the WHO raw-13 cut
      [52, "good"], // raw 13 — at/above the cut
      [100, "good"],
    ];
    it.each(cases)("WHO5 total %i → %s", (total, band) => {
      expect(severityBand("WHO5", total)).toBe(band);
    });
  });

  describe("severityBand — SCI (≤16 probable-insomnia range per Espie 2014)", () => {
    const cases: Array<[number, string]> = [
      [0, "belowThreshold"],
      [16, "belowThreshold"],
      [17, "aboveThreshold"],
      [32, "aboveThreshold"],
    ];
    it.each(cases)("SCI total %i → %s", (total, band) => {
      expect(severityBand("SCI", total)).toBe(band);
    });
  });

  describe("needsFollowUp — direction-aware thresholds", () => {
    it("PHQ-9 / GAD-7 point up (≥ 10)", () => {
      expect(needsFollowUp("PHQ9", 9)).toBe(false);
      expect(needsFollowUp("PHQ9", 10)).toBe(true);
      expect(needsFollowUp("GAD7", 9)).toBe(false);
      expect(needsFollowUp("GAD7", 10)).toBe(true);
    });

    it("WHO-5 points down (≤ 50 → gentle PHQ-9 pointer)", () => {
      expect(needsFollowUp("WHO5", 48)).toBe(true);
      expect(needsFollowUp("WHO5", 50)).toBe(true);
      expect(needsFollowUp("WHO5", 52)).toBe(false);
    });

    it("SCI points down (≤ 16)", () => {
      expect(needsFollowUp("SCI", 16)).toBe(true);
      expect(needsFollowUp("SCI", 17)).toBe(false);
    });
  });

  describe("isSafetyFlagged — PHQ-9 item 9 (index 8), ANY non-zero", () => {
    it("flags when item 9 = 1, 2, or 3 regardless of total", () => {
      for (const answer of [1, 2, 3]) {
        const items = [0, 0, 0, 0, 0, 0, 0, 0, answer];
        expect(isSafetyFlagged("PHQ9", items)).toBe(true);
      }
    });

    it("does not flag when item 9 = 0 even with a high total", () => {
      // Every other item maxed (24), item 9 = 0 → severe band, no flag.
      const items = [3, 3, 3, 3, 3, 3, 3, 3, 0];
      expect(severityBand("PHQ9", scoreTotal("PHQ9", items))).toBe("severe");
      expect(isSafetyFlagged("PHQ9", items)).toBe(false);
    });

    it("never flags the instruments without a safety item", () => {
      expect(isSafetyFlagged("GAD7", [3, 3, 3, 3, 3, 3, 3])).toBe(false);
      expect(isSafetyFlagged("WHO5", [0, 0, 0, 0, 0])).toBe(false);
      expect(isSafetyFlagged("SCI", [0, 0, 0, 0, 0, 0, 0, 0])).toBe(false);
      expect(INSTRUMENTS.GAD7.safetyItemIndex).toBeNull();
      expect(INSTRUMENTS.WHO5.safetyItemIndex).toBeNull();
      expect(INSTRUMENTS.SCI.safetyItemIndex).toBeNull();
    });
  });

  describe("registry shape — the config the surfaces drive from", () => {
    it("presents options in the source order (WHO-5 leads with 5, SCI with 4)", () => {
      expect(INSTRUMENTS.WHO5.optionOrder).toEqual([5, 4, 3, 2, 1, 0]);
      expect(INSTRUMENTS.SCI.optionOrder).toEqual([4, 3, 2, 1, 0]);
      expect(INSTRUMENTS.PHQ9.optionOrder).toEqual([0, 1, 2, 3]);
    });

    it("names the SCI's item-specific anchor groups, one per item", () => {
      // Items 1–2 duration, 3 nights, 4 quality, 5–7 impact, 8 problem duration.
      expect(INSTRUMENTS.SCI.optionGroups).toEqual([
        "duration",
        "duration",
        "nights",
        "quality",
        "impact",
        "impact",
        "impact",
        "problemDuration",
      ]);
      for (const id of ["PHQ9", "GAD7", "WHO5"] as const) {
        expect(INSTRUMENTS[id].optionGroups).toBeUndefined();
      }
    });

    it("maps every item to its form's stem (PHQ/GAD/WHO-5 one each; SCI three sections)", () => {
      expect(INSTRUMENTS.SCI.stemIds).toEqual([
        "night",
        "night",
        "night",
        "night",
        "impact",
        "impact",
        "impact",
        "finally",
      ]);
      for (const id of ["PHQ9", "GAD7", "WHO5"] as const) {
        expect(new Set(INSTRUMENTS[id].stemIds)).toEqual(new Set(["period"]));
      }
      for (const def of Object.values(INSTRUMENTS)) {
        expect(def.stemIds).toHaveLength(def.itemCount);
      }
    });

    it("projects each instrument onto its measurement type", () => {
      expect(INSTRUMENT_MEASUREMENT_TYPE.WHO5).toBe("WHO5_SCORE");
      expect(INSTRUMENT_MEASUREMENT_TYPE.SCI).toBe("SCI_SCORE");
    });

    it("every instrument carries a non-empty attribution line", () => {
      for (const def of Object.values(INSTRUMENTS)) {
        expect(def.attribution.length).toBeGreaterThan(20);
      }
      expect(INSTRUMENTS.WHO5.attribution).toContain("CC BY-NC-SA 3.0 IGO");
      expect(INSTRUMENTS.SCI.attribution).toContain("BMJ Open");
    });
  });
});
