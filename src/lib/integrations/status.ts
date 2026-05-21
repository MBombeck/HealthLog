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

export type IntegrationState =
  | "connected"
  | "error_transient"
  | "error_reauth"
  | "disconnected";

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
 * is implicitly "reset" by a single success, which clears
 * consecutiveFailures and alertedAt — so a flapping integration that
 * succeeds once an hour will not page repeatedly.
 */
const ALERT_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IntegrationStatusSnapshot {
  integration: IntegrationKey;
  state: IntegrationState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
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
      consecutiveFailures: 0,
    };
  }
  return {
    integration,
    state: row.state as IntegrationState,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastError: row.lastError ? safeDecryptError(row.lastError) : null,
    consecutiveFailures: row.consecutiveFailures,
  };
}

/**
 * Read the current `state` cheaply — used by the sync entry-points
 * to short-circuit when reauth is required.
 */
export async function isReauthRequired(
  userId: string,
  integration: IntegrationKey,
): Promise<boolean> {
  const row = await prisma.integrationStatus.findUnique({
    where: { userId_integration: { userId, integration } },
    select: { state: true },
  });
  return row?.state === "error_reauth";
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
  await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: "connected",
      lastSuccessAt: now,
      lastAttemptAt: now,
      consecutiveFailures: 0,
    },
    update: {
      state: "connected",
      lastSuccessAt: now,
      lastAttemptAt: now,
      lastError: null,
      consecutiveFailures: 0,
      alertedAt: null,
    },
  });
}

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
 *                          future sync attempts — those may succeed once
 *                          the upstream side resolves.
 *
 * v1.4.42 W6 extended this union from `transient | reauth_required` to
 * the three-state taxonomy above; the state-mapping function turns
 * `persistent` into `error_transient` for now (a Withings 293 still
 * lets the next sync run), but the audit detail carries the explicit
 * kind so operations can filter.
 */
export type FailureKind = "transient" | "reauth_required" | "persistent";

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
 *   - increments `consecutive_failures`
 *   - persists the encrypted error message
 *   - writes one `AuditLog` row with `integrations.sync.failed`
 *
 * If `kind === "reauth_required"` the row is parked at `error_reauth`
 * so the next scheduled sync skips. Otherwise the state is marked
 * `error_transient` and the next sync will try again.
 *
 * If the post-update `consecutive_failures` count crosses the alerting
 * threshold AND the alerting window has lapsed, dispatch a Telegram
 * notification to all admins. Failures here are best-effort: a failed
 * dispatch DOES NOT swallow the audit log.
 */
export async function recordSyncFailure(
  input: RecordSyncFailureInput,
): Promise<void> {
  const { userId, integration, kind, message, errorCode } = input;
  const now = new Date();
  // State mapping:
  //   reauth_required → error_reauth (sync entry-point short-circuits)
  //   transient       → error_transient (next sync still runs)
  //   persistent      → error_transient (next sync still runs, but the
  //                     audit detail carries `kind: "persistent"` so
  //                     operations can grep for contract-bug bursts)
  const newState: IntegrationState =
    kind === "reauth_required" ? "error_reauth" : "error_transient";

  // Encrypt the error before persisting. crypto.encrypt() handles all
  // edge cases (empty string, etc.) — we just have to give it a string.
  const encryptedError = safeEncryptError(message);

  const row = await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: newState,
      lastAttemptAt: now,
      lastError: encryptedError,
      consecutiveFailures: 1,
    },
    update: {
      state: newState,
      lastAttemptAt: now,
      lastError: encryptedError,
      consecutiveFailures: { increment: 1 },
    },
  });

  // Audit log entry — fire-and-await so an integration test can assert
  // it. The auth/audit helper is its own DB write so it's safe to call
  // serially without bloating latency in the success path (which never
  // calls this).
  await auditLog("integrations.sync.failed", {
    userId,
    details: {
      integration,
      kind,
      errorCode: errorCode ?? null,
      message,
      attemptNumber: row.consecutiveFailures,
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
  const threshold = getPersistentFailureThreshold();
  if (row.consecutiveFailures >= threshold) {
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
        consecutiveFailures: row.consecutiveFailures,
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
}

/**
 * Park a connection at `error_reauth` from a deliberate scope-skip
 * short-circuit. Unlike `recordSyncFailure`, this helper:
 *
 *   1. does NOT increment `consecutiveFailures`.
 *   2. does NOT write an `integrations.sync.failed` audit row through
 *      `recordSyncFailure`. A standalone `integrations.reauth_required`
 *      row is written instead so the operations trail still shows the
 *      park event.
 *   3. does NOT enter the 3-strike alert ladder — no admin Telegram
 *      page fires.
 *
 * Idempotent: a second call for the same scope-skip leaves the row at
 * `error_reauth` with the same encrypted message and the same counter
 * value (no increment). Use it from sync routines that have detected a
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
      // First-ever row for this (user, integration) — counter stays at
      // 0 so a later genuine transient burst still has the full
      // 3-strike runway before paging.
      consecutiveFailures: 0,
    },
    update: {
      state: "error_reauth",
      lastError: encryptedError,
      lastAttemptAt: now,
      // Deliberately omit `consecutiveFailures` — the existing value
      // is preserved exactly. This is the whole point of the helper.
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
  await prisma.integrationStatus.upsert({
    where: { userId_integration: { userId, integration } },
    create: {
      userId,
      integration,
      state: "error_reauth",
      lastError: safeEncryptError(message),
      consecutiveFailures: 1,
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
    },
    update: {
      state: "disconnected",
      lastError: null,
      consecutiveFailures: 0,
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
    },
    update: {
      state: "connected",
      lastError: null,
      consecutiveFailures: 0,
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
