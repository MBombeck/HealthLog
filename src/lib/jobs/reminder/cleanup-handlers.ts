/**
 * Retention and maintenance cleanups: rate-limit rows, idempotency keys, audit logs, OAuth states (Withings / WHOOP) and OAuth callback claims, mood-reminder events, push attempts, and measurement tombstones.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and the queue bindings.
 *
 * Every pass in here used to catch its own failure, write a warning nobody
 * reads, and return — so a retention purge that had not run for weeks was
 * indistinguishable from one with nothing to delete. They now return
 * `jobFailed`, which fails the pg-boss job and puts the queue on the operator's
 * failing-jobs surface.
 *
 * That change has a price, and the registrars pay it: these are bulk DELETEs
 * over a retention horizon, and their failure mode is deterministic. A
 * statement that timed out against a large trailing edge times out again
 * immediately. Under pg-boss's default policy (retryLimit 2, no delay, no
 * backoff) each converted queue would run the same doomed statement three
 * times in a row every night. So every cron-driven cleanup registered from
 * this module is scheduled with `retryLimit: 0`: the failure is recorded once
 * and the next night's tick is the retry, which is the right backoff for
 * retention work that has a whole day of slack.
 */
import { type Job } from "pg-boss";
import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import {
  cleanupExpiredWhoopConnectTickets,
  cleanupExpiredWhoopOAuthStates,
} from "@/lib/jobs/whoop-oauth-state-cleanup";
import { cleanupExpiredIdempotencyKeys } from "@/lib/jobs/idempotency-cleanup";
import { cleanupExpiredMcpTokens } from "@/lib/jobs/mcp-token-cleanup";
import { cleanupOldAuditLogs } from "@/lib/jobs/audit-log-cleanup";
import { cleanupOldCoachMessages } from "@/lib/jobs/coach-message-cleanup";
import { cleanupOldWorkoutInsightClaims } from "@/lib/jobs/workout-insight-claim-cleanup";
import { cleanupExpiredWithingsOAuthStates } from "@/lib/jobs/withings-oauth-state-cleanup";
import { cleanupExpiredOAuthCallbackClaims } from "@/lib/jobs/oauth-callback-claim-cleanup";
import { cleanupExpiredOidcNativeHandoffs } from "@/lib/jobs/oidc-handoff-cleanup";
import {
  cleanupExpiredMeasurementTombstones,
  cleanupExpiredMoodTombstones,
  cleanupExpiredIntakeTombstones,
} from "@/lib/jobs/measurement-tombstone-cleanup";
import { CONFIG_NOTICE_EVENT_TYPE } from "@/lib/notifications/reminder-dedup";
import { getWorkerPrisma } from "./shared";

const MOOD_REMINDER_RETENTION_DAYS = 90;
// v1.4.49 — daily prune for the notification delivery ledger. The attempt
// diagnostics and record-only event anchors share the same 90-day horizon;
// both surfaces are
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
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.mood_reminder_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - MOOD_REMINDER_RETENTION_DAYS);
      // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: retention cutoff; a day either way does not matter
      const cutoffIso = cutoff.toISOString().slice(0, 10);
      // account-deletion: retention ages dispatch rows out whatever their account's state.
      const deleted = await p.moodReminderDispatch.deleteMany({
        where: { date: { lt: cutoffIso } },
      });
      evt.addMeta("mood_reminder_cleanup_deleted", deleted.count);
      return jobDone({ deleted: deleted.count });
    } catch (err) {
      evt.addWarning(`mood-reminder-cleanup failed: ${err}`);
      return jobFailed("mood-reminder cleanup failed", err);
    }
  });
}

/**
 * Daily prune for the bounded notification-delivery ledger.
 *
 * Every sender (APNS, WEB_PUSH, TELEGRAM, NTFY) writes one
 * fire-and-forget row to `push_attempts` per dispatch. The admin
 * diagnostic endpoint only ever reads the trailing 20 rows per user,
 * so anything older than the 90-day retention window is dead weight
 * inflating the table and the `(user_id, created_at DESC)` index. Record-only
 * notification events are claims rather than delivery diagnostics, but after
 * the same horizon their dedup windows have elapsed and they have no reader —
 * with one carve-out: state-scoped admin-config-notice anchors
 * (`CONFIG_NOTICE_EVENT_TYPE`) hold for as long as the configuration state
 * they describe and are released explicitly on state exit, so the horizon
 * delete must not touch them or the once-per-state notice re-fires every
 * 90 days.
 *
 * The DELETE is unbounded by user. The event and attempt ledgers carry direct
 * `created_at` indexes, and final egress claims carry `authorized_at`, so each
 * trailing-edge scan is bounded by the size of the live working set. On a
 * one-million-row table with the documented retention
 * window, the daily prune touches ~11k rows (1M / 90d × 1d) and
 * completes in milliseconds.
 */
export interface PushAttemptCleanupPayload {
  triggeredAt: string;
}

export async function handlePushAttemptCleanup(
  jobs: Job<PushAttemptCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.push_attempt_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - PUSH_ATTEMPT_RETENTION_DAYS);
      // account-deletion: retention ages delivery ledger rows out whatever their account's state.
      const deletedAttempts = await p.pushAttempt.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      // account-deletion: retention, as above.
      const deletedEvents = await p.notificationEvent.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          eventType: { not: CONFIG_NOTICE_EVENT_TYPE },
        },
      });
      // account-deletion: retention, as above.
      const deletedAuthorizations =
        await p.notificationEgressAuthorization.deleteMany({
          where: { authorizedAt: { lt: cutoff } },
        });
      const deleted =
        deletedAttempts.count +
        deletedEvents.count +
        deletedAuthorizations.count;
      evt.addMeta("push_attempt_cleanup_deleted", deletedAttempts.count);
      evt.addMeta("notification_event_cleanup_deleted", deletedEvents.count);
      evt.addMeta(
        "notification_egress_authorization_cleanup_deleted",
        deletedAuthorizations.count,
      );
      return jobDone({ deleted });
    } catch (err) {
      evt.addWarning(`push-attempt-cleanup failed: ${err}`);
      return jobFailed("push-attempt cleanup failed", err);
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
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.arrival_reaction_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - ARRIVAL_REACTION_RETENTION_DAYS);
      // account-deletion: retention ages rows out whatever their account's state.
      const deleted = await p.arrivalReaction.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      evt.addMeta("arrival_reaction_cleanup_deleted", deleted.count);
      return jobDone({ deleted: deleted.count });
    } catch (err) {
      evt.addWarning(`arrival-reaction-cleanup failed: ${err}`);
      return jobFailed("arrival-reaction cleanup failed", err);
    }
  });
}

export interface MeasurementTombstoneCleanupPayload {
  triggeredAt: string;
}

export async function handleMeasurementTombstoneCleanup(
  jobs: Job<MeasurementTombstoneCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent(
    "job.measurement_tombstone_cleanup",
    async (evt) => {
      const p = getWorkerPrisma();
      try {
        // v1.7.0 sync — prune tombstones across all three sync domains on
        // the same retention horizon.
        //
        // v1.33.0 — sequential rather than parallel. Each leg now walks its
        // backlog in batches, and three concurrent walks against the three
        // densest tables competed for the worker pool for no gain: the job has
        // the whole night.
        const measurements = await cleanupExpiredMeasurementTombstones(p);
        const mood = await cleanupExpiredMoodTombstones(p);
        const intakes = await cleanupExpiredIntakeTombstones(p);
        evt.addMeta(
          "measurement_tombstone_cleanup_pruned",
          measurements.deleted,
        );
        evt.addMeta("mood_tombstone_cleanup_pruned", mood.deleted);
        evt.addMeta("intake_tombstone_cleanup_pruned", intakes.deleted);
        // A run that stopped at the batch cap has a backlog left. Without this
        // flag a partial run and a complete one are indistinguishable from
        // outside, which is how a purge that never finished stayed invisible.
        const drained = measurements.drained && mood.drained && intakes.drained;
        evt.addMeta("tombstone_cleanup_drained", drained);
        // Accounts under restore are left alone and purged the next night.
        const deferredAccounts = Math.max(
          measurements.deferredAccounts,
          mood.deferredAccounts,
          intakes.deferredAccounts,
        );
        evt.addMeta("tombstone_cleanup_deferred_accounts", deferredAccounts);
        if (!drained) {
          evt.addWarning(
            "tombstone-cleanup stopped at the batch cap; a backlog remains for the next run",
          );
        }
        return jobDone({
          measurements_pruned: measurements.deleted,
          mood_pruned: mood.deleted,
          intakes_pruned: intakes.deleted,
          drained,
          deferred_accounts: deferredAccounts,
        });
      } catch (err) {
        // Rethrow. A retention purge that fails silently every night looks
        // exactly like one that has nothing to do; pg-boss recording a failed
        // job is the only signal an operator can act on.
        evt.addWarning(`tombstone-cleanup failed: ${err}`);
        throw err;
      }
    },
  );
}

export async function handleRateLimitCleanup(
  jobs: Job<RateLimitCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.rate_limit_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const result = await p.$executeRaw`
        DELETE FROM rate_limits WHERE reset_at < (NOW() AT TIME ZONE 'UTC')
      `;
      evt.addMeta("rate_limit_cleanup_deleted", result);
      return jobDone({ deleted: result });
    } catch (err) {
      evt.addWarning(`rate-limit-cleanup failed: ${err}`);
      return jobFailed("rate-limit cleanup failed", err);
    }
  });
}

export async function handleIdempotencyCleanup(
  jobs: Job<IdempotencyCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.idempotency_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupExpiredIdempotencyKeys(p);
      evt.addMeta("idempotency_cleanup_deleted", deleted);
      return jobDone({ deleted });
    } catch (err) {
      evt.addWarning(`idempotency-cleanup failed: ${err}`);
      return jobFailed("idempotency-key cleanup failed", err);
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
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.step_up_elevation_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      // account-deletion: expires single-use step-up proofs; acts for no account.
      const { count } = await p.stepUpElevation.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      evt.addMeta("step_up_elevation_cleanup_deleted", count);
      return jobDone({ deleted: count });
    } catch (err) {
      evt.addWarning(`step-up-elevation-cleanup failed: ${err}`);
      return jobFailed("step-up elevation cleanup failed", err);
    }
  });
}

export async function handleAuditLogCleanup(
  jobs: Job<AuditLogCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.audit_log_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const outcome = await cleanupOldAuditLogs(p);
      evt.addMeta("audit_log_cleanup_deleted", outcome.deleted);
      evt.addMeta("audit_log_cleanup_drained", outcome.drained);
      if (!outcome.drained) {
        evt.addWarning(
          "audit-log-cleanup stopped at the batch cap; a backlog remains for the next run",
        );
      }
      return jobDone({ deleted: outcome.deleted, drained: outcome.drained });
    } catch (err) {
      // Rethrow — see the tombstone handler. Storage-limitation retention that
      // fails quietly is retention that is not happening.
      evt.addWarning(`audit-log-cleanup failed: ${err}`);
      throw err;
    }
  });
}

export async function handleCoachMessageCleanup(
  jobs: Job<CoachMessageCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.coach_message_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupOldCoachMessages(p);
      evt.addMeta("coach_message_cleanup_deleted", deleted);
      return jobDone({ deleted });
    } catch (err) {
      evt.addWarning(`coach-message-cleanup failed: ${err}`);
      return jobFailed("coach-message cleanup failed", err);
    }
  });
}

export interface WorkoutInsightClaimCleanupPayload {
  triggeredAt: string;
}

export async function handleWorkoutInsightClaimCleanup(
  jobs: Job<WorkoutInsightClaimCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent(
    "job.workout_insight_claim_cleanup",
    async (evt) => {
      const p = getWorkerPrisma();
      try {
        const deleted = await cleanupOldWorkoutInsightClaims(p);
        evt.addMeta("workout_insight_claim_cleanup_deleted", deleted);
        return jobDone({ deleted });
      } catch (err) {
        evt.addWarning(`workout-insight-claim-cleanup failed: ${err}`);
        return jobFailed("workout-insight-claim cleanup failed", err);
      }
    },
  );
}

export interface McpTokenCleanupPayload {
  triggeredAt: string;
}

export async function handleMcpTokenCleanup(
  jobs: Job<McpTokenCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.mcp_token_cleanup", async (evt) => {
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
      return jobDone({
        access_tokens_deleted: result.accessTokensDeleted,
        connections_deleted: result.connectionsDeleted,
      });
    } catch (err) {
      evt.addWarning(`mcp-token-cleanup failed: ${err}`);
      return jobFailed("mcp-token cleanup failed", err);
    }
  });
}

export async function handleWithingsOAuthStateCleanup(
  jobs: Job<WithingsOAuthStateCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent(
    "job.withings_oauth_state_cleanup",
    async (evt) => {
      const p = getWorkerPrisma();
      try {
        const deleted = await cleanupExpiredWithingsOAuthStates(p);
        evt.addMeta("withings_oauth_state_cleanup_deleted", deleted);
        // The provider-neutral callback claims ride this daily pass: the
        // callbacks sweep them only when one completes, which a quiet
        // instance may not see for weeks.
        const claimsDeleted = await cleanupExpiredOAuthCallbackClaims(p);
        evt.addMeta("oauth_callback_claim_cleanup_deleted", claimsDeleted);
        return jobDone({ deleted, callback_claims_deleted: claimsDeleted });
      } catch (err) {
        // The OAuth flow tolerates a stale row for an extra day, which used
        // to be the argument for swallowing this so the queue would not
        // retry-loop. Tolerable is not the same as invisible: the failure is
        // now reported, and the retry-loop worry is answered where it belongs,
        // by the `retryLimit: 0` this queue is scheduled with.
        evt.addWarning(`withings-oauth-state-cleanup failed: ${err}`);
        return jobFailed("withings oauth-state cleanup failed", err);
      }
    },
  );
}

export interface OidcNativeHandoffCleanupPayload {
  triggeredAt?: string;
}

export async function handleOidcNativeHandoffCleanup(
  jobs: Job<OidcNativeHandoffCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.oidc_native_handoff_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupExpiredOidcNativeHandoffs(p);
      evt.addMeta("oidc_native_handoff_cleanup_deleted", deleted);
      return jobDone({ deleted });
    } catch (err) {
      // Expiry is enforced at read, so a stale row for an extra day is
      // harmless — but see the withings twin above: harmless is not a
      // reason to hide the failure. `retryLimit: 0` on the schedule is what
      // keeps a doomed statement from running three times a night.
      evt.addWarning(`oidc-native-handoff-cleanup failed: ${err}`);
      return jobFailed("oidc native-handoff cleanup failed", err);
    }
  });
}

export interface WhoopOAuthStateCleanupPayload {
  triggeredAt?: string;
}

export async function handleWhoopOAuthStateCleanup(
  jobs: Job<WhoopOAuthStateCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.whoop_oauth_state_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupExpiredWhoopOAuthStates(p);
      evt.addMeta("whoop_oauth_state_cleanup_deleted", deleted);
      const ticketsDeleted = await cleanupExpiredWhoopConnectTickets(p);
      evt.addMeta("whoop_connect_ticket_cleanup_deleted", ticketsDeleted);
      return jobDone({
        states_deleted: deleted,
        connect_tickets_deleted: ticketsDeleted,
      });
    } catch (err) {
      evt.addWarning(`whoop-oauth-state-cleanup failed: ${err}`);
      return jobFailed("whoop oauth-state cleanup failed", err);
    }
  });
}
