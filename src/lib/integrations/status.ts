/**
 * Per-(user, integration) sync-status bookkeeping.
 *
 * v1.4.15 Phase B2 introduces three responsibilities for every Withings /
 * moodLog sync attempt:
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
 *                       / `syncMoodLogEntries` short-circuit until the
 *                       user reconnects. Cleared by markReconnected()
 *                       on the OAuth callback.
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
import { getEvent } from "@/lib/logging/context";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

export type IntegrationKey = "withings" | "moodlog";

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
  | "parked";

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
 * Read the current snapshot. Returns a synthetic "connected, never
 * attempted" record when no row exists yet — the UI treats this as
 * "no sync history" without a special case.
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
      state: "connected",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      consecutiveFailuresByKind: null,
    };
  }
  return {
    integration,
    state: row.state as IntegrationState,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastError: row.lastError ? safeDecryptError(row.lastError) : null,
    consecutiveFailuresByKind: readBucketColumn(row.consecutiveFailuresByKind),
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

/**
 * Record a successful sync. Resets the failure counter, clears any
 * prior error message, and (importantly) flips state back to
 * `connected` even from `error_reauth` — the moodLog flow re-enters
 * after the user re-supplies the apiKey, the Withings flow after the
 * OAuth callback writes a new refresh token.
 */
export async function recordSyncSuccess(
  userId: string,
  integration: IntegrationKey,
): Promise<void> {
  const now = new Date();
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
    },
    update: {
      state: "connected",
      lastSuccessAt: now,
      lastAttemptAt: now,
      lastError: null,
      consecutiveFailuresByKind: zeroBuckets(),
      persistentFailureStartedAt: null,
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
 */
export async function recordSyncFailure(
  input: RecordSyncFailureInput,
): Promise<void> {
  const { userId, integration, kind, message, errorCode } = input;
  const now = new Date();
  const encryptedError = safeEncryptError(message);

  // Read the current row first so we can:
  //   (a) compute the new per-kind bucket value
  //   (b) decide whether the persistent streak has exceeded the
  //       park threshold
  const existing = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
    select: {
      consecutiveFailuresByKind: true,
      persistentFailureStartedAt: true,
      alertedAt: true,
    },
  });

  // Resolve the starting bucket envelope:
  //   - existing JSON value if present
  //   - zero envelope for a row that has never written a bucket payload
  //     or for the first-ever write of this (user, integration) pair
  const startingBuckets = readBucketColumn(existing?.consecutiveFailuresByKind);

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
  buckets[kind] = (buckets[kind] ?? 0) + 1;

  // Track the persistent-streak start so the >24h park check has a
  // wall-clock anchor. Only stamped on the FIRST persistent failure of
  // a streak; cleared on success or when the persistent bucket goes
  // back to zero (which today only happens via success, but the logic
  // is symmetric for future "transient drained the streak" rules).
  const isPersistent = kind === "persistent";
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
    : kind === "reauth_required"
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
    },
    update: {
      state: newState,
      lastAttemptAt: now,
      lastError: encryptedError,
      consecutiveFailuresByKind: buckets,
      persistentFailureStartedAt,
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
      kind,
      errorCode: errorCode ?? null,
      message,
      attemptNumber: bucketTotal,
      bucketCount: buckets[kind],
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
      await maybeAlertAdmins({
        userId,
        integration,
        kind,
        message,
        errorCode,
        consecutiveFailures: alertSignal,
      }).catch((err) => {
        getEvent()?.addWarning(
          `Admin alert dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // Stamp the alert window even if dispatch failed — better to
      // miss one notification than to flood admins on a backend
      // outage.
      await prisma.integrationStatus.update({
        where: { userId_integration: { userId, integration } },
        data: { alertedAt: now },
      });
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
}): Promise<void> {
  const { userId, integration, message, errorCode } = opts;
  const now = new Date();
  const encryptedError = safeEncryptError(message);

  // Idempotency probe: re-parking the same scope-skip should NOT emit
  // another audit row. We read the current row first; only write the
  // audit log when the state or error changes.
  const existing = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
    select: { state: true, lastError: true },
  });
  const isFreshPark =
    existing?.state !== "error_reauth" || existing.lastError !== encryptedError;

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
    },
    update: {
      state: "error_reauth",
      lastError: encryptedError,
      lastAttemptAt: now,
      // Deliberately omit `consecutiveFailuresByKind` — the existing
      // bucket values are preserved exactly. This is the whole point
      // of the helper.
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
      lastAttemptAt: new Date(),
    },
    update: {
      state: "error_reauth",
      lastError: safeEncryptError(message),
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
  const integrationLabel =
    input.integration === "withings" ? "Withings" : "moodLog";
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
 * Page admins on Telegram via the existing dispatcher. We do NOT add
 * a new sender, channel type, or retry path — B3 owns that surface.
 * The dispatcher is opt-in per-event and per-channel, so an admin
 * who has not configured Telegram simply gets no message (silent
 * fall-through is the documented behaviour).
 *
 * The notification is sent to EACH admin user with a Telegram channel
 * configured. We resolve recipients once per failure burst (gated by
 * `alertedAt` upstream) so a deployment with a single admin doesn't
 * pay for a query per user.
 */
async function maybeAlertAdmins(input: AlertInput): Promise<void> {
  const subject = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });

  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  if (admins.length === 0) {
    getEvent()?.addWarning(
      `No admin user found to alert about persistent ${input.integration} failure for user ${input.userId}`,
    );
    return;
  }

  const payload = formatAdminAlertPayload({
    ...input,
    subjectLabel: subject?.email ?? input.userId,
  });

  for (const admin of admins) {
    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: admin.id,
      title: payload.title,
      message: payload.message,
      metadata: payload.metadata,
    });
  }
}
