/**
 * v1.41 — the contract of a turn's live trail.
 *
 * The loop reports what it is doing through an {@link ActivityRecorder}: it
 * opens an entry before each phase starts (the thinking round before the
 * provider call, each fetch before its tool runs), updates it while it runs
 * (a reasoning title arriving, a count) and closes it. The recorder sends the
 * `activity` frames, screens model text before it goes anywhere, and at the
 * end hands back the plaintext metadata for `metricSource.activity` and the
 * model text for `coach_messages.trail_encrypted`.
 *
 * Labels are always catalog text rendered on the server; model text only ever
 * rides `title` and `text`. A `checkpoint` entry (assistant text that came
 * beside tool calls) is labelled with the thinking key and carries the
 * screened sentence as its title.
 *
 * The no-op recorder is what every caller holds until the real one is wired:
 * it sends nothing and stores nothing, so a turn behaves exactly as before.
 *
 * Client-safe: no server import.
 */
import type {
  CoachActivityMeta,
  CoachActivityPhase,
  CoachStepStatus,
  CoachStopReason,
  CoachTrail,
} from "@/lib/ai/coach/types";
import type { Locale } from "@/lib/i18n/config";
import { pluralKey } from "@/lib/i18n/plural";

/** The stored trail text of one message, as UTF-8 JSON, before encryption. */
export const TRAIL_MAX_BYTES = 16 * 1024;

/** A reasoning title or checkpoint sentence, after screening. */
export const ACTIVITY_TITLE_MAX_CHARS = 80;

/** A reasoning summary per round, after screening. */
export const ACTIVITY_TEXT_MAX_CHARS = 400;

/** `a1`..`a99`: the 100th entry of a turn is not recorded. */
export const ACTIVITY_MAX_ENTRIES = 99;

export interface ActivityStart {
  phase: CoachActivityPhase;
  round: number;
  labelKey: string;
  label: string;
  stepRef?: string;
  count?: number;
  stop?: CoachStopReason;
}

export interface ActivityPatch {
  /** Model text; screened by the recorder, dropped when it fails. */
  title?: string;
  /** Model text; screened by the recorder, dropped when it fails. */
  text?: string;
  /** A new catalog label (the digest count once the round has settled). */
  labelKey?: string;
  label?: string;
  count?: number;
}

export interface ActivityRecorder {
  /** Opens an entry, sends its `running` frame and returns its id. */
  start(entry: ActivityStart): string;
  /** Updates an open entry and sends the frame again. */
  update(id: string, patch: ActivityPatch): void;
  /** Closes an entry with its final status and duration. */
  finish(
    id: string,
    status: Exclude<CoachStepStatus, "running">,
    patch?: ActivityPatch,
  ): void;
  /** The entries so far, for `metricSource.activity`. */
  meta(): CoachActivityMeta[];
  /** The screened model text so far, or null when there is none. */
  trail(): CoachTrail | null;
}

/** Sends nothing, stores nothing: a turn runs exactly as it did before. */
export function createNoopActivityRecorder(): ActivityRecorder {
  return {
    start: () => "a1",
    update: () => undefined,
    finish: () => undefined,
    meta: () => [],
    trail: () => null,
  };
}

// ── Message keys ────────────────────────────────────────────────────────────

/** The labels with no count. */
export const COACH_ACTIVITY_KEYS = {
  thinking: "insights.coach.activity.thinking",
  fetching: "insights.coach.activity.fetching",
  remember: "insights.coach.activity.remember",
  plan: "insights.coach.activity.plan",
  asking: "insights.coach.activity.asking",
  answer: "insights.coach.activity.answer",
  /** The settled line of a turn that waits for the person's choice. */
  awaitingAnswer: "insights.coach.activity.awaitingAnswer",
} as const;

/** The `stop` entry's label, by reason. */
export const COACH_ACTIVITY_STOP_KEYS: Readonly<
  Record<CoachStopReason, string>
> = {
  budget: "insights.coach.activity.stop.budget",
  time: "insights.coach.activity.stop.time",
  cap: "insights.coach.activity.stop.cap",
  no_progress: "insights.coach.activity.stop.noProgress",
};

/** "Summarising N readings…", while a round's results are folded in. */
export function activityDigestKey(count: number, locale: Locale): string {
  return pluralKey("insights.coach.activity.digest", count, locale);
}

/** "N readings from {areas}", once the round has settled. */
export function activityDigestDoneKey(count: number, locale: Locale): string {
  return pluralKey("insights.coach.activity.digestDone", count, locale);
}

/** "N areas", the `{areas}` of the settled digest. */
export function activityAreasKey(count: number, locale: Locale): string {
  return pluralKey("insights.coach.activity.areas", count, locale);
}

/** "Recalls N things you told it". */
export function activityMemoryKey(count: number, locale: Locale): string {
  return pluralKey("insights.coach.activity.memory", count, locale);
}

/** The settled line once the turn is done: "Thought process · N steps". */
export function activityThoughtProcessKey(
  count: number,
  locale: Locale,
): string {
  return pluralKey("insights.coach.activity.thoughtProcess", count, locale);
}
