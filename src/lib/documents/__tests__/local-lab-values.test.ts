import { describe, expect, it } from "vitest";

import { INBOUND_MAX_FACTS } from "@/lib/validations/inbound-documents";

import { LOCAL_PARSER_PROVIDER } from "../inbound-constants";
import { labValuesFromText } from "../local-lab-values";

/**
 * The model-free read in the shape the AI extraction stages: OBSERVATION
 * facts with their provenance anchored in the document's own text, so both
 * reach the same review and the same commit. Synthetic values only.
 */
const REPORT = `Probeneingang: 03.11.2026
Natrium   141   mmol/l   135 - 145
Kreatinin   1,08   mg/dl   0,70 - 1,20
Thrombozyten   245   Tsd/pl   150 - 400`;

describe("labValuesFromText", () => {
  it("stages OBSERVATION facts the review and the commit already know", () => {
    const result = labValuesFromText(REPORT, { ocr: true });
    expect(result.providerType).toBe(LOCAL_PARSER_PROVIDER);
    expect(result.reportDate).toBe("2026-11-03");
    expect(result.incomplete).toBe(false);
    expect(result.facts).toHaveLength(3);
    const [sodium] = result.facts;
    expect(sodium).toMatchObject({
      factType: "OBSERVATION",
      needsReview: false,
      data: {
        label: "Natrium",
        code: null,
        codeSystem: null,
        value: 141,
        valueText: null,
        unit: "mmol/l",
        referenceText: "135 - 145",
        referenceLow: 135,
        referenceHigh: 145,
        effectiveDate: null,
      },
    });
  });

  it("anchors every fact to the line it came from", () => {
    const result = labValuesFromText(REPORT, { ocr: false });
    for (const fact of result.facts) {
      const { sourceText, sourceOffset, anchored } = fact.provenance;
      expect(anchored).toBe(true);
      expect(
        REPORT.slice(sourceOffset!, sourceOffset! + sourceText.length),
      ).toBe(sourceText);
    }
  });

  it("sends a repaired unit to review", () => {
    const platelets = labValuesFromText(REPORT, { ocr: true }).facts[2];
    expect(platelets.data).toMatchObject({ unit: "Tsd/µl" });
    expect(platelets.needsReview).toBe(true);
  });

  it("says when the report holds more rows than one review takes", () => {
    const text = Array.from(
      { length: INBOUND_MAX_FACTS + 5 },
      (_, i) =>
        `Wert${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${i} ${i + 1} mg/dl 1 - 500`,
    ).join("\n");
    const result = labValuesFromText(text, { ocr: false });
    expect(result.facts).toHaveLength(INBOUND_MAX_FACTS);
    expect(result.incomplete).toBe(true);
  });

  it("stages nothing from text that holds no table", () => {
    const result = labValuesFromText(
      "Sehr geehrte Kollegin, anbei der Befund.",
      {
        ocr: false,
      },
    );
    expect(result.facts).toEqual([]);
  });
});
