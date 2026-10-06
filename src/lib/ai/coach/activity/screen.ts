/**
 * v1.41 — the screen model text passes before it rides a trail entry.
 *
 * A reasoning title, a reasoning summary and a checkpoint sentence are model
 * text shown to the person, so each goes through what a reply goes through:
 *
 *   - the outbound screen (`screenCoachReply`): a dose instruction, a
 *     diagnosis or a risk score drops the text;
 *   - the refusal detector: an instruction smuggled into the text drops it;
 *   - the number check: every figure must be one the turn read, checked
 *     against the same grounding ledger the reply is checked against, but
 *     strictly — a figure that does not reconcile drops the whole text rather
 *     than being elided, because a half-sentence in the trail helps nobody;
 *   - length: a title is cut to 80 characters at a word, a text to 400.
 *
 * Dropped text leaves the entry with its catalog label alone. Nothing here
 * throws: a screen that cannot decide drops the text.
 */
import type { Locale } from "@/lib/i18n/config";
import { screenCoachReply } from "@/lib/ai/coach/outbound-guard";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import { buildGroundingLedger } from "@/lib/ai/coach/grounding-ledger";
import { findUnverifiedCoachNumbersInLedger } from "@/lib/ai/coach/coach-prose-grounding";

import { ACTIVITY_TEXT_MAX_CHARS, ACTIVITY_TITLE_MAX_CHARS } from "./contract";

export interface ActivityScreenContext {
  locale: Locale;
  /**
   * The figures the turn has read so far (the present tool payloads). A
   * getter: the set grows with every round, and a text is checked against
   * what was read by the time it arrived.
   */
  figures: () => readonly unknown[];
  /** The person's own message: figures they stated may be repeated. */
  userMessage?: string;
  /** Scheduled doses, which the dose screen lets through. */
  scheduleDoses?: readonly number[];
}

/** Markdown emphasis, headings and list marks, which the trail never renders. */
function plain(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Cut at the last word boundary that fits, with an ellipsis. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

function passes(text: string, ctx: ActivityScreenContext): boolean {
  try {
    if (screenCoachReply(text, ctx.locale, ctx.scheduleDoses).block) {
      return false;
    }
    if (detectRefusal({ message: text, locale: ctx.locale }).refuse) {
      return false;
    }
    if (/\d/.test(text)) {
      const ledger = buildGroundingLedger({
        toolPayloads: ctx.figures(),
        priorUserMessages: ctx.userMessage ? [ctx.userMessage] : [],
        scheduleDoses: ctx.scheduleDoses,
      });
      const unverified = findUnverifiedCoachNumbersInLedger(
        text,
        ledger,
        ctx.locale,
        { gradeAgainstEmptyLedger: true },
      );
      if (unverified.length > 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A reasoning title or a checkpoint sentence: the first line, plain, at most
 * 80 characters. Null when nothing is left or the screen drops it.
 */
export function screenActivityTitle(
  raw: string | null | undefined,
  ctx: ActivityScreenContext,
): string | null {
  if (!raw) return null;
  const firstLine = plain(raw)
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const title = cut(firstLine, ACTIVITY_TITLE_MAX_CHARS);
  return passes(title, ctx) ? title : null;
}

/**
 * A reasoning summary for one round: plain, paragraphs kept, at most 400
 * characters. Null when nothing is left or the screen drops it.
 */
export function screenActivityText(
  raw: string | null | undefined,
  ctx: ActivityScreenContext,
): string | null {
  if (!raw) return null;
  const text = cut(
    plain(raw)
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
      .filter((p) => p.length > 0)
      .join("\n\n"),
    ACTIVITY_TEXT_MAX_CHARS,
  );
  if (!text) return null;
  return passes(text, ctx) ? text : null;
}

/**
 * The first sentence of a checkpoint (assistant text that came beside tool
 * calls), screened like a title.
 */
export function screenCheckpoint(
  raw: string | null | undefined,
  ctx: ActivityScreenContext,
): string | null {
  if (!raw) return null;
  const sentence = plain(raw).split(/(?<=[.!?])\s+/)[0] ?? "";
  return screenActivityTitle(sentence, ctx);
}
