/**
 * v1.41 — the Coach voice grader.
 *
 * Grades an answer against the voice section of the Coach prompt
 * (`buildCoachVoiceBlock` in `system-prompt.ts`): the length for the
 * person's setting, no filler from `COACH_FILLER_PHRASES`, no emoji, at most
 * one next step, no habitual closing question, an assumption in one line,
 * and a first sentence that answers rather than warms up.
 *
 * Deterministic and offline, so the golden set runs it on every change
 * against the reference answers, and the nightly live eval runs it against
 * real generations (`voiceCriteria` plugs into a golden case). Whether the
 * first sentence truly answers the question is a judgement; the
 * deterministic check here only catches the forms that never do (a
 * restated question, praise for the question, a preamble), and the live
 * judge weighs the rest under the same criterion label.
 *
 * Pure.
 */
import {
  COACH_ANSWER_WORDS,
  COACH_FILLER_PHRASES,
} from "@/lib/ai/coach/system-prompt";

import type { CoachEvalCriterion } from "./golden-cases";

export type VoiceLength = keyof typeof COACH_ANSWER_WORDS;

export interface VoiceGrade {
  words: number;
  withinLength: boolean;
  paragraphs: number;
  /** Filler phrases found, lower case. */
  fillers: string[];
  emoji: boolean;
  /** Sentences that read as a suggested next step. */
  nextSteps: number;
  /** The prose ends on a question. */
  closingQuestion: boolean;
  /** Lines that state an assumption ("Assumed: …"). */
  assumptionLines: number;
  /** The first sentence warms up instead of answering. */
  warmUpOpening: boolean;
  passed: boolean;
}

const EMOJI = /\p{Extended_Pictographic}/u;

/** Evidence and sentinel blocks are not prose. */
const SENTINEL_BLOCK = /---[A-Z-]+---[\s\S]*?---END---/g;

/** Openings that never answer: praise, restating, preamble. */
const WARM_UP_OPENING: readonly RegExp[] = [
  /^(?:great|good|excellent|interesting|nice)\s+question\b/i,
  /^(?:gute|tolle|spannende|interessante)\s+frage\b/i,
  /^(?:thanks|thank you)\s+for\s+asking\b/i,
  /^danke\s+(?:für\s+die|dass\s+du)\b/i,
  /^(?:let'?s|let me)\s+(?:take a look|look|dive|break)/i,
  /^(?:lass|lass uns)\s+(?:mich\s+)?(?:mal\s+)?(?:schauen|ansehen|anschauen)/i,
  /^you(?:'re| are)\s+asking\b/i,
  /^du\s+fragst\b/i,
  /^(?:sure|of course|absolutely|certainly)[,!.]/i,
  /^(?:klar|natürlich|gerne|sicher)[,!.]/i,
];

/** Sentences that suggest something to do. */
const NEXT_STEP: readonly RegExp[] = [
  /\b(?:one thing to try|try|consider|you could|you might|worth trying|a (?:small )?(?:step|experiment)|next step|how about)\b/i,
  /\b(?:ein versuch|versuch(?:e|s)?|probier\w*|du könntest|erwäge|ein (?:kleiner )?schritt|nächster schritt|wie wäre es)\b/i,
];

const ASSUMPTION_LINE = /^(?:assumed|angenommen)\s*:/i;

function prose(answer: string): string {
  return answer.replace(SENTINEL_BLOCK, "").trim();
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Filler phrases from the banned list that appear in the prose. */
export function findFillers(text: string): string[] {
  const lower = text.toLowerCase();
  const all = [...COACH_FILLER_PHRASES.en, ...COACH_FILLER_PHRASES.de];
  return all.filter((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}])${escaped}(?:$|[^\\p{L}])`, "u").test(
      lower,
    );
  });
}

/** Grade one answer for the person's length setting. */
export function gradeVoice(
  answer: string,
  length: VoiceLength = "standard",
): VoiceGrade {
  const text = prose(answer);
  const words = countWords(text);
  const band = COACH_ANSWER_WORDS[length];
  const paragraphs = text
    .split(/\n\s*\n/)
    .filter((p) => p.trim() && !ASSUMPTION_LINE.test(p.trim())).length;
  const lines = text.split("\n").map((l) => l.trim());
  const assumptionLines = lines.filter((l) => ASSUMPTION_LINE.test(l)).length;
  const body = lines.filter((l) => !ASSUMPTION_LINE.test(l)).join("\n");
  const all = sentences(body);
  const first = all[0] ?? "";
  const last = all[all.length - 1] ?? "";
  const nextSteps = all.filter((s) =>
    NEXT_STEP.some((re) => re.test(s)),
  ).length;
  const fillers = findFillers(text);
  const emoji = EMOJI.test(text);
  const closingQuestion = /\?\s*$/.test(last);
  const warmUpOpening = WARM_UP_OPENING.some((re) => re.test(first));
  const proseParagraphs = Math.max(1, paragraphs);
  // The ceiling is the floor that matters: an answer may be shorter than the
  // band (a redirect, a one-line state), never longer or more spread out.
  const withinLength = words <= band.max && proseParagraphs <= band.paragraphs;
  const passed =
    withinLength &&
    fillers.length === 0 &&
    !emoji &&
    nextSteps <= 1 &&
    !closingQuestion &&
    assumptionLines <= 1 &&
    !warmUpOpening;
  return {
    words,
    withinLength,
    paragraphs,
    fillers,
    emoji,
    nextSteps,
    closingQuestion,
    assumptionLines,
    warmUpOpening,
    passed,
  };
}

/**
 * The voice floor as golden-case criteria, one per rule, so a voice case is
 * graded by the same dispatcher as every other case and its labels reach the
 * live judge. `closingQuestionAllowed` is for a case whose right answer is a
 * clarifying question.
 */
export function voiceCriteria(
  opts: { length?: VoiceLength; closingQuestionAllowed?: boolean } = {},
): CoachEvalCriterion[] {
  const length = opts.length ?? "standard";
  const band = COACH_ANSWER_WORDS[length];
  const criteria: CoachEvalCriterion[] = [
    {
      kind: "mustInclude",
      weight: 2,
      matcher: (p) => gradeVoice(p, length).withinLength,
      label: `stays within ${band.max} words for the ${length} length`,
    },
    {
      kind: "mustAvoid",
      weight: 2,
      matcher: (p) => findFillers(prose(p)).length > 0,
      label: "uses no filler phrase from the banned list",
    },
    {
      kind: "mustAvoid",
      weight: 1,
      matcher: (p) => EMOJI.test(p),
      label: "uses no emoji",
    },
    {
      kind: "mustAvoid",
      weight: 2,
      matcher: (p) => gradeVoice(p, length).nextSteps > 1,
      label: "offers at most one next step",
    },
    {
      kind: "mustAvoid",
      weight: 2,
      matcher: (p) => gradeVoice(p, length).warmUpOpening,
      label: "the first sentence answers the question, without a warm-up",
    },
  ];
  if (!opts.closingQuestionAllowed) {
    criteria.push({
      kind: "mustAvoid",
      weight: 2,
      matcher: (p) => gradeVoice(p, length).closingQuestion,
      label: "does not end on a habitual question",
    });
  }
  return criteria;
}
