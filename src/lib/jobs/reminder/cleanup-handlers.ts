/**
 * Retention and maintenance cleanups: rate-limit rows, idempotency keys, audit logs, OAuth states (Withings / WHOOP), mood-reminder events, push attempts, and measurement tombstones.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  cleanupExpiredWhoopConnectTickets,
  cleanupExpiredWhoopOAuthStates,
} from "@/lib/jobs/whoop-oauth-state-cleanup";
import { cleanupExpiredIdempotencyKeys } from "@/lib/jobs/idempotency-cleanup";
import { cleanupExpiredMcpTokens } from "@/lib/jobs/mcp-token-cleanup";
import { cleanupOldAuditLogs } from "@/lib/jobs/audit-log-cleanup";
import { cleanupOldCoachMessages } from "@/lib/jobs/coach-message-cleanup";
import { cleanupExpiredWithingsOAuthStates } from "@/lib/jobs/withings-oauth-state-cleanup";
import { cleanupExpiredOidcNativeHandoffs } from "@/lib/jobs/oidc-handoff-cleanup";
import {
  cleanupExpiredMeasurementTombstones,
  cleanupExpiredMoodTombstones,
  cleanupExpiredIntakeTombstones,
} from "@/lib/jobs/measurement-tombstone-cleanup";
import { getWorkerPrisma } from "./shared";

const MOOD_REMINDER_RETENTION_DAYS = 90;
// v1.4.49 — daily prune for the push-attempt ledger. Same 90-day
// retention as the mood-reminder dispatch ledger; both surfaces are
// behavioural footprints we keep long enough to debug a duplicate-push
// report (~one billing cycle) but no longer. Slots at 03:35 between
// mood-reminder cleanup (03:25) and drain-cumulative (03:45) so the
// 03:xx maintenance window stays ordered.

const PUSH_ATTEMPT_RETENTION_DAYS = 90;
// v1.7.0 — daily prune for soft-deleted measurement tombstones. Rows
// whose `deletedAt` predates the refresh-token lifetime + margin are
// hard-deleted (a device offline that long re-pairs with a full backfill,
// not an incremental delta, so it never relies on the tombstone).
// Retention lives on the helper module keyed to the refresh lifetime so
// the two never drift. Slots at 03:40 between push-attempt cleanup (03:35)
// and the drain (03:45) inside the existing 03:xx maintenance window.

export interface StepUpElevationCleanupPayload {
  _?: never;
}

export interface RateLimitCleanupPayload {
  triggeredAt: string;
}

export interface IdempotencyCleanupPayload {
  triggeredAt: string;
}

export interface AuditLogCleanupPayload {
  triggeredAt: string;
}

export interface CoachMessageCleanupPayload {
  triggeredAt: string;
}

export interface WithingsOAuthStateCleanupPayload {
  triggeredAt: string;
}

/**
 * v0.5.4 ios-coord — daily mood-reminder dispatcher.
 *
 * Delegates the dispatch decision to `runMoodReminderTick` in
 * `mood-reminder.ts` so the unit tests can exercise the logic without
 * spinning up pg-boss. The handler is a thin shim that wires the worker
 * Prisma singleton + the wide-event sink to the pure function.
 */
export interface MoodReminderCleanupPayload {
  triggeredAt: string;
}

export async function handleMoodReminderCleanup(
  jobs: Job<MoodReminderCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.mood_reminder_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - MOOD_REMINDER_RETENTION_DAYS);
      const cutoffIso = cutoff.toISOString().slice(0, 10);
      const deleted = await p.moodReminderDispatch.deleteMany({
        where: { date: { lt: cutoffIso } },
      });
      evt.addMeta("mood_reminder_cleanup_deleted", deleted.count);
    } catch (err) {
      evt.addWarning(`mood-reminder-cleanup failed: ${err}`);
    }
  });
}

/**
 * v1.4.49 — daily prune for the per-attempt push-delivery ledger.
 *
 * Every sender (APNS, WEB_PUSH, TELEGRAM, NTFY) writes one
 * fire-and-forget row to `push_attempts` per dispatch. The admin
 * diagnostic endpoint only ever reads the trailing 20 rows per user,
 * so anything older than the 90-day retention window is dead weight
 * inflating the table and the `(user_id, created_at DESC)` index.
 *
 * The DELETE is unbounded by user — the index covers `created_at`
 * directly, so a `WHERE created_at < cutoff` scan is bounded by the
 * size of the trailing-edge of the table rather than the live working
 * set. On a one-million-row table with the documented retention
 * window, the daily prune touches ~11k rows (1M / 90d × 1d) and
 * completes in milliseconds.
 */
export interface PushAttemptCleanupPayload {
  triggeredAt: string;
}

export async function handlePushAttemptCleanup(
  jobs: Job<PushAttemptCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.push_attempt_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - PUSH_ATTEMPT_RETENTION_DAYS);
      const deleted = await p.pushAttempt.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      evt.addMeta("push_attempt_cleanup_deleted", deleted.count);
    } catch (err) {
      evt.addWarning(`push-attempt-cleanup failed: ${err}`);
    }
  });
}

// v1.31.0 — daily prune for the data-arrival spine's reaction markers.
//
// Fourteen days rather than the ledgers' 90: a reaction marker is a
// same-day surface ("just in", today's one generated line), so a row stops
// being read the moment its local day rolls over. Two weeks is purely a
// debugging margin — long enough to reconstruct what the spine reacted to
// across a reported incident, short enough that a chatty account's markers
// never accumulate. The `created_at` index makes the trailing-edge scan
// cheap, exactly as it does for the push-attempt ledger above.
const ARRIVAL_REACTION_RETENTION_DAYS = 14;

export interface ArrivalReactionCleanupPayload {
  triggeredAt: string;
}

export async function handleArrivalReactionCleanup(
  jobs: Job<ArrivalReactionCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.arrival_reaction_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - ARRIVAL_REACTION_RETENTION_DAYS);
      const deleted = await p.arrivalReaction.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      evt.addMeta("arrival_reaction_cleanup_deleted", deleted.count);
    } catch (err) {
      evt.addWarning(`arrival-reaction-cleanup failed: ${err}`);
    }
  });
}

export interface MeasurementTombstoneCleanupPayload {
  triggeredAt: string;
}

export async function handleMeasurementTombstoneCleanup(
  jobs: Job<MeasurementTombstoneCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent(
    "job.measurement_tombstone_cleanup",
    async (evt) => {
      const p = getWorkerPrisma();
      try {
        // v1.7.0 sync — prune tombstones across all three sync domains on
        // the same retention horizon.
        const [measurements, mood, intakes] = await Promise.all([
          cleanupExpiredMeasurementTombstones(p),
          cleanupExpiredMoodTombstones(p),
          cleanupExpiredIntakeTombstones(p),
        ]);
        evt.addMeta("measurement_tombstone_cleanup_pruned", measurements);
        evt.addMeta("mood_tombstone_cleanup_pruned", mood);
        evt.addMeta("intake_tombstone_cleanup_pruned", intakes);
      } catch (err) {
        evt.addWarning(`tombstone-cleanup failed: ${err}`);
      }
    },
  );
}

export async function handleRateLimitCleanup(
  jobs: Job<RateLimitCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.rate_limit_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const result = await p.$executeRaw`
        DELETE FROM rate_limits WHERE reset_at < NOW()
      `;
      evt.addMeta("rate_limit_cleanup_deleted", result);
    } catch (err) {
      evt.addWarning(`rate-limit-cleanup failed: ${err}`);
    }
  });
}

export async function handleIdempotencyCleanup(
  jobs: Job<IdempotencyCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.idempotency_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupExpiredIdempotencyKeys(p);
      evt.addMeta("idempotency_cleanup_deleted", deleted);
    } catch (err) {
      evt.addWarning(`idempotency-cleanup failed: ${err}`);
    }
  });
}

/**
 * v1.30.34 — sweep expired step-up elevations.
 *
 * Hygiene, not enforcement: an expired row is already unredeemable because
 * `claimStepUpElevation`'s predicate refuses it, so a missed run costs nothing
 * but table space. It lives here rather than fire-and-forget on the mint request
 * because a cross-tenant unbounded DELETE has no business competing with a
 * user's request for a pool connection.
 *
 * The delete lives here rather than in `@/lib/auth/step-up` because it has to
 * run on the WORKER Prisma client; a second copy of the predicate in the auth
 * module would be dead code with a licence to drift.
 */
export async function handleStepUpElevationCleanup(
  jobs: Job<StepUpElevationCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.step_up_elevation_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const { count } = await p.stepUpElevation.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      evt.addMeta("step_up_elevation_cleanup_deleted", count);
    } catch (err) {
      evt.addWarning(`step-up-elevation-cleanup failed: ${err}`);
    }
  });
}

export async function handleAuditLogCleanup(
  jobs: Job<AuditLogCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.audit_log_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupOldAuditLogs(p);
      evt.addMeta("audit_log_cleanup_deleted", deleted);
    } catch (err) {
      evt.addWarning(`audit-log-cleanup failed: ${err}`);
    }
  });
}

export async function handleCoachMessageCleanup(
  jobs: Job<CoachMessageCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.coach_message_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupOldCoachMessages(p);
      evt.addMeta("coach_message_cleanup_deleted", deleted);
    } catch (err) {
      evt.addWarning(`coach-message-cleanup failed: ${err}`);
    }
  });
}

export interface McpTokenCleanupPayload {
  triggeredAt: string;
}

export async function handleMcpTokenCleanup(
  jobs: Job<McpTokenCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.mcp_token_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const result = await cleanupExpiredMcpTokens(p);
      evt.addMeta(
        "mcp_token_cleanup_access_deleted",
        result.accessTokensDeleted,
      );
      evt.addMeta(
        "mcp_token_cleanup_connections_deleted",
        result.connectionsDeleted,
      );
    } catch (err) {
      evt.addWarning(`mcp-token-cleanup failed: ${err}`);
    }
  });
}

export async function handleWithingsOAuthStateCleanup(
  jobs: Job<WithingsOAuthStateCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.withings_oauth_state_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupExpiredWithingsOAuthStates(p);
      evt.addMeta("withings_oauth_state_cleanup_deleted", deleted);
    } catch (err) {
      // The OAuth flow tolerates a stale row sticking around for an
      // extra day — log + carry on so the boss queue doesn't retry-loop.
      evt.addWarning(`withings-oauth-state-cleanup failed: ${err}`);
    }
  });
}

export interface OidcNativeHandoffCleanupPayload {
  triggeredAt?: string;
}

export async function handleOidcNativeHandoffCleanup(
  jobs: Job<OidcNativeHandoffCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.oidc_native_handoff_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupExpiredOidcNativeHandoffs(p);
      evt.addMeta("oidc_native_handoff_cleanup_deleted", deleted);
    } catch (err) {
      // The handoff flow tolerates a stale row for an extra day (expiry is
      // enforced at read) — log + carry on so the boss queue doesn't retry-loop.
      evt.addWarning(`oidc-native-handoff-cleanup failed: ${err}`);
    }
  });
}

export interface WhoopOAuthStateCleanupPayload {
  triggeredAt?: string;
}

export async function handleWhoopOAuthStateCleanup(
  jobs: Job<WhoopOAuthStateCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.whoop_oauth_state_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupExpiredWhoopOAuthStates(p);
      evt.addMeta("whoop_oauth_state_cleanup_deleted", deleted);
      const ticketsDeleted = await cleanupExpiredWhoopConnectTickets(p);
      evt.addMeta("whoop_connect_ticket_cleanup_deleted", ticketsDeleted);
    } catch (err) {
      evt.addWarning(`whoop-oauth-state-cleanup failed: ${err}`);
    }
  });
}
