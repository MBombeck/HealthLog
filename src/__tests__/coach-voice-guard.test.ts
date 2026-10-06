/**
 * v1.41 — the Coach's voice, held in the prompt.
 *
 * The voice section (`buildCoachVoiceBlock`) is the one statement of how a
 * Coach answer is shaped: the answer first, one carrying number, the
 * assumption in one line, at most one next step, 40-120 words, and a closed
 * list of filler it never writes. A prompt rewrite that drops a rule, or an
 * example that models the opposite (a closing question, two next steps, a
 * filler), would quietly teach the model the old habits back. This guard
 * pins both bodies to the rules, and every few-shot example to the grader
 * that scores live answers.
 *
 * Each check is a function run once on the real prompt and once on a prompt
 * broken on purpose, so the guard is shown to fail.
 */
import { describe, expect, it } from "vitest";

import {
  COACH_ANSWER_WORDS,
  COACH_FILLER_PHRASES,
  buildCoachVoiceBlock,
  getCoachSystemPrompt,
} from "@/lib/ai/coach/system-prompt";
import { gradeVoice } from "@/lib/ai/coach/eval/grade-voice";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";
import type { Locale } from "@/lib/i18n/config";

const LOCALES: Locale[] = ["de", "en", "fr", "es", "it", "pl", "ko"];

/** The rules a voice section must state; `[]` when it states them all. */
function missingVoiceRules(prompt: string, lang: "de" | "en"): string[] {
  const missing: string[] = [];
  const band = COACH_ANSWER_WORDS.standard;
  const header =
    lang === "de" ? "TON UND ANTWORTAUFBAU" : "VOICE AND ANSWER SHAPE";
  if (!prompt.includes(header)) missing.push("header");
  if (!prompt.includes(`${band.min}-${band.max}`)) missing.push("length band");
  const rules =
    lang === "de"
      ? [
          /erste Satz beantwortet die Frage/,
          /Eine tragende Zahl/,
          /Angenommen: letzte/,
          /höchstens EINEM konkreten nächsten Schritt/,
          /Nie eine Frage am Ende/,
          /keine Emojis/,
        ]
      : [
          /first sentence answers the question/,
          /One carrying number/,
          /Assumed: last 30 days/,
          /at most ONE concrete next step/,
          /Never a question at the end/,
          /no emojis/,
        ];
  for (const rule of rules) if (!rule.test(prompt)) missing.push(rule.source);
  for (const phrase of COACH_FILLER_PHRASES[lang]) {
    if (!prompt.includes(`"${phrase}"`)) missing.push(`filler ${phrase}`);
  }
  return missing;
}

/** The COACH lines of the few-shot examples. */
function exampleAnswers(prompt: string): string[] {
  const answers: string[] = [];
  for (const match of prompt.matchAll(/<example>([\s\S]*?)<\/example>/g)) {
    const coach = match[1].split(/^COACH:\s*/m)[1];
    if (coach) answers.push(coach.trim());
  }
  return answers;
}

/** Examples that break the voice; `[]` when every one keeps it. */
function examplesOffVoice(prompt: string): string[] {
  return exampleAnswers(prompt).filter((answer) => !gradeVoice(answer).passed);
}

describe("coach voice guard", () => {
  it.each(["en", "de"] as const)(
    "the %s body states every voice rule and filler",
    (lang) => {
      const prompt = getCoachSystemPrompt(lang);
      expect(missingVoiceRules(prompt, lang)).toEqual([]);
      // Broken on purpose: one filler dropped from the list.
      const broken = prompt.replaceAll(
        `"${COACH_FILLER_PHRASES[lang][0]}"`,
        "",
      );
      expect(missingVoiceRules(broken, lang)).not.toEqual([]);
    },
  );

  it.each(LOCALES)("the %s prompt carries the voice section", (locale) => {
    expect(getCoachSystemPrompt(locale)).toContain(
      buildCoachVoiceBlock(locale),
    );
  });

  it.each(["en", "de"] as const)(
    "every %s example answer keeps the voice",
    (lang) => {
      const prompt = getCoachSystemPrompt(lang);
      expect(exampleAnswers(prompt).length).toBeGreaterThanOrEqual(5);
      expect(examplesOffVoice(prompt)).toEqual([]);
      // Broken on purpose: an example that ends on a habitual question.
      const broken = prompt.replace(
        /(<example>[\s\S]*?COACH:[\s\S]*?)(\n(?:---KEYVALUES---|<\/example>))/,
        "$1 How does that sound to you?$2",
      );
      expect(examplesOffVoice(broken)).not.toEqual([]);
    },
  );

  it("keeps no length rule from before the voice section", () => {
    for (const lang of ["en", "de"] as const) {
      const prompt = getCoachSystemPrompt(lang, {
        ...DEFAULT_COACH_PREFS,
        verbosity: "detailed",
      });
      expect(prompt).not.toMatch(/60-180/);
      expect(prompt).not.toMatch(/180-250/);
      expect(prompt).not.toMatch(/~90/);
    }
  });

  it("states the brief and detailed lengths from the same numbers", () => {
    const brief = getCoachSystemPrompt("en", {
      ...DEFAULT_COACH_PREFS,
      verbosity: "brief",
    });
    expect(brief).toContain(
      `${COACH_ANSWER_WORDS.brief.min}-${COACH_ANSWER_WORDS.brief.max} words`,
    );
    const detailed = getCoachSystemPrompt("de", {
      ...DEFAULT_COACH_PREFS,
      verbosity: "detailed",
    });
    expect(detailed).toContain(`bis ${COACH_ANSWER_WORDS.detailed.max} Wörter`);
  });

  it("asks a confidence question only on an explicit plan request", () => {
    expect(getCoachSystemPrompt("en")).toMatch(
      /Confidence ruler, only on an explicit plan request/,
    );
    expect(getCoachSystemPrompt("de")).toMatch(
      /Konfidenz-Skala, nur bei ausdrücklicher Plan-Bitte/,
    );
  });
});
