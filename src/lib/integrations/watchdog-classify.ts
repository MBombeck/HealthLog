/**
 * The integration watchdog's judgement, kept pure.
 *
 * Two questions per connection, answered from data the runner gathers:
 *
 *   1. Is a source that normally delivers unexpectedly silent?
 *      Only a CONTINUOUS source can be: a wearable, a CGM, a phone that
 *      records steps all day. Its own history decides "normally": it must have
 *      delivered on at least `NORMAL_DELIVERY_MIN_DAYS` of the previous
 *      `HISTORY_DAYS` days. An ON-DEMAND source (a scale, a blood-pressure
 *      cuff, a workout log) is silent whenever its owner does not measure,
 *      which says nothing about the pipe, so silence never counts for it; it
 *      is watched for errors only.
 *
 *   2. Is there an incident the operator should hear about?
 *      Unexpected silence; or an `action_required` state, or a `degraded`
 *      one because the provider keeps erroring (`provider_errors`), that has
 *      lasted longer than `INCIDENT_AFTER_MS`; or a failure streak the sync
 *      ledger already paged about (adopted, so the operator still gets the
 *      one recovery note when it ends). `no_new_data` and `sync_stalled` on
 *      their own never page: they mostly mean the owner stopped using the
 *      source (an Apple Health account whose phone app has not run for a week
 *      reads as stale for good), which is nothing an operator can fix.
 *
 * One incident per connection at a time. It is announced once and closed once;
 * a change of reason while it is open (silence turning into a reauth) is the
 * same incident and sends nothing.
 */
import type {
  ConnectionHealth,
  ConnectionHealthReason,
  ConnectionKey,
} from "./connection-health";
import {
  HISTORY_DAYS,
  MIN_DELIVERY_DAYS,
  judgeStall,
  type Cadence,
} from "@/lib/sync-stall/cadence";

/**
 * - `continuous`: worn or attached around the clock. Its silence is flagged,
 *   told to the owner once (`src/lib/sync-stall/notice.ts`) and is an operator
 *   incident.
 * - `habitual`: measured by hand, but often daily (a scale, a sleep mat). Its
 *   silence is flagged and told to the owner when its own history says it
 *   delivers daily, and is never an operator incident: a person who stops
 *   weighing themselves is nothing an operator can fix.
 * - `on_demand`: silence never counts; watched for errors only.
 */
export type SourceCadenceKind = "continuous" | "habitual" | "on_demand";

export interface SourceProfile {
  kind: SourceCadenceKind;
  /**
   * The least a continuous source may go without data before silence counts:
   * the floor of the stall rule. A source whose own cadence is slower waits
   * longer (`stallThresholdMs`).
   */
  silenceWindowMs: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How many days of a connection's own history decide "normally delivers", and
 * how many of them must have data. The stall rule's own constants
 * (`src/lib/sync-stall/cadence.ts`), so the watchdog, the owner's stall notice
 * and the web read one rule.
 */
export { HISTORY_DAYS };
export const NORMAL_DELIVERY_MIN_DAYS = MIN_DELIVERY_DAYS;

/** Whether a flagged silence of this source is an operator incident. */
export function silenceIsIncident(profile: SourceProfile): boolean {
  return profile.kind === "continuous";
}

/** How long a non-ok health state must last before it is an operator incident. */
export const INCIDENT_AFTER_MS = DAY_MS;

/**
 * Per connection. Strava is workouts: on-demand, watched for errors only.
 * Withings is mostly scales, cuffs and sleep mats: habitual, so a person who
 * weighs in every morning hears once when it stops, and nobody else does.
 * Everything worn or attached around the clock is continuous.
 *
 * The window is how long a continuous source may stay quiet before silence
 * counts, and it follows how each source actually delivers:
 *
 *   - 24 h for wearables and CGMs whose cloud receives data on its own
 *     (Google Health, Polar, Nightscout).
 *   - 48 h for Oura, WHOOP and Garmin. Their rings and straps upload only when the
 *     phone app is opened, so a day without opening it is ordinary and must
 *     not page anyone.
 *   - 48 h for Apple Health. iOS defers background delivery when the phone is
 *     low on storage, in low-power mode or simply not unlocked, and a day of
 *     that is ordinary too.
 *
 * Dawarich is on-demand as well: it records where a phone was, and a phone
 * left at home or switched off for days is ordinary. It is watched for
 * errors only, never for silence.
 *
 * The history gate already limits the check to sources that deliver almost
 * daily; the window only decides how long a gap is ordinary.
 */
export const SOURCE_PROFILES: Record<ConnectionKey, SourceProfile> = {
  // A day without stepping on the scale is ordinary, so two days at least.
  withings: { kind: "habitual", silenceWindowMs: 2 * DAY_MS },
  strava: { kind: "on_demand", silenceWindowMs: DAY_MS },
  whoop: { kind: "continuous", silenceWindowMs: 2 * DAY_MS },
  oura: { kind: "continuous", silenceWindowMs: 2 * DAY_MS },
  "google-health": { kind: "continuous", silenceWindowMs: DAY_MS },
  polar: { kind: "continuous", silenceWindowMs: DAY_MS },
  nightscout: { kind: "continuous", silenceWindowMs: DAY_MS },
  dawarich: { kind: "on_demand", silenceWindowMs: DAY_MS },
  // A Garmin watch uploads through the phone app like the rings and straps,
  // so a day without opening it is ordinary.
  garmin: { kind: "continuous", silenceWindowMs: 2 * DAY_MS },
  // The folder fetch delivers whatever the phone last exported; a phone
  // that exported nothing new is ordinary. Errors only, like Dawarich.
  "health-connect-remote": { kind: "on_demand", silenceWindowMs: DAY_MS },
  "apple-health": { kind: "continuous", silenceWindowMs: 2 * DAY_MS },
};

/** Incident reason codes. The silence one is the watchdog's own. */
export type IncidentReason = ConnectionHealthReason;

export interface WatchRow {
  silentSince: Date | null;
  incidentReason: string | null;
  incidentOpenedAt: Date | null;
  alertedAt: Date | null;
}

export interface SilenceInput {
  profile: SourceProfile;
  /** Newest data instant, or null when the source never delivered. */
  lastDataAt: Date | null;
  /**
   * The cadence learned from the `HISTORY_DAYS` before the silence window
   * (`learnCadence`), or null when the runner has not read it (it only does
   * when needed).
   */
  cadence: Cadence | null;
  /** The current flag, so an already-flagged source is not re-judged hourly. */
  currentSilentSince: Date | null;
  now: Date;
}

export type SilenceVerdict =
  /** Data is inside the window (or the source is on-demand): no flag. */
  | { kind: "clear" }
  /** Silent, and the history has to be read before deciding. */
  | { kind: "needs_history" }
  /** Silent, and the history says it should not be. */
  | { kind: "flag"; silentSince: Date }
  /** Silent, but it does not normally deliver: the owner is not using it. */
  | { kind: "not_expected" };

/**
 * Decide the silence flag by the stall rule (`judgeStall`): quiet past the
 * floor and past its own cadence, with a history that says it delivers. The
 * cadence is only needed for a silent, not-yet-flagged source (the
 * hourly pass reads it lazily) and for a re-check of a flag (the daily pass
 * passes it so a source its owner has stopped using drops out once its history
 * no longer says it delivers).
 */
export function classifySilence(input: SilenceInput): SilenceVerdict {
  const { profile, lastDataAt, now } = input;
  if (profile.kind === "on_demand") return { kind: "clear" };
  const verdict = judgeStall({
    floorMs: profile.silenceWindowMs,
    lastAt: lastDataAt,
    cadence: input.cadence,
    now,
  });
  switch (verdict.kind) {
    case "fresh":
    case "within_cadence":
      return { kind: "clear" };
    case "needs_history":
      // Already flagged and nothing asked for a re-check: keep the flag as is.
      if (input.currentSilentSince) {
        return { kind: "flag", silentSince: input.currentSilentSince };
      }
      return { kind: "needs_history" };
    case "not_expected":
      return { kind: "not_expected" };
    case "stalled":
      return {
        kind: "flag",
        silentSince: input.currentSilentSince ?? verdict.since,
      };
  }
}

/**
 * The incident condition right now, or null when there is none.
 *
 * `health` is the resolved connection health WITHOUT the watchdog's own
 * silence flag folded in, so the silence condition and the state condition
 * stay separate. `ledgerAlerted` is true while the sync ledger holds an
 * unresolved page for the current streak.
 */
export function currentIncident(input: {
  health: ConnectionHealth | null;
  silentSince: Date | null;
  ledgerAlerted: boolean;
  now: Date;
}): { reason: IncidentReason; since: Date } | null {
  const { health, silentSince, now } = input;
  if (health === null) return null;
  const troubled =
    health.state === "action_required" || health.state === "degraded";
  // What pages on its own: the owner has to act, or the provider errors. A
  // streak the ledger already paged about is followed whatever it reads as
  // now, so its end is still reported.
  const pages =
    health.state === "action_required" ||
    (health.state === "degraded" && health.reason === "provider_errors");
  if (troubled && (pages || input.ledgerAlerted)) {
    // A provider-side reauth flag (Google Health) can stand without a ledger
    // streak to date it; the last success is then when it last worked.
    const sinceIso = health.since ?? health.lastSuccessAt;
    const since = sinceIso ? new Date(sinceIso) : null;
    const lasted =
      since !== null && now.getTime() - since.getTime() > INCIDENT_AFTER_MS;
    if (lasted || input.ledgerAlerted) {
      return { reason: health.reason, since: since ?? now };
    }
  }
  if (silentSince) {
    return { reason: "unexpected_silence", since: silentSince };
  }
  return null;
}

/**
 * The `alertedAt` an incident gets when the watchdog's first pass after a
 * deploy found it already standing: counted as announced, so it is never
 * paged, but never actually sent either, so its end sends no recovery note.
 * The epoch, because no real announcement can carry it, and it keeps the
 * marker inside the existing row.
 */
export const FIRST_RUN_ALERTED_AT = new Date(0);

/** Whether an `alertedAt` records a message that was really sent. */
export function wasAnnounced(alertedAt: Date | null | undefined): boolean {
  return (
    alertedAt != null && alertedAt.getTime() !== FIRST_RUN_ALERTED_AT.getTime()
  );
}

export type WatchTransition =
  /** No incident before, none now. */
  | { kind: "none" }
  /** A new incident: announce it. */
  | { kind: "open"; reason: IncidentReason; since: Date }
  /** A new incident the ledger already announced: record it, send nothing. */
  | { kind: "adopt"; reason: IncidentReason; since: Date }
  /** Still open: send nothing. `announce` when the open incident was never announced (no channel last time). */
  | { kind: "keep"; reason: IncidentReason; announce: boolean }
  /** Over. `notify` when the operator had been told it started. */
  | { kind: "close"; notify: boolean; previousReason: string };

/**
 * Compare the open incident (if any) with the current condition. Pure; the
 * runner performs the side effects.
 */
export function decideWatchTransition(input: {
  row: WatchRow | null;
  incident: { reason: IncidentReason; since: Date } | null;
  ledgerAlerted: boolean;
}): WatchTransition {
  const open = input.row?.incidentReason ?? null;
  if (open === null) {
    if (input.incident === null) return { kind: "none" };
    return input.ledgerAlerted
      ? { kind: "adopt", ...input.incident }
      : { kind: "open", ...input.incident };
  }
  if (input.incident === null) {
    return {
      kind: "close",
      notify: wasAnnounced(input.row?.alertedAt),
      previousReason: open,
    };
  }
  return {
    kind: "keep",
    reason: input.incident.reason,
    announce: input.row?.alertedAt == null && !input.ledgerAlerted,
  };
}
