/**
 * Per-(user, integration) sync-status bookkeeping.
 *
 * v1.4.15 Phase B2 introduces three responsibilities for every sync attempt:
 *
 *   1. Record success / failure timestamps so Settings → Integrations
 *      can show "last sync 23 minutes ago" instead of guessing from
 *      `lastSyncedAt` (which only updates on success and tells the user
 *      nothing about a 2-day failure streak).
 *   2. Emit one structured `AuditLog` row per failure — successes are
 *      not audited (would be noisy and `lastSuccessAt` already tracks
 *      them).
 *   3. After N consecutive failures (default 3), notify the admin via
 *      Telegram so a token-revoke or upstream outage doesn't silently
 *      strand a user's data. The dispatcher is reused as-is — B3 owns
 *      reliability/retry of the dispatcher; we are only a caller.
 *
 * The state machine is deliberately small:
 *
 *   connected         → happy path. cleared by recordSyncSuccess().
 *   error_transient   → at least one failure since last success. The
 *                       sync entry-point still attempts on the next
 *                       run (network blip, 5xx, etc.).
 *   error_reauth      → refresh-token grant has revoked. `getValidToken`
 *                       short-circuits until the user reconnects. Cleared
 *                       by markReconnected() on the OAuth callback.
 *   disconnected      → user clicked "Disconnect". Set explicitly by
 *                       the disconnect routes; clears any prior error
 *                       state.
 *
 * `state` is stored as a free-form string column (not a Postgres enum)
 * so adding new sentinels in v1.5 doesn't require a migration.
 */
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { auditLog } from "@/lib/auth/audit";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  dispatchNotification,
  type DispatchOutcome,
} from "@/lib/notifications/dispatcher";
import type { IntegrationClassification } from "@/lib/integrations/http-status-classifier";

export type IntegrationKey =
  | "withings"
  | "whoop"
  | "fitbit"
  // v1.17.0 — Nightscout glucose (F1) + Polar / Oura OAuth (F4).
  | "nightscout"
  | "polar"
  | "oura"
  // v1.27.0 — Google Health (Fitbit + Pixel Watch + Fitbit Air) via the
  // successor Google Health API. Separate connection from the classic
  // `fitbit` transport, which sunsets Sept 2026.
  | "google-health"
  // v1.28.x — Strava OAuth workout source.
  | "strava";

/**
 * Failure kinds carried into `recordSyncFailure`.
 *
 *   - `transient`        : retry on the next sync; user not blocked.
 *   - `reauth_required`  : permanent revoke / invalid_grant; park at
 *                          `error_reauth` until the user reconnects.
 *   - `persistent`       : contract mismatch (invalid params, missing
 *                          field, unknown action). Surfaces in the
 *                          integration-status card AND audit log so an
 *                          operator can investigate, but does NOT skip
 *                          future sync attempts — those may succeed
 *                          once the upstream side resolves. v1.4.43
 *                          W14: after 24h of unbroken persistent
 *                          failures the row is `parked` and the
 *                          integration stops attempting until the user
 *                          / operator reconnects.
 *
 * v1.4.42 W6 extended this union from `transient | reauth_required` to
 * the three-state taxonomy above; the state-mapping function turns
 * `persistent` into `error_transient` for now (a Withings 293 still
 * lets the next sync run), but the audit detail carries the explicit
 * kind so operations can filter.
 */
export type FailureKind = "transient" | "reauth_required" | "persistent";

/**
 * Map a shared `IntegrationClassification` onto the ledger `FailureKind`.
 *
 * `success` never reaches a failure path, so it collapses into `transient`
 * alongside the genuinely-retryable verdicts; `reauth_required` and
 * `persistent` pass through unchanged. Lifted out of the per-vendor
 * `classifyXFailure` adapters (Polar / Oura / Nightscout), which each carried a
 * byte-identical copy of this mapping.
 */
export function toFailureKind(
  classification: IntegrationClassification,
): FailureKind {
  if (classification === "reauth_required") return "reauth_required";
  if (classification === "persistent") return "persistent";
  return "transient";
}

/**
 * Non-enumerable marker stamped on an error a provider sync ALREADY recorded on
 * the integration ledger before rethrowing. The poll-cohort boundary
 * (`makePollCohortHandler`) reads it so a record-then-rethrow failure is not
 * recorded a SECOND time when it surfaces in the cohort catch — a double-record
 * would inflate the per-kind failure buckets (firing the 3-strike admin alert a
 * tick early) and churn `lastError`. A provider-blind recorder at the boundary
 * would also persist an UNREDACTED message (e.g. Nightscout's token-bearing
 * URL), so the marker keeps classification + redaction provider-owned: only an
 * UNMARKED escape reaches the boundary recorder.
 *
 * No-op on non-objects; tolerant of a frozen error (the boundary then records
 * it once, which is the correct fallback — never a double-record).
 */
const SYNC_FAILURE_RECORDED: unique symbol = Symbol(
  "healthlog.syncFailureRecorded",
);

/** Stamp `err` as already-recorded and return it (for `throw markSync…(err)`). */
export function markSyncFailureRecorded<T>(err: T): T {
  if (err !== null && typeof err === "object") {
    try {
      Object.defineProperty(err, SYNC_FAILURE_RECORDED, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      // A frozen / sealed error can't carry the marker; the boundary records
      // it once — the safe fallback, never a double-record.
    }
  }
  return err;
}

/** True when `err` was already recorded on the ledger by its source site. */
export function isSyncFailureRecorded(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as Record<symbol, unknown>)[SYNC_FAILURE_RECORDED] === true
  );
}

/**
 * Recognised IntegrationStatus states.
 *
 * `parked` (v1.4.43 W14) is set when an integration's persistent
 * failure streak has exceeded `PARK_PERSISTENT_FAILURE_AFTER_MS` (24h
 * by default). A parked integration STOPS RETRYING — the next
 * scheduled sync skips, and the Settings UI surfaces a "Paused —
 * reconnect manually" pill with a "Wieder verbinden" CTA that POSTs
 * to `/api/integrations/withings/resume` to clear the park. This is
 * intentionally heavier than `error_transient`: a contract-mismatch
 * that's been failing for a full day is no longer "the upstream might
 * recover on its own" — it's an operator-shaped problem, and
 * retrying every 15 minutes for another week just buries the audit
 * trail.
 */
export type IntegrationState =
  | "connected"
  | "error_transient"
  | "error_reauth"
  | "disconnected"
  | "parked"
  /**
   * v1.38.19 — no ledger row exists for this (user, provider) pair, so the
   * ledger has nothing to say. It is NOT a claim about the connection either
   * way: `connected` used to be the synthetic default here, which made the
   * field's default read as the opposite of the truth for every account that
   * had never connected anything — the setup flow's connect step believed it
   * and told a brand-new account its wearable was connected. Consumers treat
   * `unknown` the way they treat `disconnected`; `syncHealth.verdict` stays
   * the only liveness truth.
   */
  | "unknown";

/**
 * The ladder at which a streak of failures escalates from "user-visible
 * banner" to "admin-paged on Telegram". 3 is small enough to catch a
 * truly broken integration before the user notices missing data, large
 * enough that one network blip doesn't page anyone.
 *
 * Override via env `INTEGRATION_FAILURE_ALERT_THRESHOLD` for ops who
 * want a louder or quieter signal — we read it lazily so tests can
 * mutate it per case.
 */
export function getPersistentFailureThreshold(): number {
  const raw = process.env.INTEGRATION_FAILURE_ALERT_THRESHOLD;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  return 3;
}

/**
 * Re-alert window: once we've paged on a streak we hold the alert for
 * 24h before paging again on the same streak (idempotency). The streak
 * is implicitly "reset" by a single success, which clears every
 * per-kind bucket and `alertedAt` — so a flapping integration that
 * succeeds once an hour will not page repeatedly.
 */
const ALERT_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * v1.4.43 W14 — once a `persistent` failure streak has been running
 * for this long without a single intervening success, flip the
 * integration to `parked`. 24h matches the same window the alert
 * ladder uses for re-paging and gives the operator a full business
 * day to notice a 293/294 surge before the integration disables
 * itself.
 */
const PARK_PERSISTENT_FAILURE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long an unbroken failure streak may keep claiming to be `transient`
 * before the claim is treated as refuted and the failure is recorded as
 * `persistent` instead.
 *
 * `transient` is a hypothesis, not an observation: the classifier defaults a
 * timeout, a 429, a 5xx and any unrecognised response to it precisely because
 * the wire cannot tell "the upstream is rebooting" from "this will never work
 * again". That default is right for one attempt and wrong for a thousand — a
 * streak that has been retried hourly for a full day without a single success
 * has falsified the hypothesis by experiment, and continuing to call it
 * transient is the ledger asserting a certainty the wire never gave it.
 *
 * 24 h is the same window the persistent park already uses. An upstream
 * maintenance night, a rate-limit cool-off, a redeploy and a DNS wobble all
 * fit comfortably inside it, so a genuine blip recovers and resets the streak
 * long before this trips — nothing that heals on its own takes a day. The
 * escalation is additionally gated on `getPersistentFailureThreshold()`
 * consecutive failures, so a provider whose cron ticks rarely cannot escalate
 * on its second-ever attempt just because wall-clock time passed.
 *
 * Escalating feeds the EXISTING ladder rather than a second one: the
 * `persistent` bucket starts counting, `persistentFailureStartedAt` anchors,
 * and `PARK_PERSISTENT_FAILURE_AFTER_MS` later the row parks and stops
 * retrying — 48 h of unbroken failure end to end before anything is disabled.
 */
const TRANSIENT_ESCALATION_AFTER_MS = 24 * 60 * 60 * 1000;

/** Row states that mean "an error is currently held on this row". */
const ERROR_STATES: ReadonlySet<string> = new Set<IntegrationState>([
  "error_transient",
  "error_reauth",
  "parked",
]);

/**
 * Read the `failingLegs` JSON column into an ordered list of leg names.
 *
 * Anything that is not an array of strings — a legacy `null`, a hand-edited
 * row, a shape from a future schema — reads as the empty set, which is the
 * pre-existing "unattributed failure" semantics under which any success clears
 * the row. Non-string members are dropped rather than coerced: a leg name is an
 * identifier the caller passes, and inventing one from a number would let a
 * success match a leg nobody ever recorded.
 */
function readFailingLegs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Append `leg` as the most recent failure, moving it to the end if it is
 * already in the set. Ordering is load-bearing: the last element is the leg
 * that wrote the message `lastError` currently holds, which is what lets a
 * partial recovery tell "this message still describes a failing leg" from
 * "this message belongs to a leg that has since recovered".
 */
function withLegRecorded(current: readonly string[], leg: string): string[] {
  return [...current.filter((entry) => entry !== leg), leg];
}

export interface IntegrationStatusSnapshot {
  integration: IntegrationKey;
  state: IntegrationState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** v1.4.43 W14 — per-kind bucketed counters; `null` for rows
   *  that have never recorded a write yet. v1.4.47 W1 — sole source
   *  of truth now that the legacy `consecutiveFailures` column is
   *  gone. */
  consecutiveFailuresByKind: ConsecutiveFailuresByKind | null;
  /**
   * Start of the current unbroken failure streak, whatever the kind. The
   * buckets count attempts; this dates them, which is what tells a blip apart
   * from a pipe that has been dead for weeks. `null` whenever the row is not
   * currently failing.
   */
  failingSince: string | null;
}

/**
 * Bucketed consecutive-failure counters keyed by `FailureKind`.
 * v1.4.43 W14 — exposed so the response shape stays explicit and
 * tests can pin the bucket increments.
 */
export type ConsecutiveFailuresByKind = Record<FailureKind, number>;

/**
 * Type guard for the JSON payload Prisma returns for the
 * `consecutiveFailuresByKind` column. Anything that's not a plain
 * object with three numeric keys is treated as "no value yet" so the
 * writer starts from a zero envelope.
 */
function isFailureBucketObject(
  value: unknown,
): value is ConsecutiveFailuresByKind {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.transient === "number" &&
    typeof obj.reauth_required === "number" &&
    typeof obj.persistent === "number"
  );
}

/**
 * Read the JSON `consecutiveFailuresByKind` column off the Prisma row
 * with a typed view. Returns `null` for rows that have never written a
 * bucket payload — callers seed a fresh zero envelope.
 */
function readBucketColumn(value: unknown): ConsecutiveFailuresByKind | null {
  return isFailureBucketObject(value) ? value : null;
}

/**
 * Zero-bucket envelope. Inlined where we need the literal so eslint
 * doesn't flag a re-assignment of the shared constant.
 */
function zeroBuckets(): ConsecutiveFailuresByKind {
  return { transient: 0, reauth_required: 0, persistent: 0 };
}

/**
 * Read the current snapshot. Returns a synthetic "unknown, never attempted"
 * record when no row exists yet — the ledger holds no history, and says so
 * rather than guessing a state. `resolveSyncVerdict` reads the same absence
 * off the null timestamps and answers `pending_first_sync` for a live
 * connection, `disconnected` for one that is not there.
 */
export async function getIntegrationStatus(
  userId: string,
  integration: IntegrationKey,
): Promise<IntegrationStatusSnapshot> {
  const row = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
  });
  if (!row) {
    return {
      integration,
      state: "unknown",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      consecutiveFailuresByKind: null,
      failingSince: null,
    };
  }
  return {
    integration,
    state: row.state as IntegrationState,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastError: row.lastError ? safeDecryptError(row.lastError) : null,
    consecutiveFailuresByKind: readBucketColumn(row.consecutiveFailuresByKind),
    failingSince: row.failingSinceAt?.toISOString() ?? null,
  };
}

/**
 * Read the current `state` cheaply — used by the sync entry-points
 * to short-circuit when reauth is required.
 *
 * v1.4.43 W14 — `parked` is treated as "reauth required" for the
 * purpose of sync short-circuit: the user has to call `/resume` (or
 * complete the OAuth flow again) before any further sync work
 * happens. Returning `true` for both states means existing call sites
 * keep their current "skip the cron tick" behaviour without churn,
 * and the Settings UI distinguishes the two via the pill copy.
 */
export async function isReauthRequired(
  userId: string,
  integration: IntegrationKey,
): Promise<boolean> {
  const row = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
    select: { state: true },
  });
  return row?.state === "error_reauth" || row?.state === "parked";
}

export interface RecordSyncSuccessOptions {
  /**
   * The sync leg that succeeded, for a provider whose legs run on separate
   * schedules (Withings measures / activity / sleep / ECG, the four WHOOP
   * resources, the two Polar legs). Omit it for a single-leg provider or for a
   * full pass that covered every leg — an omitted leg clears the row whole,
   * which is the pre-existing behaviour and the correct one for those callers.
   */
  leg?: string;
}

/**
 * Record a successful sync. Resets the failure counter, clears any
 * prior error message, and (importantly) flips state back to
 * `connected` even from `error_reauth` — the Withings flow re-enters
 * after the OAuth callback writes a new refresh token.
 *
 * A success only clears what it is entitled to clear. `IntegrationStatus` is
 * keyed `(userId, integration)`, but Withings runs four legs on four crons and
 * WHOOP runs four resources on four more — so an unconditional clear meant the
 * ECG leg succeeding at :41 wiped the error, the buckets, the streak anchor and
 * the state that the sleep leg had recorded at :15. The failing leg's strike
 * ladder was reset several times an hour, so it could never reach the alert
 * threshold or the park window, and the card painted a green "connected · 12
 * minutes ago" over a data class that had stopped arriving.
 *
 * This success removes its OWN leg from the failing set and clears the row only
 * once that set is empty. The set matters because the previous single slot
 * could remember one leg at a time: with sleep and activity both failing, the
 * second failure overwrote the first, and the second leg recovering then wiped
 * an error the first was still causing. The ledger forgot a live failure and
 * went green over it — the exact case this set exists to hold.
 *
 * The partial path deliberately does NOT advance `lastSuccessAt`. That field is
 * what the freshness arms and the card's "connected · X ago" read, and moving
 * it forward while another leg is dead is exactly the sentence this change
 * exists to stop the ledger from saying. `lastAttemptAt` does advance, so the
 * row still reads as "being tried" rather than ageing into `stalled`.
 *
 * `lastError` is cleared on the partial path when the recovering leg is the one
 * that wrote it. The message then describes a leg that is now healthy, and a
 * row that keeps showing it is describing the wrong failure; the next attempt
 * by a still-failing leg writes its own. No message is honest here — a guessed
 * one would not be.
 */
export async function recordSyncSuccess(
  userId: string,
  integration: IntegrationKey,
  options?: RecordSyncSuccessOptions,
): Promise<void> {
  const now = new Date();
  const leg = options?.leg ?? null;

  if (leg !== null) {
    const existing = await prisma.integrationStatus.findUnique({
      where: { userId_integration: { userId, integration } },
      select: { state: true, failingLegs: true },
    });
    const failingLegs = readFailingLegs(existing?.failingLegs);
    const remaining = failingLegs.filter((entry) => entry !== leg);
    const heldByAnotherLeg =
      existing != null &&
      remaining.length > 0 &&
      ERROR_STATES.has(existing.state);

    if (heldByAnotherLeg) {
      // The recovering leg owned `lastError` iff it was the most recent
      // failure, i.e. the last element. Dropping it leaves the row without a
      // message for any leg that is still failing, which is the honest state
      // until one of them fails again and writes its own.
      const ownedLastError = failingLegs[failingLegs.length - 1] === leg;
      await prisma.integrationStatus.update({
        where: { userId_integration: { userId, integration } },
        data: {
          lastAttemptAt: now,
          failingLegs: remaining,
          ...(ownedLastError ? { lastError: null } : {}),
        },
      });
      // Meta only — the enclosing wide event owns its own action name (the
      // cron task), and overwriting it here would rename the job.
      annotate({
        meta: {
          integration_partial_success: {
            integration,
            succeeded_leg: leg,
            failing_legs: remaining,
          },
        },
      });
      return;
    }
  }

  // v1.4.43 W14 — a success resets ALL per-kind buckets back to zero
  // and clears the persistent-streak start timestamp.
  // v1.4.47 W1 — the legacy `consecutiveFailures` column was dropped
  // (migration 0077), so the bucket reset is the only counter write.
  await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: "connected",
      lastSuccessAt: now,
      lastAttemptAt: now,
      consecutiveFailuresByKind: zeroBuckets(),
      failingLegs: [],
    },
    update: {
      state: "connected",
      lastSuccessAt: now,
      lastAttemptAt: now,
      lastError: null,
      consecutiveFailuresByKind: zeroBuckets(),
      persistentFailureStartedAt: null,
      failingSinceAt: null,
      failingLegs: [],
      alertedAt: null,
    },
  });
}

export interface RecordSyncFailureInput {
  userId: string;
  integration: IntegrationKey;
  kind: FailureKind;
  message: string;
  /** Optional structured error code (e.g. "invalid_grant", "401"). */
  errorCode?: string;
  /**
   * The sync leg that failed, for a provider whose legs run on separate
   * schedules. Recorded on the row so a sibling leg's success cannot clear an
   * error it did not cause. Omit it for a single-leg provider.
   */
  leg?: string;
}

/**
 * Record a sync failure. Always:
 *   - increments the per-kind bucket in `consecutiveFailuresByKind`
 *   - persists the encrypted error message
 *   - writes one `AuditLog` row with `integrations.sync.failed`
 *
 * If `kind === "reauth_required"` the row is parked at `error_reauth`
 * so the next scheduled sync skips. If `kind === "persistent"` and
 * the persistent streak has been running for >24h, the row is parked
 * at `parked` so the next sync also skips — the operator / user has
 * to call `resumeIntegrationFromPark` to clear it. Otherwise the state
 * is `error_transient` and the next sync will try again.
 *
 * If the post-update bucket max crosses the alerting threshold AND the
 * alerting window has lapsed, dispatch a Telegram notification to all
 * admins. Failures here are best-effort: a failed dispatch DOES NOT
 * swallow the audit log.
 *
 * v1.4.43 W14 — per-kind counter migration. Each failure increments
 * ONLY its own bucket; a transient hiccup followed by a persistent
 * failure no longer masks the persistent streak's true age.
 * v1.4.47 W1 — the legacy single-column `consecutiveFailures` integer
 * was dropped (migration 0077); the bucket is now the sole counter
 * and the back-fill branch is gone.
 *
 * A `transient` failure whose streak has run unbroken for longer than
 * `TRANSIENT_ESCALATION_AFTER_MS` is recorded as `persistent` instead. Before
 * that, a `transient` streak had no exit at all: the park test read
 * `kind === "persistent"`, `persistentFailureStartedAt` was only stamped on a
 * persistent failure, and so a streak the classifier had bucketed as transient
 * could run for a thousand attempts with the persistent counter at zero, the
 * state frozen at `error_transient`, and no ladder it could ever climb. See
 * the constant for why time, rather than count, is the honest signal.
 */
export async function recordSyncFailure(
  input: RecordSyncFailureInput,
): Promise<void> {
  const { userId, integration, kind, message, errorCode } = input;
  const leg = input.leg ?? null;
  const now = new Date();
  const encryptedError = safeEncryptError(message);

  // Read the current row first so we can:
  //   (a) compute the new per-kind bucket value
  //   (b) decide whether the streak has outlived the `transient` claim
  //   (c) decide whether the persistent streak has exceeded the
  //       park threshold
  const existing = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
    select: {
      consecutiveFailuresByKind: true,
      persistentFailureStartedAt: true,
      failingSinceAt: true,
      failingLegs: true,
      alertedAt: true,
    },
  });

  // The failing set, with this leg appended as the most recent failure. An
  // unattributed failure (no leg — a single-leg provider, or a recorder that
  // does not know which leg it caught) adds nothing and removes nothing: it
  // carries no attribution to record, and erasing what other legs already
  // reported would let one of their successes clear an error it did not fix.
  const existingLegs = readFailingLegs(existing?.failingLegs);
  const failingLegs =
    leg !== null ? withLegRecorded(existingLegs, leg) : existingLegs;

  // Resolve the starting bucket envelope:
  //   - existing JSON value if present
  //   - zero envelope for a row that has never written a bucket payload
  //     or for the first-ever write of this (user, integration) pair
  const startingBuckets = readBucketColumn(existing?.consecutiveFailuresByKind);

  // Streak anchor: the first failure of the current unbroken run. Every path
  // that resolves a failure (success entitled to clear, reconnect, disconnect,
  // resume) nulls it, so a non-null value always dates a live streak.
  const failingSinceAt = existing?.failingSinceAt ?? now;
  const streakAgeMs = now.getTime() - failingSinceAt.getTime();

  // The `transient` hypothesis, tested against the clock. Both conditions are
  // required: the wall-clock window rules out a blip, and the consecutive-count
  // gate keeps a rarely-polled provider from escalating on its second attempt
  // just because a day of real time went by. `+ 1` because this failure has not
  // been written into the bucket yet.
  const transientStreakAfterThis = (startingBuckets?.transient ?? 0) + 1;
  const escalatedFromTransient =
    kind === "transient" &&
    streakAgeMs >= TRANSIENT_ESCALATION_AFTER_MS &&
    transientStreakAfterThis >= getPersistentFailureThreshold();

  // Everything downstream — bucket, state mapping, park test, audit detail,
  // alert copy — reads the effective kind, so the escalation feeds the ladder
  // that already exists instead of growing a parallel one.
  const effectiveKind: FailureKind = escalatedFromTransient
    ? "persistent"
    : kind;

  // Snapshot the persistent-bucket count BEFORE we increment so the
  // streak-anchor decision below can see the pre-increment value.
  // Otherwise we'd inspect the freshly-incremented bucket and never
  // recognise a "first persistent failure of a fresh streak".
  const persistentStreakBefore = startingBuckets?.persistent ?? 0;

  // Now build the new bucket envelope. `buckets` is always a fresh
  // object so the upsert payload doesn't share a reference with the
  // existing-row snapshot (which would couple the in-memory mutation
  // to the audit-log read path below).
  const buckets: ConsecutiveFailuresByKind = startingBuckets
    ? { ...startingBuckets }
    : zeroBuckets();

  // Increment only the bucket matching this failure's kind.
  // The other two buckets stay at their current value so a persistent
  // streak isn't reset by an intervening transient hiccup.
  buckets[effectiveKind] = (buckets[effectiveKind] ?? 0) + 1;

  // Track the persistent-streak start so the >24h park check has a
  // wall-clock anchor. Only stamped on the FIRST persistent failure of
  // a streak; cleared on success or when the persistent bucket goes
  // back to zero (which today only happens via success, but the logic
  // is symmetric for future "transient drained the streak" rules).
  //
  // An escalated transient anchors here too, at the moment of escalation
  // rather than at the streak start. That is deliberate: it dates when the
  // failure started being treated as unrecoverable, which is what the park
  // window measures, and it puts a full second day between "this is no longer
  // transient" and "stop retrying" — 48 h of unbroken failure before an
  // integration disables itself over a verdict the wire never actually gave.
  const isPersistent = effectiveKind === "persistent";
  let persistentFailureStartedAt: Date | null =
    existing?.persistentFailureStartedAt ?? null;
  if (isPersistent && persistentStreakBefore === 0) {
    persistentFailureStartedAt = now;
  }

  // Park decision: a persistent failure whose streak has exceeded the
  // 24h window flips the state to `parked`. This is sticky — once
  // parked, the row stays parked until either a success arrives
  // (unlikely, since the sync entry-point short-circuits) or the
  // user calls `resumeIntegrationFromPark` via the API.
  const persistentStreakAgeMs =
    isPersistent && persistentFailureStartedAt
      ? now.getTime() - persistentFailureStartedAt.getTime()
      : 0;
  const shouldPark =
    isPersistent && persistentStreakAgeMs > PARK_PERSISTENT_FAILURE_AFTER_MS;

  // State mapping:
  //   reauth_required → error_reauth (sync entry-point short-circuits)
  //   transient       → error_transient (next sync still runs)
  //   persistent      → error_transient unless we just crossed the
  //                     24h park threshold, in which case → parked
  //                     (sync entry-point short-circuits, audit detail
  //                     carries the explicit kind so operations can
  //                     grep for contract-bug bursts)
  const newState: IntegrationState = shouldPark
    ? "parked"
    : effectiveKind === "reauth_required"
      ? "error_reauth"
      : "error_transient";

  const row = await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: newState,
      lastAttemptAt: now,
      lastError: encryptedError,
      consecutiveFailuresByKind: buckets,
      persistentFailureStartedAt: isPersistent ? now : null,
      failingSinceAt,
      failingLegs,
    },
    update: {
      state: newState,
      lastAttemptAt: now,
      lastError: encryptedError,
      consecutiveFailuresByKind: buckets,
      persistentFailureStartedAt,
      failingSinceAt,
      failingLegs,
    },
  });

  // Audit log entry — fire-and-await so an integration test can assert
  // it. The auth/audit helper is its own DB write so it's safe to call
  // serially without bloating latency in the success path (which never
  // calls this).
  //
  // v1.4.47 W1 — `attemptNumber` is now sourced from the bucket sum
  // (the legacy `consecutiveFailures` column was dropped). The sum
  // matches the legacy column's value for any row written after
  // v1.4.43: a transient burst followed by a single persistent failure
  // shows `attemptNumber = transient + persistent`, which is the same
  // running total the legacy integer carried.
  const bucketTotal =
    buckets.transient + buckets.reauth_required + buckets.persistent;
  await auditLog("integrations.sync.failed", {
    userId,
    details: {
      integration,
      kind: effectiveKind,
      // Non-null only when the clock overrode the classifier, so an operator
      // reading the trail can tell "the upstream said this was permanent" from
      // "we concluded it was after a day of retrying".
      escalatedFrom: escalatedFromTransient ? kind : null,
      failingLeg: leg,
      // Every leg the row currently holds an error for, not just this one —
      // the audit trail is where an operator reconstructs an overlapping
      // outage, and one leg per row was never enough to do it.
      failingLegs,
      failingSinceAt: failingSinceAt.toISOString(),
      streakAgeMs,
      errorCode: errorCode ?? null,
      message,
      attemptNumber: bucketTotal,
      bucketCount: buckets[effectiveKind],
      state: newState,
    },
  });

  // Persistent-failure alerting. Only trip when:
  //   1. We're at or above the threshold AFTER this failure.
  //   2. We haven't paged on this streak in the last 24h.
  //
  // Both conditions matter: (1) prevents premature paging, (2)
  // prevents loops where a flapping integration that fails once an
  // hour pages every hour.
  //
  // v1.4.43 W14 — the threshold check reads `Math.max(...buckets)` so
  // a row with a 3-deep persistent streak still pages even when the
  // transient bucket sat at 0.
  // v1.4.47 W1 — the legacy `consecutiveFailures` column was dropped
  // (migration 0077); the bucket max is now the sole alert signal.
  const threshold = getPersistentFailureThreshold();
  const alertSignal = Math.max(...Object.values(buckets));
  if (alertSignal >= threshold) {
    const previouslyAlerted =
      row.alertedAt &&
      now.getTime() - row.alertedAt.getTime() < ALERT_REPEAT_WINDOW_MS;
    if (!previouslyAlerted) {
      const outcome = await maybeAlertAdmins({
        userId,
        integration,
        kind: effectiveKind,
        message,
        errorCode,
        consecutiveFailures: alertSignal,
      }).catch((err) => {
        getEvent()?.addWarning(
          `Admin alert dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });

      if (outcome?.channelsAttempted) {
        // An attempted channel owns its own retry/cooldown policy. Stamp the
        // alert window even when every attempt failed so a backend outage
        // cannot turn this failure streak into an hourly notification flood.
        await prisma.integrationStatus.update({
          where: { userId_integration: { userId, integration } },
          data: { alertedAt: now },
        });
      } else if (outcome) {
        // No recipient channel accepted an attempt. Leaving alertedAt empty
        // keeps the missing delivery visible instead of recording a page that
        // never left the process.
        getEvent()?.addWarning(
          `No admin notification channel available for ${integration} failure alert`,
        );
      }
    }
  }

  // Park-event audit row — written once per transition into the
  // `parked` state so the operations trail shows "this integration
  // disabled itself after 24h of persistent failures" without the
  // operator having to correlate the sync.failed rows by timestamp.
  if (shouldPark && existing?.persistentFailureStartedAt) {
    await auditLog("integrations.parked", {
      userId,
      details: {
        integration,
        reason: "persistent_24h",
        persistentFailureStartedAt:
          existing.persistentFailureStartedAt.toISOString(),
        persistentStreakAgeMs,
        // The whole streak, which for an escalated transient is a full day
        // longer than the persistent window above.
        failingSinceAt: failingSinceAt.toISOString(),
        streakAgeMs,
        errorCode: errorCode ?? null,
        message,
      },
    });
  }
}

/**
 * v1.4.43 W14 — clear a `parked` integration so the next scheduled
 * sync runs again. Used by `/api/integrations/withings/resume` and
 * the OAuth-callback path. The state moves to `connected`; all
 * per-kind buckets reset to zero; the persistent-streak anchor
 * clears; the alert window resets so the next genuine 3-strike burst
 * still pages admins.
 *
 * Idempotent: calling against a connected row is a no-op (same
 * post-state, no audit row). Calling against any non-parked error
 * state also clears the row — the resume CTA is the universal
 * "unstick this integration" button.
 */
export async function resumeIntegrationFromPark(
  userId: string,
  integration: IntegrationKey,
): Promise<{ wasParked: boolean }> {
  const existing = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
    select: { state: true },
  });
  const wasParked = existing?.state === "parked";

  await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: "connected",
      consecutiveFailuresByKind: zeroBuckets(),
    },
    update: {
      state: "connected",
      lastError: null,
      consecutiveFailuresByKind: zeroBuckets(),
      persistentFailureStartedAt: null,
      failingSinceAt: null,
      failingLegs: [],
      alertedAt: null,
    },
  });

  if (wasParked) {
    await auditLog("integrations.resumed", {
      userId,
      details: { integration, source: "user_resume" },
    });
  }

  return { wasParked };
}

/**
 * Park a connection at `error_reauth` from a deliberate scope-skip
 * short-circuit. Unlike `recordSyncFailure`, this helper:
 *
 *   1. does NOT increment the per-kind failure buckets.
 *   2. does NOT write an `integrations.sync.failed` audit row through
 *      `recordSyncFailure`. A standalone `integrations.reauth_required`
 *      row is written instead so the operations trail still shows the
 *      park event.
 *   3. does NOT enter the 3-strike alert ladder — no admin Telegram
 *      page fires.
 *
 * Idempotent: a second call for the same scope-skip leaves the row at
 * `error_reauth` with the same encrypted message and the same bucket
 * values (no increment). Use it from sync routines that have detected a
 * deliberate, structural scope gap (e.g. legacy Withings connection
 * missing `user.activity`). The defence-in-depth catch-block path
 * stays on `recordSyncFailure` because a 403 reaching the catch is
 * genuinely unexpected once the scope-skip lands.
 *
 * The audit-row-once semantics mean a row is only written if the row
 * is not already parked at `error_reauth` with the same `lastError`.
 * Re-parking the same scope-skip is a no-op for the audit log.
 */
export async function parkIntegrationAtReauth(opts: {
  userId: string;
  integration: IntegrationKey;
  message: string;
  errorCode: string;
  /** The leg whose scope gap forced the park, for multi-leg providers. */
  leg?: string;
}): Promise<void> {
  const { userId, integration, message, errorCode } = opts;
  const leg = opts.leg ?? null;
  const now = new Date();
  const encryptedError = safeEncryptError(message);

  // Idempotency probe: re-parking the same scope-skip should NOT emit
  // another audit row. We read the current row first; only write the
  // audit log when the state or error changes.
  const existing = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
    select: {
      state: true,
      lastError: true,
      failingSinceAt: true,
      failingLegs: true,
    },
  });
  const isFreshPark =
    existing?.state !== "error_reauth" || existing.lastError !== encryptedError;

  // Same set semantics as `recordSyncFailure`: a scope-skip park adds its leg
  // to whatever the row already holds rather than replacing it, so a sibling
  // leg's independent failure survives the park.
  const existingLegs = readFailingLegs(existing?.failingLegs);
  const failingLegs =
    leg !== null ? withLegRecorded(existingLegs, leg) : existingLegs;

  await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: "error_reauth",
      lastError: encryptedError,
      lastAttemptAt: now,
      // First-ever row for this (user, integration) — buckets stay at
      // zero so a later genuine transient burst still has the full
      // 3-strike runway before paging.
      consecutiveFailuresByKind: zeroBuckets(),
      failingSinceAt: now,
      failingLegs,
    },
    update: {
      state: "error_reauth",
      lastError: encryptedError,
      lastAttemptAt: now,
      // Deliberately omit `consecutiveFailuresByKind` — the existing
      // bucket values are preserved exactly. This is the whole point
      // of the helper.
      failingSinceAt: existing?.failingSinceAt ?? now,
      failingLegs,
    },
  });

  if (isFreshPark) {
    await auditLog("integrations.reauth_required", {
      userId,
      details: { integration, message, errorCode, source: "scope_skip" },
    });
  }
}

/**
 * Mark a connection as needing re-auth without recording a fresh
 * "attempt". Used by the OAuth/refresh-token flows when they detect
 * an `invalid_grant`-style permanent revocation OUTSIDE of a sync —
 * e.g. the status endpoint that proactively refreshes tokens.
 */
export async function markReauthRequired(
  userId: string,
  integration: IntegrationKey,
  message: string,
): Promise<void> {
  const now = new Date();
  const existing = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
    select: { failingSinceAt: true },
  });

  // v1.4.47 W1 — the legacy `consecutiveFailures` column was dropped
  // (migration 0077). Out-of-band reauth detection (proactive token
  // refresh) seeds the `reauth_required` bucket at 1 on a first-ever
  // row so subsequent reauth detections accumulate against the same
  // bucket the alert ladder reads.
  await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: "error_reauth",
      lastError: safeEncryptError(message),
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 1,
        persistent: 0,
      },
      lastAttemptAt: now,
      failingSinceAt: now,
    },
    update: {
      state: "error_reauth",
      lastError: safeEncryptError(message),
      // Never re-stamp a streak already running — the anchor dates the
      // failure, not the detection.
      failingSinceAt: existing?.failingSinceAt ?? now,
    },
  });

  await auditLog("integrations.reauth_required", {
    userId,
    details: { integration, message },
  });
}

/**
 * Reset the row when the user disconnects. We keep the row (so the UI
 * can still show a tombstone "disconnected at <time>") but clear the
 * error state.
 */
export async function markDisconnected(
  userId: string,
  integration: IntegrationKey,
): Promise<void> {
  await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: "disconnected",
      consecutiveFailuresByKind: zeroBuckets(),
    },
    update: {
      state: "disconnected",
      lastError: null,
      consecutiveFailuresByKind: zeroBuckets(),
      persistentFailureStartedAt: null,
      failingSinceAt: null,
      failingLegs: [],
      alertedAt: null,
    },
  });
}

/**
 * Inverse of markReauthRequired — used when the user successfully
 * re-completes the OAuth flow. We don't record a fresh sync (no work
 * was done) — just reset the streak so the next sync can run.
 */
export async function markReconnected(
  userId: string,
  integration: IntegrationKey,
): Promise<void> {
  await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: "connected",
      consecutiveFailuresByKind: zeroBuckets(),
    },
    update: {
      state: "connected",
      lastError: null,
      consecutiveFailuresByKind: zeroBuckets(),
      persistentFailureStartedAt: null,
      failingSinceAt: null,
      failingLegs: [],
      alertedAt: null,
    },
  });
}

// ── helpers ────────────────────────────────────────────────────────

/**
 * Encrypt with a fallback that swallows crypto-config errors so a
 * misconfigured ENCRYPTION_KEY can never break the audit/error path.
 * Worst case we store ciphertext with the literal string `"<encrypt
 * failed>"` — the row is still useful (state, attempt, counter) and
 * the underlying crash gets a Wide-Event warning.
 */
function safeEncryptError(message: string): string {
  try {
    return encrypt(message.slice(0, 1024));
  } catch (err) {
    getEvent()?.addWarning(
      `IntegrationStatus error-encrypt failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "<encrypt failed>";
  }
}

function safeDecryptError(ciphertext: string): string {
  if (ciphertext === "<encrypt failed>") return "(error message unavailable)";
  try {
    return decrypt(ciphertext);
  } catch {
    return "(error message unavailable)";
  }
}

export interface AlertInput {
  userId: string;
  integration: IntegrationKey;
  kind: FailureKind;
  message: string;
  errorCode: string | undefined;
  consecutiveFailures: number;
  /** Caller-resolved subject label (usually the user's email). */
  subjectLabel?: string;
}

/**
 * Pure formatter for the admin-Telegram payload — extracted so we
 * can unit-test the message shape without standing up Prisma. Kept
 * deterministic on purpose: same input, byte-identical output.
 *
 * The 280-char trim on the upstream error message protects admins
 * from a 4 KB stack trace landing in chat. Telegram's own cap is
 * 4096 characters but our envelope (title + summary + action line)
 * eats ~150 chars so we keep a comfortable margin.
 */
/**
 * Reason + action copy keyed off `FailureKind`. Adding a new failure
 * kind is a one-row table edit instead of two more arms in two
 * different ternary stacks (the style-guide forbids nested ternaries).
 */
/**
 * Display label per `IntegrationKey`. A one-row table edit replaces the
 * nested-ternary chain the admin-alert formatter used to carry — adding
 * a new integration is a single line here instead of another arm in a
 * ternary stack (the style-guide forbids nested ternaries).
 */
const INTEGRATION_LABELS: Record<IntegrationKey, string> = {
  withings: "Withings",
  whoop: "WHOOP",
  fitbit: "Fitbit",
  nightscout: "Nightscout",
  polar: "Polar",
  oura: "Oura",
  "google-health": "Google Health",
  strava: "Strava",
};

const FAILURE_KIND_COPY: Record<
  FailureKind,
  { reason: string; action: string }
> = {
  reauth_required: {
    reason: "re-auth required",
    action: "ask the user to reconnect the integration.",
  },
  persistent: {
    reason: "persistent error",
    action:
      "investigate the upstream contract — params/scope/action likely mismatched.",
  },
  transient: {
    reason: "transient error",
    action: "investigate the upstream service.",
  },
};

/**
 * SECURITY INVARIANT (v1.4.43 W13 M-2 — MUST NOT be relaxed):
 *
 * The body produced here is dispatched to Telegram via
 * `dispatchNotification`. `input.message` is upstream-influenced — the
 * Withings classifier (`src/lib/withings/client.ts`) builds it as
 * `Withings <verb> error: <status> - <json.error>` where `json.error`
 * is whatever the upstream API put in the response body. Today that
 * lands in Telegram on plain text (no `parseMode`), so the upstream
 * string is rendered literally and a malicious / buggy response body
 * is inert.
 *
 * Do NOT flip the Telegram callers downstream to `parseMode: "HTML"`
 * or `"MarkdownV2"`. The medication-reminder paths use HTML mode
 * because their bodies are server-built from sanitised data only; the
 * admin-alert body is NOT sanitised. If HTML / Markdown parsing is
 * ever enabled for this payload, escape every interpolated field
 * (`input.message`, `subjectLabel`, `errorCode`) at the same time —
 * otherwise an upstream-controlled string becomes an HTML / Markdown
 * injection vector reaching every admin chat.
 */
export function formatAdminAlertPayload(input: AlertInput): {
  title: string;
  message: string;
  metadata: Record<string, unknown>;
} {
  const integrationLabel = INTEGRATION_LABELS[input.integration];
  const subjectLabel = input.subjectLabel ?? input.userId;
  const { reason: reasonLabel, action: actionLabel } =
    FAILURE_KIND_COPY[input.kind];
  const codeLabel = input.errorCode ? ` (${input.errorCode})` : "";
  const trimmed =
    input.message.length > 280
      ? `${input.message.slice(0, 277)}...`
      : input.message;

  const title = `${integrationLabel} sync failing for ${subjectLabel}`;
  const message =
    `${integrationLabel} sync has failed ${input.consecutiveFailures} times in a row for ${subjectLabel}.\n` +
    `Last error: ${reasonLabel}${codeLabel} — ${trimmed}\n` +
    `Action: ${actionLabel}`;

  return {
    title,
    message,
    metadata: {
      integration: input.integration,
      affectedUserId: input.userId,
      consecutiveFailures: input.consecutiveFailures,
      errorCode: input.errorCode ?? null,
    },
  };
}

/**
 * Page admins through the existing dispatcher. We do NOT add a new sender,
 * channel type, or retry path. The dispatcher is opt-in per event and channel,
 * and its outcome is the authority on whether a delivery was attempted.
 *
 * The notification is sent to each admin user. The returned outcome aggregates
 * the dispatcher's real per-admin outcomes so one attempted delivery cannot be
 * hidden by another admin having no enabled channel.
 */
async function maybeAlertAdmins(input: AlertInput): Promise<DispatchOutcome> {
  const subject = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });

  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  if (admins.length === 0) {
    return {
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    };
  }

  const payload = formatAdminAlertPayload({
    ...input,
    subjectLabel: subject?.email ?? input.userId,
  });
  const outcome: DispatchOutcome = {
    dispatched: false,
    channelsAttempted: 0,
    channelsSucceeded: 0,
  };

  for (const admin of admins) {
    const adminOutcome = await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: admin.id,
      title: payload.title,
      message: payload.message,
      metadata: payload.metadata,
    });
    outcome.dispatched ||= adminOutcome.dispatched;
    outcome.channelsAttempted += adminOutcome.channelsAttempted;
    outcome.channelsSucceeded += adminOutcome.channelsSucceeded;
  }

  return outcome;
}
