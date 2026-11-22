/**
 * #1404 — the vocabulary of a background AI failure the person can read.
 *
 * A background AI job (a document summary, a document read, the status notes,
 * the briefing, a workout note, a Coach nudge, ...) used to stop without a
 * word when its provider was down, its bound chain had nowhere to go or its
 * key was missing: the reason existed in a log line, never where the person
 * looks. The shared reporter (`./report.ts`) now records why, as one of the
 * closed codes below, and the document detail and Settings, AI render the
 * sentence for it.
 *
 * Pure: no I/O, safe for the client bundle, the routes and the guards alike.
 */
import type { AiCapabilityKey } from "@/lib/ai/capabilities/types";

/**
 * Every kind of background AI work that reports here, with the capability it
 * answers to. A kind is what the person recognises, not a queue name: the
 * automatic summary and a summary someone asked for are one kind.
 */
export const AI_JOB_CAPABILITY = {
  documentSummary: "documentAi",
  documentIndex: "documentAi",
  documentRead: "documentAi",
  labScan: "labsOcr",
  supplementLabel: "supplementLabel",
  statusText: "statusText",
  briefing: "briefing",
  periodNarrative: "periodNarrative",
  workoutInsight: "workoutInsights",
  reactionLine: "reactionLines",
  coachNudge: "coach",
  coachMemory: "coach",
} as const satisfies Record<string, AiCapabilityKey>;

export type AiJobKind = keyof typeof AI_JOB_CAPABILITY;

export const AI_JOB_KINDS = Object.keys(AI_JOB_CAPABILITY) as AiJobKind[];

/** The kinds whose work is about one document (`subjectId` = its id). */
export const DOCUMENT_AI_JOB_KINDS: ReadonlySet<AiJobKind> = new Set<AiJobKind>(
  ["documentSummary", "documentIndex", "documentRead"],
);

/**
 * Why the work stopped. Closed: the column holds nothing else, and every code
 * has a sentence in every locale (`settings.ai.jobFailures.code.<code>`).
 *
 *   - `no_provider`: no provider is set up that could do this work.
 *   - `chain_no_provider`: the work is bound to a named chain, and none of the
 *     chain's entries is set up (a removed key, a deleted provider).
 *   - `consent_required`: the provider needs a consent receipt and none is
 *     active.
 *   - `not_permitted`: the work may not run on this record.
 *   - `check_failed`: the server could not check whether the work may run.
 *   - `credential_expired`: the provider refused the key (401 / 403).
 *   - `rate_limited`: the provider said too many requests (429).
 *   - `provider_timeout`: the provider did not answer in time.
 *   - `provider_unreachable`: the provider could not be reached at all.
 *   - `provider_empty`: the provider answered with nothing.
 *   - `provider_reasoning_only`: the model reasoned and never answered.
 *   - `provider_paused`: the provider failed so often that background work
 *     waits before it tries again.
 *   - `provider_error`: any other provider failure.
 *   - `budget_exhausted`: today's AI allowance is used up.
 *   - `unreadable_file`: the file could not be turned into something the
 *     provider can read.
 */
export const AI_JOB_FAILURE_CODES = [
  "no_provider",
  "chain_no_provider",
  "consent_required",
  "not_permitted",
  "check_failed",
  "credential_expired",
  "rate_limited",
  "provider_timeout",
  "provider_unreachable",
  "provider_empty",
  "provider_reasoning_only",
  "provider_paused",
  "provider_error",
  "budget_exhausted",
  "unreadable_file",
] as const;

export type AiJobFailureCode = (typeof AI_JOB_FAILURE_CODES)[number];

/** How long a recorded failure stays readable without a newer one. */
export const AI_JOB_FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** One recorded failure, as the routes serve it. */
export interface AiJobFailureDto {
  job: AiJobKind;
  code: AiJobFailureCode;
  /** The document the work was for, or null. */
  documentId: string | null;
  /** The provider type that failed, when one was called. */
  providerType: string | null;
  /** Failures in a row since the last success. */
  failCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

export function isAiJobKind(value: string): value is AiJobKind {
  return Object.prototype.hasOwnProperty.call(AI_JOB_CAPABILITY, value);
}

export function isAiJobFailureCode(value: string): value is AiJobFailureCode {
  return (AI_JOB_FAILURE_CODES as readonly string[]).includes(value);
}
