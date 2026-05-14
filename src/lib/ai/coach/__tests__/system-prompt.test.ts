import { describe, expect, it } from "vitest";

import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";
import { getCoachSystemPrompt } from "../system-prompt";

/**
 * v1.4.22 Wave 3 B1 — pins the Coach system prompt rewrite.
 *
 * Asserts that:
 *   1. PROMPT_VERSION sits on the v1.4.22 train.
 *   2. The EN + DE prompts both carry the load-bearing sections —
 *      GROUND RULES, DAY-LEVEL READINGS / TAGES-LEVEL-MESSWERTE, and
 *      the EVIDENCE BLOCK / EVIDENZ-BLOCK contract.
 *   3. The few-shot tone-calibration `<example>` pairs are baked into
 *      the prompt body (per the W1b research output).
 */
describe("PROMPT_VERSION (v1.4.23 Coach + Apple Health extension)", () => {
  it("matches the 4.23+ train", () => {
    // v1.4.23 ratcheted the prompt to add GROUND RULE 12 (Apple Health
    // optional categories). v1.4.25 W5b ratcheted again to add GROUND
    // RULE 13 (no internal metric identifiers in prose). The pin
    // loosens to accept any 4.{>=23}.x revision so future additive
    // ratchets don't force a hostile test rewrite each time.
    const [, minor] = PROMPT_VERSION.split(".").map(Number);
    expect(PROMPT_VERSION).toMatch(/^4\.\d+\.\d+$/);
    expect(minor).toBeGreaterThanOrEqual(23);
  });
});

describe("getCoachSystemPrompt — EN", () => {
  const prompt = getCoachSystemPrompt("en");

  it("embeds the active PROMPT_VERSION", () => {
    expect(prompt).toContain(PROMPT_VERSION);
  });

  it("opens with the warm, role-bounded persona statement", () => {
    expect(prompt).toMatch(/You are the HealthLog Coach\./);
    expect(prompt).toMatch(/sit alongside/i);
    expect(prompt).toMatch(/warm,\s+curious,\s+and conservative/i);
    expect(prompt).toMatch(/not their doctor/i);
    expect(prompt).toMatch(/don't diagnose, prescribe, or change medication/i);
  });

  it("carries the numbered GROUND RULES section", () => {
    expect(prompt).toMatch(/GROUND RULES/);
    expect(prompt).toMatch(/1\. Prose-first\./);
    expect(prompt).toMatch(/2\. Values belong in the evidence block\./);
    expect(prompt).toMatch(
      /3\. Missing data is an invitation, not a refusal\./,
    );
    expect(prompt).toMatch(/4\. Conservative phrasing\./);
    expect(prompt).toMatch(/5\. Motivational-interviewing micro-moves\./);
    expect(prompt).toMatch(/6\. Redirect off-topic input gracefully\./);
    expect(prompt).toMatch(/7\. Ground every number in the SNAPSHOT\./);
    // v1.4.25 W5b — GROUND RULE 8 added on the Coach side: bans the
    // raw enum identifiers from the user-facing reply text and from
    // the evidence-block labels.
    expect(prompt).toMatch(/8\. Internal metric identifiers/);
  });

  it("preserves the v1.4.21 DAY-LEVEL READINGS section verbatim", () => {
    expect(prompt).toMatch(/DAY-LEVEL READINGS — USE THE TIMELINE/);
    expect(prompt).toMatch(/timeline\.recent/);
    expect(prompt).toMatch(/timeline\.weekly/);
    expect(prompt).toMatch(/14 days/);
  });

  it("teaches the ---KEYVALUES--- / ---END--- evidence-block contract", () => {
    expect(prompt).toMatch(/EVIDENCE BLOCK/);
    expect(prompt).toContain("---KEYVALUES---");
    expect(prompt).toContain("---END---");
    expect(prompt).toMatch(/Hard cap 8 lines/);
    expect(prompt).toMatch(/Omit the entire block/);
  });

  it("includes the tone-calibration <example> few-shots", () => {
    const exampleOpens = (prompt.match(/<example>/g) ?? []).length;
    const exampleCloses = (prompt.match(/<\/example>/g) ?? []).length;
    // The W1b research called for 3-5 pairs; the production prompt ships 5.
    expect(exampleOpens).toBeGreaterThanOrEqual(3);
    expect(exampleOpens).toBeLessThanOrEqual(8);
    expect(exampleOpens).toBe(exampleCloses);
    // At least one example demonstrates the missing-data invitation
    // pivot (rule 3) and one demonstrates the off-topic redirect (rule 6).
    expect(prompt).toMatch(/I don't see exercise in what you're tracking/);
    expect(prompt).toMatch(/outside what I can help with/i);
  });

  it("does not bake live-tenant figures into the prompt body", () => {
    // PII rule: the prompt teaches the model how to handle data; it
    // must not encode a specific tenant's readings. Sample figures
    // inside the few-shot examples are fine (they're generic
    // illustrations) but no live username / email / real PII should
    // appear.
    expect(prompt).not.toMatch(/@.+\.(com|net|org|de|test)/);
  });
});

describe("getCoachSystemPrompt — DE", () => {
  const prompt = getCoachSystemPrompt("de");

  it("embeds the active PROMPT_VERSION", () => {
    expect(prompt).toContain(PROMPT_VERSION);
  });

  it("opens with the warm, role-bounded persona statement in German", () => {
    expect(prompt).toMatch(/Du bist der HealthLog-Coach\./);
    expect(prompt).toMatch(/sitzt neben dem Nutzer/);
    expect(prompt).toMatch(/warm, neugierig\s+und zurückhaltend/);
    expect(prompt).toMatch(/diagnostizierst nicht/);
  });

  it("carries the numbered GRUNDREGELN section", () => {
    expect(prompt).toMatch(/GRUNDREGELN/);
    expect(prompt).toMatch(/1\. Fließtext zuerst\./);
    expect(prompt).toMatch(/2\. Werte gehören in den Evidenz-Block\./);
    expect(prompt).toMatch(/3\. Fehlende Daten sind eine Einladung/);
    expect(prompt).toMatch(/4\. Zurückhaltende Sprache\./);
    expect(prompt).toMatch(
      /5\. Mikro-Moves aus dem Motivational Interviewing\./,
    );
    expect(prompt).toMatch(/6\. Off-topic-Eingaben elegant umlenken\./);
    expect(prompt).toMatch(/7\. Verankere jede Zahl im SNAPSHOT\./);
    // v1.4.25 W5b — GROUND RULE 8 on the German Coach side.
    expect(prompt).toMatch(/8\. Interne Metrik-Identifier/);
  });

  it("preserves the TAGES-LEVEL-MESSWERTE section verbatim", () => {
    expect(prompt).toMatch(/TAGES-LEVEL-MESSWERTE — NUTZE DIE TIMELINE/);
    expect(prompt).toMatch(/timeline\.recent/);
    expect(prompt).toMatch(/timeline\.weekly/);
    expect(prompt).toMatch(/14 Tage/);
  });

  it("teaches the ---KEYVALUES--- / ---END--- evidence-block contract", () => {
    expect(prompt).toMatch(/EVIDENZ-BLOCK/);
    expect(prompt).toContain("---KEYVALUES---");
    expect(prompt).toContain("---END---");
    expect(prompt).toMatch(/Höchstgrenze 8 Zeilen/);
  });

  it("includes the tone-calibration <example> few-shots", () => {
    const exampleOpens = (prompt.match(/<example>/g) ?? []).length;
    const exampleCloses = (prompt.match(/<\/example>/g) ?? []).length;
    expect(exampleOpens).toBeGreaterThanOrEqual(3);
    expect(exampleOpens).toBe(exampleCloses);
    expect(prompt).toMatch(/Bewegung sehe ich in deinem Tracking gerade nicht/);
    expect(prompt).toMatch(/außerhalb dessen, womit ich helfen kann/);
  });
});

/**
 * v1.4.23 H4 — per-user prompt-tuning prefix. Default prefs leave the
 * prompt unchanged so the v1.4.22 train stays in place; non-default
 * tone / verbosity selections prepend a short OVERRIDE paragraph.
 */
describe("getCoachSystemPrompt — H4 prefs prefix", () => {
  it("returns the unchanged base prompt when prefs are at defaults", () => {
    const base = getCoachSystemPrompt("en");
    const withDefaults = getCoachSystemPrompt("en", DEFAULT_COACH_PREFS);
    expect(withDefaults).toBe(base);
  });

  it("prepends a TONE OVERRIDE for tone=neutral", () => {
    const out = getCoachSystemPrompt("en", {
      ...DEFAULT_COACH_PREFS,
      tone: "neutral",
    });
    expect(out.startsWith("TONE OVERRIDE")).toBe(true);
    expect(out).toMatch(/keep the warmth language minimal/i);
  });

  it("prepends a TONE OVERRIDE for tone=concise (and forces brief verbosity)", () => {
    const out = getCoachSystemPrompt("en", {
      ...DEFAULT_COACH_PREFS,
      tone: "concise",
      verbosity: "detailed",
    });
    // Concise tone overrides verbosity — even if the user picked
    // "detailed", the prefix asks for the brief cap.
    expect(out).toMatch(/TONE OVERRIDE: be concise/);
    expect(out).toMatch(/VERBOSITY OVERRIDE: cap replies at ~90 words/);
    expect(out).not.toMatch(/180-250 words is acceptable/);
  });

  it("prepends a VERBOSITY OVERRIDE for verbosity=detailed at warm tone", () => {
    const out = getCoachSystemPrompt("en", {
      ...DEFAULT_COACH_PREFS,
      verbosity: "detailed",
    });
    expect(out).toMatch(/VERBOSITY OVERRIDE: 180-250 words is acceptable/);
  });

  it("prepends a German prefix in the de locale", () => {
    const out = getCoachSystemPrompt("de", {
      ...DEFAULT_COACH_PREFS,
      tone: "neutral",
      verbosity: "brief",
    });
    expect(out).toMatch(/TONFALL-OVERRIDE/);
    expect(out).toMatch(/AUSFÜHRLICHKEITS-OVERRIDE/);
  });
});
