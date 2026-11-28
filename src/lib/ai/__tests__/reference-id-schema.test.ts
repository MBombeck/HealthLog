import { describe, it, expect } from "vitest";
import {
  aiInsightResponseSchema,
  aiRecommendationSchema,
  type AIInsightResponse,
} from "../schema";
import { MEDICAL_REFERENCES } from "../medical-references";

/**
 * v1.4.16 — `recommendation.referenceId` validation.
 *
 * The schema accepts optional `referenceId` strings, but only when
 * they point into the curated `MEDICAL_REFERENCES` bundle. A
 * fabricated id ("invented-guideline") MUST fail parse so the model
 * cannot synthesise a citation for a non-existent guideline.
 *
 * Optional-when-absent (the v1.4.16 baseline). A follow-up was to flip
 * the requirement to mandatory for severity >= "important".
 */

const knownRefId = MEDICAL_REFERENCES[0].id;

const baseMetricSource = {
  type: "bloodPressure",
  timeRange: "last7days",
  summary: "avg 138/86 across 9 readings",
};

const baseCitation = {
  type: "bloodPressure",
  timeRange: "last7days",
  summary: "avg 138/86 across 9 readings",
};

const baseRec = {
  id: "rec-1",
  text: "Discuss home BP log with your physician.",
  severity: "important" as const,
  metricSource: baseMetricSource,
  rationale: {
    dataWindow: "last7days" as const,
    comparedTo: "your 90-day median (122/78)",
    deviation: "+16/+8 mmHg above baseline over 9 of 9 readings",
  },
};

const baseValid: AIInsightResponse = {
  summary: "BP runs slightly above your 90-day median.",
  recommendations: [baseRec],
  citations: [baseCitation],
  warnings: [],
};

describe("aiRecommendationSchema — referenceId", () => {
  it("accepts an absent referenceId", () => {
    const result = aiRecommendationSchema.safeParse(baseRec);
    expect(result.success).toBe(true);
  });

  it("accepts a referenceId that exists in the bundle", () => {
    const result = aiRecommendationSchema.safeParse({
      ...baseRec,
      referenceId: knownRefId,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.referenceId).toBe(knownRefId);
    }
  });

  it("rejects a referenceId that is NOT in the bundle", () => {
    const result = aiRecommendationSchema.safeParse({
      ...baseRec,
      referenceId: "fabricated-guideline-2099",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[i.path.length - 1] === "referenceId",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/not in MEDICAL_REFERENCES/);
    }
  });

  it("rejects a referenceId that is the empty string", () => {
    const result = aiRecommendationSchema.safeParse({
      ...baseRec,
      referenceId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("aiInsightResponseSchema — referenceId integration", () => {
  it("accepts a payload where every rec carries a known referenceId", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...baseValid,
      recommendations: [{ ...baseRec, referenceId: knownRefId }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload with one fabricated referenceId, even when the rest is valid", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...baseValid,
      recommendations: [
        { ...baseRec, referenceId: knownRefId },
        {
          ...baseRec,
          id: "rec-2",
          referenceId: "esh-9999-fake",
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const refIssue = result.error.issues.find((i) =>
        i.path.includes("referenceId"),
      );
      expect(refIssue).toBeDefined();
    }
  });

  it("accepts a payload with a mix of cited and uncited recs", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...baseValid,
      recommendations: [
        { ...baseRec, referenceId: knownRefId },
        { ...baseRec, id: "rec-2" }, // no referenceId — observational
      ],
    });
    expect(result.success).toBe(true);
  });

  it("preserves the referenceId on round-trip parse", () => {
    const parsed = aiInsightResponseSchema.parse({
      ...baseValid,
      recommendations: [{ ...baseRec, referenceId: knownRefId }],
    });
    expect(parsed.recommendations[0].referenceId).toBe(knownRefId);
  });
});
