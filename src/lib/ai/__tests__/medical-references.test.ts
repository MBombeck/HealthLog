import { describe, it, expect } from "vitest";
import {
  MEDICAL_REFERENCES,
  MEDICAL_REFERENCE_IDS,
  MEDICAL_REFERENCE_ORGS,
  selectReferencesForMetrics,
} from "../medical-references";

/**
 * v1.4.16 — curated medical-reference bundle.
 *
 * The bundle is the single source of truth for any normative claim the
 * AI surface makes ("target < 140/90", "BMI 18.5-24.9", "≥ 7h sleep").
 * Schema validation in `aiInsightResponseSchema` rejects any
 * `recommendation.referenceId` that is not present in this list, so the
 * model cannot fabricate a guideline citation.
 *
 * These tests pin:
 *   - Every entry has the required fields (id, org, title, titleDe,
 *     url, publishedYear, scope, metricApplicability).
 *   - URLs parse as well-formed https URLs (defence against typos that
 *     would render a footnote pointing at a broken link).
 *   - IDs are unique slugs in [a-z0-9-] (stable joining key for the
 *     schema).
 *   - The bundle covers every applicability bucket the schema will see
 *     (bp, weight, pulse, mood, medication) — at least one reference
 *     per bucket so the prompt never injects an empty SOURCES list.
 *   - `selectReferencesForMetrics()` filters by overlap, not exact
 *     match.
 */

describe("MEDICAL_REFERENCES bundle", () => {
  it("is non-empty", () => {
    expect(MEDICAL_REFERENCES.length).toBeGreaterThanOrEqual(5);
  });

  it("every entry has the required fields populated", () => {
    for (const ref of MEDICAL_REFERENCES) {
      expect(ref.id, `id missing on ${JSON.stringify(ref)}`).toBeTruthy();
      expect(ref.org, `org missing on ${ref.id}`).toBeTruthy();
      expect(ref.title, `title missing on ${ref.id}`).toBeTruthy();
      expect(ref.titleDe, `titleDe missing on ${ref.id}`).toBeTruthy();
      expect(ref.url, `url missing on ${ref.id}`).toBeTruthy();
      expect(ref.publishedYear, `year missing on ${ref.id}`).toBeGreaterThan(
        1990,
      );
      expect(Array.isArray(ref.scope), `scope must be array on ${ref.id}`).toBe(
        true,
      );
      expect(
        ref.scope.length,
        `scope cannot be empty on ${ref.id}`,
      ).toBeGreaterThan(0);
      expect(
        Array.isArray(ref.metricApplicability),
        `metricApplicability must be array on ${ref.id}`,
      ).toBe(true);
      expect(
        ref.metricApplicability.length,
        `metricApplicability cannot be empty on ${ref.id}`,
      ).toBeGreaterThan(0);
    }
  });

  it("every URL parses as a well-formed https:// URL", () => {
    for (const ref of MEDICAL_REFERENCES) {
      expect(
        () => new URL(ref.url),
        `URL malformed on ${ref.id}`,
      ).not.toThrow();
      const parsed = new URL(ref.url);
      expect(parsed.protocol, `non-https URL on ${ref.id}`).toBe("https:");
      expect(parsed.hostname, `empty hostname on ${ref.id}`).toBeTruthy();
    }
  });

  it("every id is a stable slug in [a-z0-9-] and unique", () => {
    const slugRe = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    const seen = new Set<string>();
    for (const ref of MEDICAL_REFERENCES) {
      expect(ref.id, `id ${ref.id} not a slug`).toMatch(slugRe);
      expect(seen.has(ref.id), `duplicate id ${ref.id}`).toBe(false);
      seen.add(ref.id);
    }
  });

  it("publishedYear is sane (1990-2100)", () => {
    const now = new Date().getUTCFullYear();
    for (const ref of MEDICAL_REFERENCES) {
      expect(ref.publishedYear).toBeGreaterThanOrEqual(1990);
      expect(ref.publishedYear).toBeLessThanOrEqual(now + 1);
    }
  });

  it("covers every metric the AI surface emits (bp, weight, pulse, mood, medication)", () => {
    const requiredBuckets = [
      "bp",
      "weight",
      "pulse",
      "mood",
      "medication",
    ] as const;
    for (const bucket of requiredBuckets) {
      const matching = MEDICAL_REFERENCES.filter((r) =>
        r.metricApplicability.includes(bucket),
      );
      expect(
        matching.length,
        `no reference covers bucket "${bucket}"`,
      ).toBeGreaterThan(0);
    }
  });

  it("MEDICAL_REFERENCE_IDS is the same length as the bundle", () => {
    expect(MEDICAL_REFERENCE_IDS.length).toBe(MEDICAL_REFERENCES.length);
    for (const ref of MEDICAL_REFERENCES) {
      expect(MEDICAL_REFERENCE_IDS).toContain(ref.id);
    }
  });

  it("MEDICAL_REFERENCE_ORGS is the union of orgs", () => {
    const orgs = new Set(MEDICAL_REFERENCES.map((r) => r.org));
    expect(MEDICAL_REFERENCE_ORGS.length).toBe(orgs.size);
    for (const org of orgs) {
      expect(MEDICAL_REFERENCE_ORGS).toContain(org);
    }
  });
});

describe("selectReferencesForMetrics()", () => {
  it("returns only references whose metricApplicability overlaps the requested metrics", () => {
    const refs = selectReferencesForMetrics(["bp"]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.metricApplicability).toContain("bp");
    }
  });

  it("deduplicates when multiple metrics map to the same reference", () => {
    // A reference applicable to both bp and pulse must appear once in
    // the union, not twice.
    const refs = selectReferencesForMetrics(["bp", "bp"]);
    const ids = refs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns an empty array when no metric matches", () => {
    // @ts-expect-error — pass an unknown metric to test the no-overlap path.
    const refs = selectReferencesForMetrics(["sodium-intake"]);
    expect(refs).toEqual([]);
  });

  it("empty input returns empty output", () => {
    expect(selectReferencesForMetrics([])).toEqual([]);
  });

  it("preserves bundle order for stable prompt rendering", () => {
    const refs = selectReferencesForMetrics(["bp", "weight"]);
    const orderInBundle = MEDICAL_REFERENCES.filter((r) =>
      r.metricApplicability.some((m) => m === "bp" || m === "weight"),
    );
    expect(refs.map((r) => r.id)).toEqual(orderInBundle.map((r) => r.id));
  });
});
