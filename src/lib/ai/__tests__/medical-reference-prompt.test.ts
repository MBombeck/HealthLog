import { describe, it, expect } from "vitest";
import {
  getStrictInsightsSystemPrompt,
  buildSystemPromptWithReferences,
  PROMPT_VERSION,
} from "../prompts/insight-generator";
import {
  MEDICAL_REFERENCES,
  selectReferencesForMetrics,
} from "../medical-references";

/**
 * v1.4.16 — system prompt embeds the curated medical-
 * reference bundle as a SOURCES block so the model can cite by id.
 *
 * The block is injected dynamically: only references that overlap the
 * metrics in the current snapshot show up. This keeps the prompt
 * focused (no irrelevant ESH text on a weight-only call) and stays
 * inside the token budget.
 *
 * The plain `getStrictInsightsSystemPrompt(locale)` continues to work
 * (no metrics → no SOURCES block) so legacy call-sites and the
 * existing prompt assertions stay green during the migration.
 */

describe("PROMPT_VERSION", () => {
  it("is at least 4.16.0 for the v1.4.16 medical-reference grounding update", () => {
    // v1.4.16 anchored at 4.16.0, then bumped the
    // patch component to 4.16.1 when the comparison-mode narrative
    // ground rule landed. v1.4.19 bumped to 4.19.0 when the
    // no-default-positivity opener ground rule landed. Use a numeric
    // comparison so future ratchets stay covered without rewriting
    // this assertion.
    const [major, minor] = PROMPT_VERSION.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(4);
    expect(major === 4 ? minor >= 16 : true).toBe(true);
  });
});

describe("buildSystemPromptWithReferences()", () => {
  it("with no metrics returns the plain prompt with no SOURCES block", () => {
    const prompt = buildSystemPromptWithReferences("en", []);
    expect(prompt).toContain("YOUR ROLE");
    expect(prompt).not.toContain("SOURCES");
    expect(prompt).not.toContain("MEDICAL_REFERENCES");
  });

  it("for a bp-only snapshot includes a SOURCES block listing the bp-applicable references", () => {
    const prompt = buildSystemPromptWithReferences("en", ["bp"]);
    const refs = selectReferencesForMetrics(["bp"]);
    expect(refs.length).toBeGreaterThan(0);
    expect(prompt).toContain("SOURCES");
    for (const ref of refs) {
      expect(prompt).toContain(ref.id);
      expect(prompt).toContain(ref.org);
      expect(prompt).toContain(ref.title);
      expect(prompt).toContain(ref.url);
    }
  });

  it("English variant uses the English title; German variant uses titleDe", () => {
    const en = buildSystemPromptWithReferences("en", ["bp"]);
    const de = buildSystemPromptWithReferences("de", ["bp"]);
    const sample = MEDICAL_REFERENCES.find((r) =>
      r.metricApplicability.includes("bp"),
    );
    expect(sample).toBeDefined();
    if (sample && sample.title !== sample.titleDe) {
      expect(en).toContain(sample.title);
      expect(de).toContain(sample.titleDe);
    }
  });

  it("teaches the model the citation rule under GROUND RULES", () => {
    const prompt = buildSystemPromptWithReferences("en", ["bp"]);
    // Allow whitespace incl. newline between phrase halves so a future
    // re-flow doesn't break the assertion.
    expect(prompt).toMatch(/cite the matching\s+reference id/i);
    expect(prompt).toMatch(/SOURCES/);
  });

  it("German prompt teaches the citation rule under GROUNDREGELN", () => {
    const prompt = buildSystemPromptWithReferences("de", ["bp"]);
    // The prompt wraps; allow whitespace incl. newline between phrase
    // halves so a future re-flow doesn't break the assertion.
    expect(prompt).toMatch(/zitiere die passende\s+Referenz-ID/i);
    expect(prompt).toMatch(/SOURCES/);
  });

  it("dedupes references when multiple metrics map to the same source", () => {
    const prompt = buildSystemPromptWithReferences("en", ["bp", "bp", "bp"]);
    const sample = MEDICAL_REFERENCES.find((r) =>
      r.metricApplicability.includes("bp"),
    );
    expect(sample).toBeDefined();
    if (sample) {
      // Each id appears at least once but not duplicated within the
      // SOURCES block (a duplicate would confuse the model).
      const occurrences = (
        prompt.match(new RegExp(`id: ${sample.id}\\b`, "g")) ?? []
      ).length;
      expect(occurrences).toBe(1);
    }
  });

  it("keeps the existing scope-hardened guards (refusal pattern, citation cross-check)", () => {
    const prompt = buildSystemPromptWithReferences("en", ["bp"]);
    expect(prompt).toMatch(/OUT-OF-SCOPE/);
    expect(prompt).toMatch(/ZERO HALLUCINATIONS/);
    expect(prompt).toContain("citations[]");
  });

  it("contains the bumped PROMPT_VERSION", () => {
    const prompt = buildSystemPromptWithReferences("en", ["bp"]);
    expect(prompt).toContain(PROMPT_VERSION);
    // v1.4.16 started at 4.16.0 and bumped to 4.16.1.
    // v1.4.19 bumped to 4.19.0; v1.22 bumped to 5.0.0.
    expect(prompt).toMatch(/[45]\.\d+\.\d+/);
  });
});

describe("plain getStrictInsightsSystemPrompt() backward compatibility", () => {
  it("does NOT include the SOURCES block (back-compat)", () => {
    const en = getStrictInsightsSystemPrompt("en");
    expect(en).not.toContain("SOURCES");
  });

  it("contains the bumped PROMPT_VERSION", () => {
    const en = getStrictInsightsSystemPrompt("en");
    expect(en).toMatch(/[45]\.\d+\.\d+/);
  });
});
