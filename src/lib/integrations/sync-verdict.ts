/**
 * Server-side sync-health verdict — the one place liveness is decided.
 *
 * The ledger (`src/lib/integrations/status.ts`) records what the last sync
 * attempt DID. It has no way to express what an attempt is no longer doing:
 * `error_transient` documents itself as "the sync entry-point still attempts on
 * the next run", yet a row can sit at that value for a month while nothing runs
 * at all — and nothing anywhere read the AGE of `lastAttemptAt`, so the state
 * was unrepresentable. A provider that had stopped even trying looked exactly
 * like one that was retrying every hour.
 *
 * This module derives the missing verdict as a read-side projection. It writes
 * nothing, adds no cron, and cannot desynchronise from the row it reads. The
 * status envelope computes it per entry from data it already has in hand (zero
 * additional queries) and every consumer — the Settings cards, the fallback
 * row, the MCP status tool — renders the same answer.
 *
 * The module is deliberately pure: no Prisma import, no I/O, `import type` only.
 * That keeps it importable from client components (the pill mapper reads the
 * verdict union) without dragging the database client into the browser bundle.
 */
import type { IntegrationKey } from "./status";

/**
 * The eight verdicts, from healthiest to least.
 *
 *   fresh              → syncing, data is current.
 *   stale              → syncing (or push-fed) but no new data for a while.
 *                        The primary arm for push-based Apple Health.
 *   stalled            → no sync ATTEMPT for longer than the cadence allows.
 *                        Not "failing" — not being tried at all.
 *   failing            → attempting and erroring (transient or persistent).
 *   reauth_required    → the grant is gone; the user must reconnect.
 *   parked             → paused after a persistent failure streak; needs a
 *                        manual resume.
 *   pending_first_sync → connected/configured but no attempt has been made yet.
 *   disconnected       → no live connection.
 */
export type SyncVerdict =
  | "fresh"
  | "stale"
  | "stalled"
  | "failing"
  | "reauth_required"
  | "parked"
  | "pending_first_sync"
  | "disconnected";

/** The verdict plus the instant that triggered it (null when nothing did). */
export interface SyncHealth {
  verdict: SyncVerdict;
  since: string | null;
}

/**
 * How long a polled integration may go without a sync ATTEMPT before it counts
 * as stalled. 24 h is roughly 24 missed hourly ticks — unambiguous, and
 * tolerant of a maintenance window or a slow redeploy.
 */
export const ATTEMPT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long a polled integration may go without new DATA before it counts as
 * stale. Near-unreachable for the hourly cohort by construction (every tick
 * either stamps a success or flips the row to an error state), so it stands as
 * defence rather than as the primary signal.
 */
export const DATA_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Apple Health is push-based: the iOS app delivers, nothing here polls. Seven
 * days is the "this pipe is not delivering" line. Shorter windows false-alarm
 * on normal iOS background-delivery gaps (low storage, app unopened, budget
 * exhausted), and a wrong warning on the flagship integration costs more trust
 * than a few days of latency on a genuinely dead one.
 */
export const APPLE_HEALTH_DATA_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A metric type that has not been seen for this long, while the integration
 * around it reads healthy, is the dead-pipe signature. Deliberately generous:
 * a weekly weigher must not be warned after a holiday.
 */
export const METRIC_QUIET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** Per-cohort expectation. `attemptStaleAfterMs: null` = no attempt concept. */
export interface SyncCadence {
  attemptStaleAfterMs: number | null;
  dataStaleAfterMs: number;
}

/** Hourly cron cohort — every integration with a ledger row. */
export const POLLED_CADENCE: SyncCadence = {
  attemptStaleAfterMs: ATTEMPT_STALE_AFTER_MS,
  dataStaleAfterMs: DATA_STALE_AFTER_MS,
};

/** Apple Health — the iOS app pushes; there is nothing to "attempt". */
export const PUSH_CADENCE: SyncCadence = {
  attemptStaleAfterMs: null,
  dataStaleAfterMs: APPLE_HEALTH_DATA_STALE_AFTER_MS,
};

/**
 * Dawarich runs once a night (`dawarich-sync`, 03:20). A run is overdue after
 * two days, and a successful run is the freshness: a phone that recorded
 * nothing is not a failing connection.
 */
const NIGHTLY_CADENCE: SyncCadence = {
  attemptStaleAfterMs: 2 * ATTEMPT_STALE_AFTER_MS,
  dataStaleAfterMs: DATA_STALE_AFTER_MS,
};

/**
 * Every `IntegrationKey` but Dawarich is polled by an hourly cron registered
 * in `src/lib/jobs/reminder/register-integration-sync.ts`; Dawarich nightly.
 * Apple Health is not an `IntegrationKey` — it takes `PUSH_CADENCE` directly.
 */
export const INTEGRATION_CADENCE: Record<IntegrationKey, SyncCadence> = {
  withings: POLLED_CADENCE,
  whoop: POLLED_CADENCE,
  fitbit: POLLED_CADENCE,
  nightscout: POLLED_CADENCE,
  polar: POLLED_CADENCE,
  oura: POLLED_CADENCE,
  "google-health": POLLED_CADENCE,
  strava: POLLED_CADENCE,
  dawarich: NIGHTLY_CADENCE,
  garmin: POLLED_CADENCE,
};

export interface SyncVerdictInput {
  /**
   * Whether a live connection exists (an OAuth token, a connection row). Pass
   * `undefined` for providers that carry no connection concept, so the ladder
   * falls through to `configured`.
   */
  connected?: boolean;
  /** Whether credentials / a URL are stored for this provider. */
  configured?: boolean;
  /** The ledger `state` string. */
  state?: string | null;
  lastSuccessAt?: string | Date | null;
  lastAttemptAt?: string | Date | null;
  /** A connection row's own `lastSyncedAt`, for rows predating the ledger. */
  legacyLastSyncedAt?: string | Date | null;
  /**
   * Start of the current unbroken failure streak, from the ledger. This is what
   * the error verdicts date themselves by. `lastAttemptAt` is the wrong anchor
   * — it is refreshed every hour by the retry itself, so a connection dead for
   * a fortnight reported "failing, just now". `lastSuccessAt` is nearly right
   * but a multi-leg provider can advance it while one leg stays broken.
   */
  failingSinceAt?: string | Date | null;
  /** Newest observed data instant, when the caller knows it (Apple Health). */
  lastDataAt?: string | Date | null;
  cadence: SyncCadence;
  now?: Date | number;
}

function toMillis(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Newest of the supplied instants, or null when they are all absent. */
function newest(...values: Array<number | null>): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value == null) continue;
    if (max == null || value > max) max = value;
  }
  return max;
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Resolve the sync-health verdict. First match wins.
 *
 * The `stalled` arm deliberately outranks `failing`: a row frozen at
 * `error_transient` for a month is not failing, it is not being tried — the
 * exact contradiction of the state's own documented contract.
 *
 * Two arms are refinements over the pure-ledger ladder, and they preserve what
 * the cards already rendered: an explicit `connected === false` and an explicit
 * `state === "disconnected"` both short-circuit to `disconnected`. Without them
 * a provider whose credentials are still stored after a disconnect would age
 * into `stalled` and claim its sync had stopped, when the user stopped it.
 */
export function resolveSyncVerdict(input: SyncVerdictInput): SyncHealth {
  const nowMs =
    input.now == null
      ? Date.now()
      : input.now instanceof Date
        ? input.now.getTime()
        : input.now;

  const lastSuccess = toMillis(input.lastSuccessAt);
  const lastAttempt = toMillis(input.lastAttemptAt);
  const legacy = toMillis(input.legacyLastSyncedAt);
  const lastData = toMillis(input.lastDataAt);
  const failingSince = toMillis(input.failingSinceAt);

  // 1. No live connection, or one the user explicitly ended.
  if (input.connected === false)
    return { verdict: "disconnected", since: null };
  if (!input.connected && !input.configured) {
    return { verdict: "disconnected", since: null };
  }
  if (input.state === "disconnected") {
    return { verdict: "disconnected", since: null };
  }

  // 2. States the user has to act on, in order of specificity.
  if (input.state === "parked") {
    return { verdict: "parked", since: iso(failingSince ?? lastAttempt) };
  }
  if (input.state === "error_reauth") {
    return {
      verdict: "reauth_required",
      since: iso(failingSince ?? lastAttempt),
    };
  }

  // 3. Nothing has ever run and nothing has ever arrived — the honest reading
  //    of the "connected, never attempted" synthetic ledger snapshot, and of a
  //    push source that has yet to deliver its first sample.
  if (newest(lastAttempt, lastSuccess, legacy, lastData) == null) {
    return { verdict: "pending_first_sync", since: null };
  }

  // 4. Polled cohort only: has it even tried lately?
  const attemptWindow = input.cadence.attemptStaleAfterMs;
  if (attemptWindow != null) {
    const lastTouch = newest(lastAttempt, lastSuccess);
    if (lastTouch != null && nowMs - lastTouch > attemptWindow) {
      return { verdict: "stalled", since: iso(lastTouch) };
    }
  }

  // 5. Trying and erroring. `since` dates the streak, not the last retry: this
  //    is the field the card renders, and "failing since a minute ago" on a
  //    connection that last delivered a fortnight back is the sentence this
  //    whole path exists to stop.
  if (input.state === "error_transient") {
    return { verdict: "failing", since: iso(failingSince ?? lastSuccess) };
  }

  // 6. Running, but nothing new is arriving. The primary arm for push sources.
  const lastFresh = newest(lastSuccess, legacy, lastData);
  if (lastFresh != null && nowMs - lastFresh > input.cadence.dataStaleAfterMs) {
    return { verdict: "stale", since: iso(lastFresh) };
  }

  return { verdict: "fresh", since: null };
}

/**
 * Metric types that are irregular by nature. A fixed quiet-window would
 * false-positive on every one of them, so they render their honest timestamp
 * and never tint. Starting list, tunable — the fuller per-type cadence model
 * stays the deferred follow-up.
 */
export const SPARSE_METRIC_TYPES: ReadonlySet<string> = new Set([
  // Measured only when the user steps on a body-composition scale that
  // supports them, or during an occasional fitness test.
  "VO2_MAX",
  "VASCULAR_AGE",
  "PULSE_WAVE_VELOCITY",
  "SIX_MINUTE_WALK_DISTANCE",
  "FALL_COUNT",
  // Event types: fired by the device only when something happens. Silence is
  // the healthy reading.
  "IRREGULAR_RHYTHM_NOTIFICATION",
  "HIGH_HEART_RATE_EVENT",
  "LOW_HEART_RATE_EVENT",
  "WALKING_STEADINESS_EVENT",
  "BREATHING_DISTURBANCE_EVENT",
  "AUDIO_EXPOSURE_EVENT",
  // People train irregularly; a quiet training week is not a broken pipe.
  "WORKOUTS",
  // As-needed and paused medications leave weeks without a dose by design.
  "MEDICATION_DOSE",
]);

/** The pseudo-type carrying a source's newest workout, next to its metrics. */
export const WORKOUT_FRESHNESS_TYPE = "WORKOUTS";

/**
 * The pseudo-type carrying Apple Health medication doses on the Apple Health
 * freshness list (v1.42.4), and their key in the per-type arrival ledger.
 */
export const MEDICATION_DOSE_FRESHNESS_TYPE = "MEDICATION_DOSE";

/** Newest recorded reading for one `(source, type)` pair, as queried. */
export interface MetricFreshnessSample {
  /**
   * The `MeasurementType` (e.g. "RESPIRATORY_RATE"), `WORKOUTS`, or
   * `MEDICATION_DOSE` on the Apple Health list.
   */
  type: string;
  /** ISO timestamp of the newest (non-deleted) reading for this metric. */
  lastSeenAt: string;
}

/** A sample plus the server's staleness verdict for it. */
export interface MetricFreshnessEntry extends MetricFreshnessSample {
  /**
   * The metric has gone quiet while the integration around it reads healthy.
   * Only ever true when the provider verdict is `fresh` — see
   * `classifyMetricFreshness`.
   */
  stale: boolean;
  /**
   * Apple Health types the app writes back to the phone only (#1247): the
   * newest reading entered here rather than arriving from Apple Health, or
   * null when there is none. Absent on every other entry.
   */
  lastEnteredHereAt?: string | null;
}

/**
 * Attach the per-metric staleness flag.
 *
 * A metric silent for weeks WHILE the pipe is otherwise green is the dead-pipe
 * signature: a per-collection 403, an upstream envelope drift, a revoked
 * per-type permission. When the provider itself is stalled / failing / stale
 * every metric ages together, so tinting them would only restate what the pill
 * already says — the entries stay neutral and the provider verdict carries the
 * story.
 */
export function classifyMetricFreshness(
  samples: readonly MetricFreshnessSample[],
  verdict: SyncVerdict,
  now: Date | number = Date.now(),
  enteredHere?: ReadonlyMap<string, string | null>,
): MetricFreshnessEntry[] {
  const nowMs = now instanceof Date ? now.getTime() : now;
  return samples.map((sample) => {
    // A type the app writes back to the phone (#1247): what is entered here
    // goes to Apple Health and never arrives back, so a person who keeps
    // their readings here would otherwise watch the type go quiet. That
    // reading is in Apple Health too, so the newer of the two is the type's
    // newest reading: it is what the row shows and what the verdict reads.
    const written = enteredHere?.has(sample.type)
      ? { lastEnteredHereAt: enteredHere.get(sample.type) ?? null }
      : {};
    const seen = newest(
      toMillis(sample.lastSeenAt),
      toMillis(written.lastEnteredHereAt),
    );
    const resolved = {
      ...sample,
      ...written,
      lastSeenAt:
        seen != null ? new Date(seen).toISOString() : sample.lastSeenAt,
    };
    if (verdict !== "fresh" || SPARSE_METRIC_TYPES.has(sample.type)) {
      return { ...resolved, stale: false };
    }
    return {
      ...resolved,
      stale: seen != null && nowMs - seen > METRIC_QUIET_AFTER_MS,
    };
  });
}
