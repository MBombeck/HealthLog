/**
 * v1.41 — the voice grader. Every rule is broken once on purpose: a grader
 * that cannot fail is worse than none.
 */
import { describe, expect, it } from "vitest";

import { GOLDEN_CASES } from "@/lib/ai/coach/eval/golden-cases";
import { gradeCase } from "@/lib/ai/coach/eval/grade-groundedness";

import { countWords, findFillers, gradeVoice } from "../grade-voice";

const GOOD =
  "Your blood pressure has run a little above your usual for three weeks, 131/84 mmHg on average against 126/81 before.\nAssumed: last 30 days.\nOne thing to try this week: lights out 30 minutes earlier on three evenings.";

describe("gradeVoice", () => {
  it("passes the reference answer", () => {
    const grade = gradeVoice(GOOD);
    expect(grade.passed).toBe(true);
    expect(grade.assumptionLines).toBe(1);
    expect(grade.nextSteps).toBe(1);
  });

  it("ignores the evidence block", () => {
    const withBlock = `${GOOD}\n---KEYVALUES---\navg30 systolic: 131 [mmHg] (last30days)\n---END---`;
    expect(gradeVoice(withBlock).words).toBe(gradeVoice(GOOD).words);
  });

  it("fails a filler phrase, in either language", () => {
    expect(gradeVoice(`${GOOD} I hope this helps.`).fillers).toEqual([
      "i hope this helps",
      "hope this helps",
    ]);
    expect(findFillers("Insgesamt sieht es gut aus.")).toEqual(["insgesamt"]);
    expect(gradeVoice("Gute Frage! Dein Puls liegt bei 61.").passed).toBe(
      false,
    );
  });

  it("fails a warm-up opening", () => {
    const grade = gradeVoice(
      "Let's take a look at your sleep. You averaged 6 h 40 min this week.",
    );
    expect(grade.warmUpOpening).toBe(true);
    expect(grade.passed).toBe(false);
  });

  it("fails a habitual closing question", () => {
    const grade = gradeVoice(
      "You slept 6 h 40 min on average this week, a little under your usual. How does that match how you felt?",
    );
    expect(grade.closingQuestion).toBe(true);
    expect(grade.passed).toBe(false);
  });

  it("fails two next steps", () => {
    const grade = gradeVoice(
      "Your resting pulse is up 4 bpm this week. Try an earlier night. You could also consider a lighter workout tomorrow.",
    );
    expect(grade.nextSteps).toBe(2);
    expect(grade.passed).toBe(false);
  });

  it("fails an answer over the length band", () => {
    const long = Array.from({ length: 130 }, () => "word").join(" ") + ".";
    expect(gradeVoice(long).withinLength).toBe(false);
    expect(gradeVoice(long, "detailed").withinLength).toBe(true);
    const brief = Array.from({ length: 80 }, () => "word").join(" ") + ".";
    expect(gradeVoice(brief, "brief").withinLength).toBe(false);
  });

  it("fails an emoji", () => {
    expect(gradeVoice("Your weight is steady at 78 kg. 💪").emoji).toBe(true);
  });

  it("counts words, not numbers glued to units", () => {
    expect(countWords("131/84 mmHg over 30 days")).toBe(5);
  });
});

describe("voice golden cases", () => {
  const voiceCases = GOLDEN_CASES.filter((c) => c.taxonomy === "voice");

  it("cover German and English, the brief length and memory", () => {
    expect(voiceCases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "voice-de-bp-reference",
        "voice-en-bp-reference",
        "voice-en-brief",
        "voice-de-one-step",
        "voice-en-memory-once",
      ]),
    );
  });

  it("fail a reply with filler, a closing question and a menu of steps", () => {
    const testCase = voiceCases.find((c) => c.id === "voice-en-bp-reference")!;
    const grade = gradeCase(testCase, {
      id: testCase.id,
      prose:
        "Great question! Overall your blood pressure is fine. Try sleeping more. You could also walk daily. Let me know how it goes?",
      toolPayloads: [testCase.snapshotSections],
    });
    expect(grade.passed).toBe(false);
    const failed = grade.criteria.filter((c) => !c.passed).map((c) => c.label);
    expect(failed).toEqual(
      expect.arrayContaining([
        "uses no filler phrase from the banned list",
        "offers at most one next step",
        "does not end on a habitual question",
        "the first sentence answers the question, without a warm-up",
      ]),
    );
  });

  it("fail a confidence ruler on a plain action question", () => {
    const testCase = voiceCases.find((c) => c.id === "voice-de-one-step")!;
    const grade = gradeCase(testCase, {
      id: testCase.id,
      prose:
        "Diese Woche hast du im Mittel 6 h 12 min geschlafen. Leg das Handy um 22 Uhr weg. Wie sicher bist du dir auf einer Skala von 0 bis 10.",
      toolPayloads: [testCase.snapshotSections],
    });
    expect(grade.passed).toBe(false);
  });
});
