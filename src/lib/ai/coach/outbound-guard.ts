/**
 * Coach OUTBOUND safety screen — the conversational surface's binding of the
 * shared screen in `@/lib/ai/safety/outbound-screen`.
 *
 * `detectRefusal()` guards the INBOUND channel (the user's message) only. The
 * model's reply was tokenised and streamed verbatim with no equivalent
 * server-side check, so a dose-prescription ("step up to 2.4 mg") or a
 * fabricated risk score in the assistant turn reached the user unfiltered. The
 * GLP-1 dose-safety contract and grounding block are composed into the Coach
 * system prompt, but those are instructions, not enforcement.
 *
 * The chat route already buffers the full reply before streaming (the provider
 * clients return the body in one shot, then `tokeniseForStreaming` chunks it
 * for the UI), so the screen runs on the assembled reply BEFORE persistence and
 * streaming. That buffer-then-screen order is load-bearing: every token the
 * client can see is post-guard.
 *
 * SURFACE POLICY — REPLACE. The Coach is a synchronous, user-initiated turn.
 * The user is waiting on an answer, so silence would read as a failure; on a
 * trip the route swaps in a calm "talk to your prescriber" fallback turn. This
 * is the policy every user-initiated surface uses (see the document summary);
 * background-generated cached surfaces WITHHOLD instead.
 *
 * The pattern banks, their six-locale coverage, and the false-positive posture
 * all live in the shared module — this file owns only the Coach's contract
 * selection and its fallback copy.
 */
import type { Locale } from "@/lib/i18n/config";
import {
  screenModelOutput,
  CONVERSATIONAL_CONTRACTS,
  type OutboundReason,
} from "@/lib/ai/safety/outbound-screen";

/**
 * Why the outbound reply was blocked, for the Wide-Event annotation. The Coach
 * enforces the conversational contracts only, so `causal_claim` (GROUND RULE
 * 12, an insights-surface rule) is never produced here.
 */
export type CoachOutboundReason = Extract<
  OutboundReason,
  "dose_prescription" | "risk_score"
>;

export interface CoachOutboundDecision {
  /** True when the assembled reply must be replaced with the fallback. */
  block: boolean;
  /** Which screen tripped — drives Wide-Event metadata. */
  reason: CoachOutboundReason | null;
}

/**
 * Screen an assembled assistant reply against the conversational contracts in
 * the reader's locale.
 *
 * v1.32.9 (Coach Guard II / G3) — `scheduleDoses` optionally gates the dose
 * continuation exemption on the user's actual schedule: a "keep taking your
 * N mg" is trusted only when N is a dose the user is on. Omitted by the
 * non-Coach callers (nudge / reaction-line), which keep the phrase-anchored
 * Guard I behaviour.
 *
 * `medicationNames` optionally makes the person's own medication names count
 * as medication nouns in the dose-change class, so "skip the Eliquis" or
 * "take an extra ramipril" blocks like "skip your dose". Omitted, the class
 * still knows the dosage-form words, the drug-class words and the common
 * generic-name stems.
 */
export function screenCoachReply(
  reply: string,
  locale: Locale,
  scheduleDoses?: readonly number[],
  medicationNames?: readonly string[],
): CoachOutboundDecision {
  const decision = screenModelOutput(reply, locale, CONVERSATIONAL_CONTRACTS, {
    scheduleDoses,
    medicationNames,
  });
  return {
    block: decision.block,
    reason: (decision.reason as CoachOutboundReason | null) ?? null,
  };
}

/**
 * Safe fallback copy when the outbound screen trips. de/en carry a native
 * body; the other UI locales ride the EN body (the Coach itself replies in
 * de/en, so this is the consistent posture with the inbound refusal copy).
 * Exposed as constants so server-only code (tests, logs) can pin the wording.
 */
export const COACH_OUTBOUND_DOSE_BLOCK_EN =
  "I can't suggest a specific medication dose or a change to one — dose decisions belong with your prescribing clinician. I can help you read what your own data shows around your medication; ask me about that and I'll stay grounded in your numbers.";

export const COACH_OUTBOUND_DOSE_BLOCK_DE =
  "Eine konkrete Medikamenten-Dosis oder eine Dosisänderung kann ich nicht vorschlagen — solche Entscheidungen gehören zu deiner behandelnden Ärztin oder deinem Arzt. Gerne helfe ich dir, das zu lesen, was deine eigenen Daten rund um deine Medikation zeigen; frag mich danach, dann bleibe ich bei deinen Zahlen.";

export const COACH_OUTBOUND_RISK_BLOCK_EN =
  "I can't put a number on a clinical risk like that — it isn't something your tracked data lets me compute, and an invented figure would be misleading. I can walk you through what your own measurements are doing instead; ask me about a specific metric.";

const COACH_OUTBOUND_RISK_BLOCK_DE =
  "Eine solche klinische Risikozahl kann ich nicht angeben — deine erfassten Daten lassen das nicht berechnen, und ein erfundener Wert wäre irreführend. Stattdessen kann ich dir zeigen, was deine eigenen Messwerte machen; frag mich nach einer konkreten Metrik.";

/** Resolve the localised fallback copy for a tripped outbound screen. */
export function coachOutboundFallback(
  reason: CoachOutboundReason,
  locale: Locale,
): string {
  const de = locale === "de";
  if (reason === "dose_prescription") {
    return de ? COACH_OUTBOUND_DOSE_BLOCK_DE : COACH_OUTBOUND_DOSE_BLOCK_EN;
  }
  return de ? COACH_OUTBOUND_RISK_BLOCK_DE : COACH_OUTBOUND_RISK_BLOCK_EN;
}
