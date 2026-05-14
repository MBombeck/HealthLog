import { describe, expect, it } from "vitest";

import {
  GLP1_DRUG_IDS,
  type Glp1DrugId,
} from "@/lib/medications/glp1-knowledge";
import {
  computeOneCompartment,
  RESEARCH_MODE_DISCLAIMER_VERSION,
  shotPhaseAt,
} from "@/lib/medications/glp1-pk";

const ASOF = new Date("2026-05-14T12:00:00Z");

function hoursBefore(ms: Date, hours: number): Date {
  return new Date(ms.getTime() - hours * 60 * 60 * 1000);
}

describe("RESEARCH_MODE_DISCLAIMER_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof RESEARCH_MODE_DISCLAIMER_VERSION).toBe("string");
    expect(RESEARCH_MODE_DISCLAIMER_VERSION.length).toBeGreaterThan(0);
  });

  it("matches the YYYY-MM-DD.N version stamp shape", () => {
    expect(RESEARCH_MODE_DISCLAIMER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});

describe("computeOneCompartment", () => {
  describe("per-drug smoke test", () => {
    // Iterate the catalog so the day a new EMA-approved drug
    // lands, this test fails loudly until the maintainer
    // verifies the curve still computes.
    for (const drug of GLP1_DRUG_IDS) {
      it(`${drug}: returns finite, non-negative samples for a single dose`, () => {
        const dose = drugTypicalDose(drug);
        const doses = [{ takenAt: hoursBefore(ASOF, 24), doseMg: dose }];
        const samples = computeOneCompartment(drug, doses, ASOF);

        expect(samples.length).toBeGreaterThan(0);
        for (const s of samples) {
          expect(Number.isFinite(s.tHours)).toBe(true);
          expect(Number.isFinite(s.concentration)).toBe(true);
          expect(Number.isNaN(s.concentration)).toBe(false);
          // Single-dose Bateman is non-negative for the entire
          // duration of the curve.
          expect(s.concentration).toBeGreaterThanOrEqual(0);
        }
      });
    }
  });

  it("returns zero before the first dose was administered", () => {
    // Dose 3 days in the *future*. Every sample with tHours < 3 d
    // must be zero — the math should never imply a dose that
    // hasn't been taken yet.
    const futureDose = {
      takenAt: new Date(ASOF.getTime() + 3 * 24 * 60 * 60 * 1000),
      doseMg: 5,
    };
    const samples = computeOneCompartment(
      "tirzepatide",
      [futureDose],
      ASOF,
      { windowHoursBefore: 48, windowHoursAfter: 48, stepHours: 6 },
    );
    // All samples in the requested ±48 h window are *before* the
    // 72 h-in-the-future dose, so they must all be 0.
    for (const s of samples) {
      expect(s.concentration).toBe(0);
    }
  });

  it("returns zero when the dose list is empty", () => {
    const samples = computeOneCompartment("semaglutide", [], ASOF, {
      windowHoursBefore: 24,
      windowHoursAfter: 24,
      stepHours: 6,
    });
    for (const s of samples) {
      expect(s.concentration).toBe(0);
    }
  });

  it("superimposes multiple doses linearly", () => {
    // Two identical doses 7 days apart. The contribution from
    // each is independent → the two-dose curve at any sample
    // point must equal the sum of the two one-dose curves at
    // the same sample point.
    const dose1 = { takenAt: hoursBefore(ASOF, 14 * 24), doseMg: 5 };
    const dose2 = { takenAt: hoursBefore(ASOF, 7 * 24), doseMg: 5 };

    const both = computeOneCompartment("tirzepatide", [dose1, dose2], ASOF);
    const onlyFirst = computeOneCompartment("tirzepatide", [dose1], ASOF);
    const onlySecond = computeOneCompartment("tirzepatide", [dose2], ASOF);

    expect(both).toHaveLength(onlyFirst.length);
    for (let i = 0; i < both.length; i++) {
      const expected =
        onlyFirst[i].concentration + onlySecond[i].concentration;
      // Tight tolerance — superposition is exact in the math; any
      // drift here is a numerical bug, not a model limitation.
      expect(both[i].concentration).toBeCloseTo(expected, 9);
    }
  });

  it("respects custom window + step overrides", () => {
    const dose = { takenAt: hoursBefore(ASOF, 24), doseMg: 2.5 };
    const samples = computeOneCompartment(
      "tirzepatide",
      [dose],
      ASOF,
      { windowHoursBefore: 24, windowHoursAfter: 12, stepHours: 6 },
    );
    // -24, -18, -12, -6, 0, 6, 12 → 7 samples
    expect(samples).toHaveLength(7);
    expect(samples[0].tHours).toBe(-24);
    expect(samples[samples.length - 1].tHours).toBe(12);
  });

  it("produces a sawtooth-shaped curve for weekly cadence", () => {
    // Four weekly tirzepatide doses; the curve should rise after
    // each dose and decay before the next — a hallmark sawtooth.
    const doses = Array.from({ length: 4 }, (_, i) => ({
      takenAt: hoursBefore(ASOF, (3 - i) * 7 * 24 + 24),
      doseMg: 5,
    }));
    const samples = computeOneCompartment("tirzepatide", doses, ASOF);
    // There must be at least one local maximum *and* one local
    // minimum strictly inside the sample series — proof the
    // curve is not monotonic.
    let localMax = 0;
    let localMin = 0;
    for (let i = 1; i < samples.length - 1; i++) {
      const c = samples[i].concentration;
      if (
        c > samples[i - 1].concentration &&
        c > samples[i + 1].concentration
      ) {
        localMax++;
      }
      if (
        c < samples[i - 1].concentration &&
        c < samples[i + 1].concentration
      ) {
        localMin++;
      }
    }
    expect(localMax).toBeGreaterThanOrEqual(1);
    expect(localMin).toBeGreaterThanOrEqual(1);
  });
});

describe("shotPhaseAt", () => {
  it("returns 'none' when no doses are logged", () => {
    expect(shotPhaseAt("tirzepatide", [], ASOF)).toBe("none");
  });

  it("classifies the moments after a fresh dose as 'rising'", () => {
    // Tirzepatide Tmax ≈ 24 h; sampling at 6 h post-dose is well
    // before the peak, so the curve must still be rising.
    const doses = [{ takenAt: hoursBefore(ASOF, 6), doseMg: 5 }];
    expect(shotPhaseAt("tirzepatide", doses, ASOF)).toBe("rising");
  });

  it("classifies the long tail of a single dose as 'fading'", () => {
    // 10 days post-dose with tirzepatide t½ ≈ 5 d → well past
    // peak, monotonically decaying.
    const doses = [{ takenAt: hoursBefore(ASOF, 10 * 24), doseMg: 5 }];
    expect(shotPhaseAt("tirzepatide", doses, ASOF)).toBe("fading");
  });
});

/**
 * The smoke-test loop needs a believable typical dose per drug.
 * These are the *standard maintenance* doses (not the highest in
 * the titration ladder) so the math runs on a plausible value
 * rather than the catalog's `maxDoseMg` ceiling.
 */
function drugTypicalDose(drug: Glp1DrugId): number {
  switch (drug) {
    case "tirzepatide":
      return 5;
    case "semaglutide":
      return 1;
    case "liraglutide":
      return 1.8;
    case "dulaglutide":
      return 1.5;
    case "exenatide":
      return 0.01;
  }
}
