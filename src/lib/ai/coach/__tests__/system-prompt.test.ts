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
  it("matches the 4.23+ / 5.x train", () => {
    // v1.4.23 ratcheted the prompt to add GROUND RULE 12 (Apple Health
    // optional categories). v1.4.25 W5b ratcheted again to add GROUND
    // RULE 13 (no internal metric identifiers in prose). v1.22 (W6) bumped
    // the briefing prompt to the 5.x train for the verdict-first synthesis
    // rewrite. The pin accepts any 4.{>=23}.x OR any 5.x revision so future
    // additive ratchets don't force a hostile test rewrite each time.
    const [major, minor] = PROMPT_VERSION.split(".").map(Number);
    expect(PROMPT_VERSION).toMatch(/^[45]\.\d+\.\d+$/);
    expect(major === 4 ? minor >= 23 : true).toBe(true);
  });
});

describe("getCoachSystemPrompt — EN", () => {
  const prompt = getCoachSystemPrompt("en");

  it("embeds the active PROMPT_VERSION", () => {
    expect(prompt).toContain(PROMPT_VERSION);
  });

  it("opens with the warm, role-bounded persona statement", () => {
    expect(prompt).toMatch(/You are the HealthLog Coach/);
    // v1.15.15 — the premium motivating-advisor register.
    expect(prompt).toMatch(/warm, motivating advisor/i);
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
    expect(prompt).toMatch(/4\. Conservative phrasing,/);
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
    expect(prompt).toMatch(/exercise isn't something\s+you're tracking/);
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

  it("documents the glucose.clinical panel sub-key and its gates", () => {
    // v1.17.0 — the model must know the `clinical` sub-key exists, how to
    // read TIR/GMI/eA1C/CV, and must NOT assert a clinical figure when the
    // learning-gate or the spot-estimate caveat is set.
    expect(prompt).toMatch(/"clinical"/);
    expect(prompt).toMatch(/tirPercent/);
    expect(prompt).toMatch(/\bgmi\b/);
    expect(prompt).toMatch(/estimatedA1c/);
    expect(prompt).toMatch(/cvPercent/);
    expect(prompt).toMatch(/stillLearning/);
    expect(prompt).toMatch(/isSpotEstimate/);
  });

  it("names the time-in-range band through the block, never in one fixed unit", () => {
    // The glucose block is in the reader's unit; a band stated here in
    // mg/dL would sit beside mmol/L numbers for a mmol/L reader.
    expect(prompt).toMatch(/"tirRange"/);
    expect(prompt).not.toMatch(/70–180 mg\/dL/);
  });

  it("tells the model every block is already in the reader's unit", () => {
    expect(prompt).toMatch(
      /A block's "unit" \(and the workouts block's "distanceUnit"\)/,
    );
    expect(prompt).toMatch(/never convert them/);
    // No fixed list that offers kg (or both glucose units) for one quantity.
    expect(prompt).not.toMatch(/"unit" is one of/);
  });

  it("documents the WHOOP-native dayStrain block vs the computed proxy", () => {
    // v1.17.0 — native 0–21 strain preferred over the computed 0–100 proxy.
    expect(prompt).toMatch(/dayStrain/);
    expect(prompt).toMatch(/0–21/);
    expect(prompt).toMatch(/0–100/);
  });

  it("carries the v1.21.2 narrative-presence clauses (A4/A5/A6/A7)", () => {
    // A4 — briefing-style callback + forward-look from the memory block.
    expect(prompt).toMatch(/17\. Recall \+ look ahead/);
    expect(prompt).toMatch(/priorNarrative/);
    expect(prompt).toMatch(/trendMemory/);
    // A5 — Tension Verdict with the clinical-floors override.
    expect(prompt).toMatch(/18\. Tension Verdict/);
    expect(prompt).toMatch(/"TENSION" flag/);
    expect(prompt).toMatch(/CLINICAL-FLOORS OVERRIDE/);
    expect(prompt).toMatch(/clinicalOverride/);
    expect(prompt).toMatch(/NEVER reconcile it\s+away into a calm verdict/i);
    // A6 — streaks + return-to-baseline.
    expect(prompt).toMatch(/19\. Streaks \+ return-to-baseline/);
    expect(prompt).toMatch(/returnEvent/);
    expect(prompt).toMatch(/back inside your usual range/i);
    // A7 — MI freebies + anti-persuasion (Chain-of-Ethic).
    expect(prompt).toMatch(/20\. Motivational-interviewing freebies/);
    expect(prompt).toMatch(/DEVELOP DISCREPANCY/);
    expect(prompt).toMatch(/ROLL WITH RESISTANCE/);
    expect(prompt).toMatch(/Chain-of-Ethic/);
  });
});

describe("getCoachSystemPrompt — DE", () => {
  const prompt = getCoachSystemPrompt("de");

  it("embeds the active PROMPT_VERSION", () => {
    expect(prompt).toContain(PROMPT_VERSION);
  });

  it("opens with the warm, role-bounded persona statement in German", () => {
    expect(prompt).toMatch(/Du bist der HealthLog-Coach/);
    // v1.15.15 — the premium motivating-advisor register.
    expect(prompt).toMatch(/warme, motivierende Begleiter/);
    expect(prompt).toMatch(/sitzt neben dem Nutzer/);
    expect(prompt).toMatch(/warm, neugierig\s+und zurückhaltend/);
    expect(prompt).toMatch(/diagnostizierst nicht/);
  });

  it("carries the numbered GRUNDREGELN section", () => {
    expect(prompt).toMatch(/GRUNDREGELN/);
    expect(prompt).toMatch(/1\. Fließtext zuerst\./);
    expect(prompt).toMatch(/2\. Werte gehören in den Evidenz-Block\./);
    expect(prompt).toMatch(/3\. Fehlende Daten sind eine Einladung/);
    expect(prompt).toMatch(/4\. Zurückhaltende Sprache,/);
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
    expect(prompt).toMatch(/Bewegung nicht erfasst/);
    expect(prompt).toMatch(/außerhalb dessen, womit ich helfen kann/);
  });

  it("takes the evidence-block unit from the snapshot, not from a fixed list", () => {
    // The list used to be fixed (mmHg, kg, …, mg/dL, mmol/L): a reader on
    // pounds had no sanctioned token, and both glucose units were offered
    // for one quantity. The unit now comes from the block that holds the
    // value; minutes stay named for the sleep-debt figures.
    expect(prompt).toMatch(
      /"unit" ist die Einheit, die der Snapshot für diesen Wert angibt/,
    );
    expect(prompt).toMatch(/min für Schlafschuld/);
    expect(prompt).not.toMatch(/"unit" ist eines aus/);
  });

  it("carries the v1.21.2 narrative-presence clauses (A4/A5/A6/A7)", () => {
    expect(prompt).toMatch(/17\. Rückblick \+ Ausblick/);
    expect(prompt).toMatch(/priorNarrative/);
    expect(prompt).toMatch(/18\. Spannungs-Verdikt/);
    expect(prompt).toMatch(/"TENSION"-Flag/);
    expect(prompt).toMatch(/CLINICAL-FLOORS-OVERRIDE/);
    expect(prompt).toMatch(/19\. Serien \+ Rückkehr zur Baseline/);
    expect(prompt).toMatch(/wieder in deinem üblichen Bereich/i);
    expect(prompt).toMatch(/20\. Motivational-Interviewing-Extras/);
    expect(prompt).toMatch(/DISKREPANZ ENTWICKELN/);
    expect(prompt).toMatch(/WIDERSTAND ANNEHMEN/);
    expect(prompt).toMatch(/Chain-of-Ethic/);
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
    // v1.41 — brief is 30-70 words in one paragraph.
    expect(out).toMatch(/VERBOSITY OVERRIDE: 30-70 words, one paragraph/);
    expect(out).not.toMatch(/up to 220 words/);
  });

  it("prepends a VERBOSITY OVERRIDE for verbosity=detailed at warm tone", () => {
    const out = getCoachSystemPrompt("en", {
      ...DEFAULT_COACH_PREFS,
      verbosity: "detailed",
    });
    // v1.41 — detailed is up to 220 words in up to three paragraphs.
    expect(out).toMatch(/VERBOSITY OVERRIDE: up to 220 words/);
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

describe("conditional trajectory ground rule (v1.11.0 Epic B, Pillar 3)", () => {
  const en = getCoachSystemPrompt("en");
  const de = getCoachSystemPrompt("de");

  // The prompt body wraps across lines, so every cross-token assertion
  // collapses interior whitespace with `\s+`.
  it("EN carries the conditional-projection rule gated on a trajectory block", () => {
    expect(en).toMatch(/trajectory"\s+block is present/i);
    expect(en).toMatch(/if this\s+pattern continues/i);
    // Absent-block guard: never project when there's no block.
    expect(en).toMatch(/NO "trajectory" block is present, do not project/i);
  });

  it("DE carries the same conditional-projection rule", () => {
    expect(de).toMatch(/"trajectory"-Block/);
    expect(de).toMatch(/wenn dieses Muster anhält/i);
    expect(de).toMatch(/projiziere\s+überhaupt\s+nicht/i);
  });

  it("structurally forbids upgrading a projection to a certainty / risk score / dated event", () => {
    // The overclaim probe: the prompt must explicitly bar the three
    // most dangerous upgrades a forecast narration can make.
    expect(en).toMatch(/never state a forecast as a certainty/i);
    expect(en).toMatch(/Never turn\s+a projection into a risk score/i);
    expect(en).toMatch(/dated event/i);
    expect(de).toMatch(/nie als\s+Gewissheit/i);
    expect(de).toMatch(/Risiko-Score/);
    expect(de).toMatch(/datiertes\s+Ereignis/i);
  });
});

describe("getCoachSystemPrompt — native locales name the reader's unit", () => {
  it.each(["fr", "es", "it", "pl"] as const)(
    "%s carries the block-unit rule and no fixed unit list",
    (locale) => {
      const prompt = getCoachSystemPrompt(locale);
      expect(prompt).toContain('"distanceUnit"');
      expect(prompt).not.toMatch(/mmHg, kg, bpm/);
    },
  );
});
