/**
 * The reference window a document states, at the two points it enters: the
 * model's extraction and a person's edit on the review screen.
 *
 * The two answer a transposed pair differently on purpose. Extraction cannot
 * reject — every field in that schema is `.catch()`ed so one bad value does
 * not sink a long document — so it drops the pair and keeps the verbatim
 * string. An edit is a person looking at both numbers, so it refuses and says
 * why, exactly as the three lab schemas do.
 */
import { describe, expect, it } from "vitest";

import { inboundFactEditSchema } from "@/lib/validations/inbound-documents";
import { extractedFactRawSchema } from "@/lib/validations/inbound-extraction";

const baseRaw = {
  type: "OBSERVATION" as const,
  label: "Ferritin",
  code: null,
  codeSystem: null,
  clinicalStatus: null,
  verificationStatus: null,
  value: 150,
  valueText: null,
  unit: "ng/mL",
  referenceText: null,
  dose: null,
  medicationStatus: null,
  effectiveDate: "2026-07-01",
  sourceText: "Ferritin 150 ng/mL",
  page: 0,
  confidence: 0.9,
};

const baseEdit = {
  factType: "OBSERVATION" as const,
  label: "Ferritin",
  value: 150,
  unit: "ng/mL",
};

describe("a stated reference window, on the way in", () => {
  it("keeps an ordered pair as stated", () => {
    const parsed = extractedFactRawSchema.parse({
      ...baseRaw,
      referenceLow: 30,
      referenceHigh: 100,
    });
    expect(parsed.referenceLow).toBe(30);
    expect(parsed.referenceHigh).toBe(100);
  });

  it("drops a transposed pair rather than swapping it", () => {
    const parsed = extractedFactRawSchema.parse({
      ...baseRaw,
      referenceLow: 100,
      referenceHigh: 30,
      referenceText: "30 - 100",
    });
    expect(parsed.referenceLow).toBeNull();
    expect(parsed.referenceHigh).toBeNull();
    // What the report printed still survives for a person to read.
    expect(parsed.referenceText).toBe("30 - 100");
    // And the reading itself is untouched — the window is the only casualty.
    expect(parsed.value).toBe(150);
  });

  it("leaves a one-sided window alone", () => {
    const floorOnly = extractedFactRawSchema.parse({
      ...baseRaw,
      referenceLow: 30,
      referenceHigh: null,
    });
    expect(floorOnly.referenceLow).toBe(30);
    const ceilingOnly = extractedFactRawSchema.parse({
      ...baseRaw,
      referenceLow: null,
      referenceHigh: 100,
    });
    expect(ceilingOnly.referenceHigh).toBe(100);
  });

  it("treats an equal pair as a real window", () => {
    const parsed = extractedFactRawSchema.parse({
      ...baseRaw,
      referenceLow: 30,
      referenceHigh: 30,
    });
    expect(parsed.referenceLow).toBe(30);
    expect(parsed.referenceHigh).toBe(30);
  });

  it("refuses a transposed pair from the review screen", () => {
    const result = inboundFactEditSchema.safeParse({
      ...baseEdit,
      referenceLow: 100,
      referenceHigh: 30,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(
      "referenceLow must not exceed referenceHigh",
    );
  });

  it("accepts an ordered edit", () => {
    const result = inboundFactEditSchema.safeParse({
      ...baseEdit,
      referenceLow: 30,
      referenceHigh: 100,
    });
    expect(result.success).toBe(true);
  });
});
