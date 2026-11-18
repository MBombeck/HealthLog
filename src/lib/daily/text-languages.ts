/**
 * #176 — which language each text of the daily digest is in.
 *
 * The server words most of the Today texts itself (the facts, the rail, the
 * deterministic lead) and does so in the reader's language on every request.
 * Two are model text stored once and served as they were written: the
 * briefing (its lead, its top signal, the line under the lead) and the
 * reaction line for the day's newest arrival. A reader whose app is in
 * another language than the one those were written in would otherwise get
 * them without knowing, so each carries its language, and the lead never
 * opens with a reaction line written in another language: it falls to a
 * source in the reader's language instead, which costs no model call.
 */
import type { Locale } from "@/lib/i18n/config";

import type { TodayLead, TodaySignalLine } from "@/lib/daily/today-overview";

export interface DigestTextLanguages {
  /** Every text the server words itself on this request. */
  response: Locale;
  /** The briefing texts (`briefingLead`, `topSignal`, `signalLine`). */
  briefing: string | null;
  /** `reactionLine`. Null when unknown. */
  reaction: string | null;
}

/** The reaction line the lead may use: none written in another language. */
export function reactionLineForLead(
  line: string | null,
  reactionLanguage: string | null,
  response: Locale,
): string | null {
  return reactionLanguage && reactionLanguage !== response ? null : line;
}

/** The lead and the line under it, each with the language it is in. */
export function withLanguages(
  lead: TodayLead | null,
  signalLine: TodaySignalLine | null,
  languages: DigestTextLanguages,
): { lead: TodayLead | null; signalLine: TodaySignalLine | null } {
  const of = (source: TodayLead["source"]): string | null =>
    source === "reaction"
      ? languages.reaction
      : source === "briefing"
        ? languages.briefing
        : languages.response;
  return {
    lead: lead && { ...lead, language: of(lead.source) },
    signalLine: signalLine && {
      ...signalLine,
      language: languages.briefing,
    },
  };
}
