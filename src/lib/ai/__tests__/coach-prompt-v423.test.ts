import { describe, it, expect } from "vitest";

import {
  PROMPT_VERSION,
  getStrictInsightsSystemPrompt,
} from "@/lib/ai/prompts/insight-generator";

/**
 * v1.4.23 W4 F6 — pins the additive Apple Health prompt ratchet.
 *
 * Asserts:
 *   1. PROMPT_VERSION sits on the 4.23.x train.
 *   2. GROUND RULE 12 ships in the EN prompt and tells the model to
 *      stay silent about HealthKit metrics when the snapshot doesn't
 *      carry them — defending against the "you don't have HRV data"
 *      apologetic-opener regression on web-only accounts.
 *   3. The German prompt carries the same rule with the same intent.
 *   4. The OUTPUT FORMAT block enumerates the new sourceMetric tokens
 *      so the model emits the additive enum values directly.
 */
describe("PROMPT_VERSION (v1.4.23 Apple Health ratchet)", () => {
  it("matches the 4.23+ train", () => {
    // v1.4.25 W5b ratchet to 4.24.0 — GROUND RULE 13 bans internal
    // metric enum identifiers from prose. The pin loosens to accept
    // any 4.{>=23}.x revision so future additive ratchets don't
    // force a hostile test rewrite each time the rules grow.
    const [, minor] = PROMPT_VERSION.split(".").map(Number);
    expect(PROMPT_VERSION).toMatch(/^4\.\d+\.\d+$/);
    expect(minor).toBeGreaterThanOrEqual(23);
  });
});

describe("getStrictInsightsSystemPrompt — EN", () => {
  const prompt = getStrictInsightsSystemPrompt("en");

  it("carries GROUND RULE 12 with the Apple Health silent-fallback contract", () => {
    expect(prompt).toMatch(/12\. v1\.4\.23/);
    expect(prompt).toMatch(/Apple Health metric categories/);
    expect(prompt).toMatch(/HRV/);
    expect(prompt).toMatch(/sleep duration/);
    expect(prompt).toMatch(/resting HR/);
    expect(prompt).toMatch(/do not apologise/);
    expect(prompt).toMatch(/silent/);
  });

  it("does not bake live tenant figures into the new rule", () => {
    // PII rule (per the marathon brief): GROUND RULE 12 frames in terms
    // of metric categories, never a specific number / email / username.
    // The block starts at "12. v1.4.23" and ends at the
    // GUIDELINE TARGETS heading that closes the ground-rules section.
    const rule12 =
      prompt.split("12. v1.4.23")[1]?.split("GUIDELINE TARGETS")[0] ?? "";
    expect(rule12.length).toBeGreaterThan(0);
    expect(rule12).not.toMatch(/@.+\.(com|net|org|de|test)/);
    // The rule mentions metric category names but no concrete sample
    // values — categories only.
    expect(rule12).not.toMatch(/\b\d{1,3}\s*(mmHg|bpm|kcal)\b/);
  });

  it("documents the additive sourceMetric tokens in the OUTPUT FORMAT", () => {
    expect(prompt).toMatch(
      /hrv \| sleep \| resting_hr \| steps \| active_energy/,
    );
  });
});

describe("getStrictInsightsSystemPrompt — DE", () => {
  const prompt = getStrictInsightsSystemPrompt("de");

  it("carries GROUND RULE 12 with the German silent-fallback wording", () => {
    expect(prompt).toMatch(/12\. v1\.4\.23/);
    expect(prompt).toMatch(/Apple-Health-Metrik-Kategorien/);
    expect(prompt).toMatch(/HRV/);
    expect(prompt).toMatch(/Schlafdauer/);
    expect(prompt).toMatch(/Ruhepuls/);
    expect(prompt).toMatch(/entschuldige dich nicht/);
    expect(prompt).toMatch(/unsichtbar/);
  });

  it("documents the additive sourceMetric tokens in the German OUTPUT FORMAT", () => {
    expect(prompt).toMatch(
      /hrv \| sleep \| resting_hr \| steps \| active_energy/,
    );
  });
});

/**
 * v1.4.25 W5b — pin GROUND RULE 13 (no internal metric identifiers
 * in prose). Marc saw the "Metric Pressure_Sys" leak on the
 * Einschätzungen surface 2026-05-14; the stripper covers the leak at
 * render time, GROUND RULE 13 closes the loop at generation time so
 * the cleaned-up prose was the only version emitted in the first
 * place.
 */
describe("getStrictInsightsSystemPrompt — GROUND RULE 13 (no enum names in prose)", () => {
  it("EN prompt carries the rule and enumerates the banned identifiers", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toMatch(/13\. v1\.4\.25/);
    expect(prompt).toMatch(/Internal metric identifiers/);
    // The banned-list is enumerated verbatim so the model has no
    // ambiguity about which strings are off-limits in prose.
    expect(prompt).toMatch(/"Pressure_Sys"/);
    expect(prompt).toMatch(/"BLOOD_PRESSURE_SYS"/);
    expect(prompt).toMatch(/"PULSE_BPM"/);
    expect(prompt).toMatch(/"MOOD_SCORE"/);
    expect(prompt).toMatch(/"MEDICATION_COMPLIANCE_PCT"/);
    // Apple Health additions also banned in prose (the surface
    // ships in v1.5 but the model can mention them on iOS-connected
    // snapshots today).
    expect(prompt).toMatch(/"HEART_RATE_VARIABILITY"/);
    expect(prompt).toMatch(/"SLEEP_DURATION"/);
    // The carve-out for contract identifiers must remain in place
    // so the parser keeps working.
    expect(prompt).toMatch(/metricSource\.type/);
    expect(prompt).toMatch(/applies ONLY to prose/);
  });

  it("DE prompt carries the rule with the same banned list", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toMatch(/13\. v1\.4\.25/);
    expect(prompt).toMatch(/Interne Metrik-Identifier/);
    expect(prompt).toMatch(/"Pressure_Sys"/);
    expect(prompt).toMatch(/"BLOOD_PRESSURE_SYS"/);
    expect(prompt).toMatch(/"PULSE_BPM"/);
    expect(prompt).toMatch(/"MOOD_SCORE"/);
    expect(prompt).toMatch(/"MEDICATION_COMPLIANCE_PCT"/);
    expect(prompt).toMatch(/"HEART_RATE_VARIABILITY"/);
    expect(prompt).toMatch(/"SLEEP_DURATION"/);
    expect(prompt).toMatch(/AUSSCHLIEßLICH für Fließtext/);
  });
});
