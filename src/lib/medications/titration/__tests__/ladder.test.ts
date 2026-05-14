/**
 * v1.4.25 W19f — pure titration-ladder helper tests.
 *
 * Pins the contract the API route and the detail-page section read:
 *   - every EMA-approved drug exposes a non-empty, strictly ascending
 *     ladder;
 *   - `findCurrentStep` snaps within a ±10 % tolerance and returns
 *     null outside that window;
 *   - `nextStep` returns null at the ladder ceiling;
 *   - `weeksOnCurrentStep` is 0 with no matching dose-change rows;
 *   - `escalationDue` toggles at the EMA-reference dwell-time
 *     boundary (and never fires past the ceiling).
 */

import { describe, expect, it } from "vitest";
import {
  escalationDue,
  findCurrentStep,
  getLadder,
  ladderFromRecord,
  nextStep,
  weeksOnCurrentStep,
  type DoseChangeLike,
} from "../ladder";
import {
  GLP1_DRUG_IDS,
  GLP1_DRUGS,
  type Glp1DrugId,
} from "@/lib/medications/glp1-knowledge";

function d(iso: string): Date {
  return new Date(iso);
}

describe("getLadder / ladderFromRecord", () => {
  it("returns a non-empty ladder for every EMA-approved drug", () => {
    for (const id of GLP1_DRUG_IDS) {
      const ladder = getLadder(id);
      expect(ladder.length).toBeGreaterThan(0);
    }
  });

  it("produces strictly ascending doses with sequential indices", () => {
    for (const id of GLP1_DRUG_IDS) {
      const ladder = getLadder(id);
      for (let i = 0; i < ladder.length; i++) {
        expect(ladder[i].stepIndex).toBe(i);
        if (i > 0) {
          expect(ladder[i].doseMg).toBeGreaterThan(ladder[i - 1].doseMg);
        }
      }
    }
  });

  it("carries the EMA-reference dwell time on every step", () => {
    for (const id of GLP1_DRUG_IDS) {
      const expected = GLP1_DRUGS[id].titrationIntervalWeeks;
      const ladder = getLadder(id);
      for (const step of ladder) {
        expect(step.typicalWeeks).toBe(expected);
      }
    }
  });

  it("accepts the record-direct overload", () => {
    const ladderById = getLadder("tirzepatide");
    const ladderByRecord = ladderFromRecord(GLP1_DRUGS.tirzepatide);
    expect(ladderByRecord).toEqual(ladderById);
  });
});

describe("findCurrentStep", () => {
  it("returns null when the latest dose is null or non-finite", () => {
    expect(findCurrentStep("tirzepatide", null)).toBeNull();
    expect(findCurrentStep("tirzepatide", Number.NaN)).toBeNull();
    expect(findCurrentStep("tirzepatide", 0)).toBeNull();
  });

  it("matches an exact dose on the ladder", () => {
    // Tirzepatide ladder: 2.5, 5, 7.5, 10, 12.5, 15
    expect(findCurrentStep("tirzepatide", 5)?.doseMg).toBe(5);
    expect(findCurrentStep("tirzepatide", 15)?.stepIndex).toBe(5);
  });

  it("snaps within the ±10 % tolerance window", () => {
    // 5 mg ± 10 % = [4.5, 5.5]; 4.7 should round to step 5 mg.
    expect(findCurrentStep("tirzepatide", 4.7)?.doseMg).toBe(5);
    expect(findCurrentStep("tirzepatide", 5.4)?.doseMg).toBe(5);
  });

  it("returns null outside the tolerance window", () => {
    // 6 mg is > 5 mg + 10 % AND < 7.5 mg − 10 % → unmatched.
    expect(findCurrentStep("tirzepatide", 6.0)).toBeNull();
    // 3 mg also outside any step (2.5 + 10 % = 2.75; 5 − 10 % = 4.5).
    expect(findCurrentStep("tirzepatide", 3.5)).toBeNull();
  });

  it("works for semaglutide (smallest dose step on the catalog)", () => {
    expect(findCurrentStep("semaglutide", 0.25)?.doseMg).toBe(0.25);
    expect(findCurrentStep("semaglutide", 1.0)?.stepIndex).toBe(2);
  });
});

describe("nextStep", () => {
  it("returns the immediate-next step from the bottom of the ladder", () => {
    const current = findCurrentStep("tirzepatide", 2.5);
    expect(nextStep("tirzepatide", current)?.doseMg).toBe(5);
  });

  it("returns null at the ladder ceiling", () => {
    const top = findCurrentStep("tirzepatide", 15);
    expect(top?.doseMg).toBe(15);
    expect(nextStep("tirzepatide", top)).toBeNull();
  });

  it("returns null when given a null current step", () => {
    expect(nextStep("tirzepatide", null)).toBeNull();
  });
});

describe("weeksOnCurrentStep", () => {
  const ASOF = d("2026-05-14T00:00:00.000Z");

  it("returns 0 with no dose-change history", () => {
    const current = findCurrentStep("tirzepatide", 5);
    expect(weeksOnCurrentStep("tirzepatide", current, [], ASOF)).toBe(0);
  });

  it("returns 0 when current step is null", () => {
    expect(weeksOnCurrentStep("tirzepatide", null, [], ASOF)).toBe(0);
  });

  it("returns the elapsed whole-weeks since the latest matching change", () => {
    const current = findCurrentStep("tirzepatide", 5);
    const events: DoseChangeLike[] = [
      // Switched onto 5 mg six weeks ago.
      { effectiveFrom: d("2026-04-02T00:00:00.000Z"), doseValue: 5 },
    ];
    expect(weeksOnCurrentStep("tirzepatide", current, events, ASOF)).toBe(6);
  });

  it("ignores dose-change rows for other steps", () => {
    const current = findCurrentStep("tirzepatide", 5);
    const events: DoseChangeLike[] = [
      // A 2.5 mg row from 12 weeks ago should not count.
      { effectiveFrom: d("2026-02-19T00:00:00.000Z"), doseValue: 2.5 },
      // A 5 mg row from 2 weeks ago — this is the latest matching row.
      { effectiveFrom: d("2026-04-30T00:00:00.000Z"), doseValue: 5 },
    ];
    expect(weeksOnCurrentStep("tirzepatide", current, events, ASOF)).toBe(2);
  });

  it("returns 0 when the only matching change is in the future", () => {
    const current = findCurrentStep("tirzepatide", 5);
    const events: DoseChangeLike[] = [
      { effectiveFrom: d("2027-01-01T00:00:00.000Z"), doseValue: 5 },
    ];
    expect(weeksOnCurrentStep("tirzepatide", current, events, ASOF)).toBe(0);
  });
});

describe("escalationDue", () => {
  const TIRZEPATIDE_DWELL = GLP1_DRUGS.tirzepatide.titrationIntervalWeeks;

  it("returns false when current step is null", () => {
    expect(escalationDue("tirzepatide", null, 99)).toBe(false);
  });

  it("returns false below the dwell-time boundary", () => {
    const current = findCurrentStep("tirzepatide", 5);
    expect(
      escalationDue("tirzepatide", current, TIRZEPATIDE_DWELL - 1),
    ).toBe(false);
  });

  it("toggles true at the dwell-time boundary", () => {
    const current = findCurrentStep("tirzepatide", 5);
    expect(escalationDue("tirzepatide", current, TIRZEPATIDE_DWELL)).toBe(
      true,
    );
  });

  it("never fires past the ladder ceiling", () => {
    const top = findCurrentStep("tirzepatide", 15);
    expect(escalationDue("tirzepatide", top, 999)).toBe(false);
  });
});

describe("catalog coverage", () => {
  it("exposes a ladder for every drug id in the catalog", () => {
    const ids: Glp1DrugId[] = [...GLP1_DRUG_IDS];
    expect(ids.length).toBe(5);
    for (const id of ids) {
      const ladder = getLadder(id);
      expect(ladder.length).toBeGreaterThan(0);
    }
  });
});
