/**
 * The arrival line's evidence names the health score's weakest pillar when
 * the score's own band leaves it unsaid: "79 (green)" alone over a red
 * blood pressure would hand the model an all-clear the data does not hold.
 */
import { describe, expect, it } from "vitest";

import { buildEvidence } from "@/lib/jobs/reaction-line-evidence";

const base = {
  topSignal: null,
  briefingLead: null,
};

describe("reaction-line evidence: the health score", () => {
  it("carries the pillar in a worse band beside the score", () => {
    const evidence = buildEvidence("- New: a walk.", {
      ...base,
      score: {
        value: 79,
        band: "green",
        delta: null,
        composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
        bandSetter: "BLOOD_PRESSURE",
        bandSetterBand: "red",
      },
    });
    expect(evidence).toContain(
      "Health score: 79 (green; the BLOOD_PRESSURE area is red)",
    );
  });

  it("says nothing extra without a setter", () => {
    const evidence = buildEvidence("- New: a walk.", {
      ...base,
      score: {
        value: 82,
        band: "green",
        delta: 2,
        composition: ["ACTIVITY", "SLEEP"],
        bandSetter: null,
        bandSetterBand: null,
      },
    });
    expect(evidence).toContain(
      "Health score: 82 (green), +2 vs their baseline.",
    );
  });
});
