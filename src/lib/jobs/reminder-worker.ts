/**
 * pg-boss based reminder worker.
 * Checks for overdue medication intakes and creates reminder events.
 * Sends notifications via the dispatcher (Telegram, ntfy, Web Push).
 *
 * Usage: Run as a standalone process or call startReminderWorker() from a
 * custom server setup. In dev, use: npx tsx src/lib/jobs/reminder-worker.ts
 */
import { PgBoss } from "pg-boss";
import type { Job } from "pg-boss";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  scheduleEmitsInWindow,
  shouldMintMissedDoseRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { syncUserActivity } from "@/lib/withings/sync-activity";
import { syncUserSleep } from "@/lib/withings/sync-sleep";
import { generateGeneralStatusForUser } from "@/lib/insights/general-status";
import { generateBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import { generateWeightStatusForUser } from "@/lib/insights/weight-status";
import { generatePulseStatusForUser } from "@/lib/insights/pulse-status";
import { generateBmiStatusForUser } from "@/lib/insights/bmi-status";
import { generateMedicationComplianceStatusForUser } from "@/lib/insights/medication-compliance-status";
import {
  markWorkerStarted,
  recordReminderCheck,
  recordWithingsSync,
  recordInsightsRun,
  recordError,
} from "@/lib/jobs/worker-status";
import { setGlobalBoss } from "@/lib/jobs/boss-instance";
import { cleanupExpiredIdempotencyKeys } from "@/lib/jobs/idempotency-cleanup";
import { cleanupOldAuditLogs } from "@/lib/jobs/audit-log-cleanup";
import { cleanupExpiredWithingsOAuthStates } from "@/lib/jobs/withings-oauth-state-cleanup";
import {
  cleanupExpiredMeasurementTombstones,
  cleanupExpiredMoodTombstones,
  cleanupExpiredIntakeTombstones,
} from "@/lib/jobs/measurement-tombstone-cleanup";
import { runHostMetricTick } from "@/lib/jobs/host-metric-sampler";
import { aggregateRecommendationFeedback } from "@/lib/jobs/feedback-aggregator";
import {
  runGeoBackfill,
  GEO_BACKFILL_QUEUE,
  GEO_BACKFILL_CRON,
} from "@/lib/jobs/geo-backfill";
import {
  PR_DETECTION_QUEUE,
  PR_DETECTION_CONCURRENCY,
  PR_DETECTION_FALLBACK_CRON,
  type PrDetectionPayload,
} from "@/lib/jobs/pr-detection";
import { detectPersonalRecordsForUser } from "@/lib/personal-records/pr-detection-worker";
import {
  MEDICATION_INVENTORY_EXPIRE_QUEUE,
  MEDICATION_INVENTORY_EXPIRE_CRON,
  type MedicationInventoryExpirePayload,
} from "@/lib/jobs/medication-inventory-expire";
import {
  INSIGHT_PREGENERATE_QUEUE,
  INSIGHT_PREGENERATE_CRON,
  runInsightPregenerate,
  type InsightPregeneratePayload,
} from "@/lib/jobs/insight-pregenerate";
import {
  INSIGHT_STATUS_GENERATE_QUEUE,
  INSIGHT_STATUS_GENERATE_CONCURRENCY,
  runInsightStatusGenerate,
  type InsightStatusGeneratePayload,
} from "@/lib/jobs/insight-status-generate";
import {
  INTAKE_AUTO_SKIP_QUEUE,
  INTAKE_AUTO_SKIP_CRON,
  runIntakeAutoSkipPass,
  type IntakeAutoSkipPayload,
} from "@/lib/jobs/intake-auto-skip";
import {
  APPLE_HEALTH_IMPORT_QUEUE,
  APPLE_HEALTH_IMPORT_CONCURRENCY,
  handleAppleHealthImport,
  reconcileOrphanImportJobs,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
import {
  ROLLUP_FULL_BACKFILL_QUEUE,
  ROLLUP_FULL_BACKFILL_CONCURRENCY,
  ROLLUP_RECOMPUTE_QUEUE,
  ROLLUP_RECOMPUTE_CONCURRENCY,
  enqueueBootTimeRollupBackfill,
  recomputeUserRollups,
  type RollupFullBackfillPayload,
  type RollupRecomputePayload,
} from "@/lib/rollups/measurement-rollups";
import {
  MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
  MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY,
  MOOD_ROLLUP_RECOMPUTE_QUEUE,
  MOOD_ROLLUP_RECOMPUTE_CONCURRENCY,
  enqueueBootTimeMoodRollupBackfill,
  recomputeUserMoodRollups,
  type MoodRollupFullBackfillPayload,
  type MoodRollupRecomputePayload,
} from "@/lib/rollups/mood-rollups";
import {
  MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
  MEDICATION_COMPLIANCE_BACKFILL_CONCURRENCY,
  recomputeMedicationComplianceForEvent,
  recomputeUserMedicationCompliance,
  enqueueBootTimeMedicationComplianceBackfill,
  type MedicationComplianceBackfillPayload,
} from "@/lib/rollups/medication-compliance-rollups";
import {
  drainPerSampleCumulative,
  DRAIN_CUMULATIVE_CUTOFF_HOURS,
} from "@/lib/measurements/drain-per-sample-cumulative";
import {
  STEP_CONSOLIDATION_QUEUE,
  STEP_CONSOLIDATION_CONCURRENCY,
  runStepConsolidationForUser,
  enqueueBootTimeStepConsolidation,
  type StepConsolidationPayload,
} from "@/lib/jobs/step-consolidation";
import {
  MEAN_CONSOLIDATION_QUEUE,
  MEAN_CONSOLIDATION_CONCURRENCY,
  runMeanConsolidationForUser,
  enqueueBootTimeMeanConsolidation,
  type MeanConsolidationPayload,
} from "@/lib/jobs/mean-consolidation";
import {
  INTAKE_SLOT_DEDUP_QUEUE,
  INTAKE_SLOT_DEDUP_CONCURRENCY,
  dedupeUserIntakeSlots,
  enqueueBootTimeIntakeSlotDedup,
  type IntakeSlotDedupPayload,
} from "@/lib/medications/intake-slot-dedup";
import { expireStaleInUseItems } from "@/lib/medications/inventory/service";
import { rotateLegacyMoodLogSecrets } from "@/lib/moodlog-secret";
import { probeIntegrationStatusNullBuckets } from "@/lib/jobs/integration-status-null-probe";
import { deleteMessage } from "@/lib/telegram";
import { decrypt, encrypt } from "@/lib/crypto";
import { syncMoodLogEntries } from "@/lib/moodlog/sync";
import {
  DEFAULT_PHASE_CONFIG,
  resolvePhaseThresholds,
  determinePhase,
  getPhaseMessage,
  getPhaseKeyboard,
} from "@/lib/jobs/reminder-phases";
import { runMoodReminderTick } from "@/lib/jobs/mood-reminder";
import { isMedicationReminderClientManaged } from "@/lib/validations/notification-prefs";
import { withBackgroundEvent } from "@/lib/logging/background";
import { assertSubsystemEnabled } from "@/lib/process-type";
import { runOffhostBackup } from "@/lib/jobs/offhost-backup";
import {
  getUserTodayBounds as getUserTodayBoundsUtil,
  localHmAsUtc,
} from "@/lib/timezone";

function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  // Some Node ICU builds render midnight as "24:00" via toLocaleTimeString.
  // Normalize so comparisons against schedule windows that wrap midnight
  // don't produce a 1440-minute value.
  const hours = h === 24 ? 0 : h;
  return hours * 60 + m;
}

const DATABASE_URL = process.env.DATABASE_URL!;

// Reuse a single PrismaClient across all job handlers to avoid connection pool exhaustion
let workerPrisma: PrismaClient | null = null;

function getWorkerPrisma(): PrismaClient {
  if (!workerPrisma) {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    workerPrisma = new PrismaClient({ adapter });
  }
  return workerPrisma;
}

const QUEUE_NAME = "medication-reminder-check";
const CHECK_INTERVAL_CRON = "*/15 * * * *"; // every 15 minutes
const WITHINGS_SYNC_QUEUE = "withings-fallback-sync";
const WITHINGS_SYNC_CRON = "0 * * * *"; // every 60 minutes
// v1.4.25 W17b/c — webhook-primary + cron-safety-net for activity and
// sleep v2. The webhook handler enqueues per-user jobs on appli=16 / 44
// notifications; the crons below are the catch-net for the 1 % of
// notifications Withings drops. Offset 15-minute cadence per the
// research recommendation so the two queues don't lockstep against the
// existing measure cron at :00.
const WITHINGS_ACTIVITY_QUEUE = "withings-activity-sync";
const WITHINGS_ACTIVITY_CRON = "0 * * * *"; // every hour at :00
const WITHINGS_SLEEP_QUEUE = "withings-sleep-sync";
const WITHINGS_SLEEP_CRON = "15 * * * *"; // every hour at :15
const GENERAL_STATUS_QUEUE = "insights-general-status";
const GENERAL_STATUS_CRON = "0 2 * * *"; // daily at 02:00
const BLOOD_PRESSURE_STATUS_QUEUE = "insights-blood-pressure-status";
const BLOOD_PRESSURE_STATUS_CRON = "5 2 * * *"; // daily at 02:05
const WEIGHT_STATUS_QUEUE = "insights-weight-status";
const WEIGHT_STATUS_CRON = "10 2 * * *"; // daily at 02:10
const PULSE_STATUS_QUEUE = "insights-pulse-status";
const PULSE_STATUS_CRON = "15 2 * * *"; // daily at 02:15
const BMI_STATUS_QUEUE = "insights-bmi-status";
const BMI_STATUS_CRON = "20 2 * * *"; // daily at 02:20
const MEDICATION_COMPLIANCE_STATUS_QUEUE =
  "insights-medication-compliance-status";
const MEDICATION_COMPLIANCE_STATUS_CRON = "25 2 * * *"; // daily at 02:25
const MOODLOG_SYNC_QUEUE = "moodlog-sync";
const MOODLOG_SYNC_CRON = "30 * * * *"; // every hour at :30
const DATA_BACKUP_QUEUE = "data-backup";
const DATA_BACKUP_CRON = "0 3 * * 0"; // weekly Sunday at 03:00
const RATE_LIMIT_CLEANUP_QUEUE = "rate-limit-cleanup";
const RATE_LIMIT_CLEANUP_CRON = "*/5 * * * *"; // every 5 minutes
const IDEMPOTENCY_CLEANUP_QUEUE = "idempotency-cleanup";
const IDEMPOTENCY_CLEANUP_CRON = "0 3 * * *"; // daily at 03:00 (Europe/Berlin)
const AUDIT_LOG_CLEANUP_QUEUE = "audit-log-cleanup";
const AUDIT_LOG_CLEANUP_CRON = "15 3 * * *"; // daily at 03:15 (Europe/Berlin)
// v1.4.47 W6 — daily sweep for the Withings OAuth state ledger. Slots
// at :20 between the audit-log cleanup (:15) and the mood-reminder
// cleanup (:25), inside the existing 02:xx-03:xx maintenance window.
// Rows are normally consumed by the callback handler in single-use
// fashion; this sweep picks up the long tail where a user closed the
// Withings approval tab without bouncing back to the callback URL.
const WITHINGS_OAUTH_STATE_CLEANUP_QUEUE = "withings-oauth-state-cleanup";
const WITHINGS_OAUTH_STATE_CLEANUP_CRON = "20 3 * * *";
const OFFHOST_BACKUP_QUEUE = "data-backup-offhost";
// 02:30 Europe/Berlin — runs after audit-log/idempotency cleanups so old
// rows are gone before they're snapshotted, but before the existing
// in-DB DATA_BACKUP at 03:00 (Sundays only) so the off-host copy is
// always at-or-ahead of the local one.
const OFFHOST_BACKUP_CRON = "30 2 * * *";
const HOST_METRIC_QUEUE = "host-metric-sample";
// Per-minute cadence — matches the chart's 60s polling refetchInterval.
const HOST_METRIC_CRON = "* * * * *";
// v1.4.16 phase B5e — daily rec-feedback aggregator. 04:00 Europe/Berlin
// runs the slot AFTER all the cleanup jobs (rate-limit, idempotency,
// audit-log) so the previous-day's noise is gone before we aggregate.
const FEEDBACK_AGGREGATOR_QUEUE = "feedback-aggregator";
const FEEDBACK_AGGREGATOR_CRON = "0 4 * * *";
// v1.4.37 — hourly geo backfill. Queue name + cron expression live
// in `@/lib/jobs/geo-backfill` so a unit test can pin the scheduling
// contract without importing this worker boot file.
// v1.4.37 W7c — nightly drain of per-sample APPLE_HEALTH cumulative
// rows. Collapses each user × cumulative-type × calendar-day bucket
// into one `stats:…` row so the list view stops painting hundreds of
// step chunks per day. 03:45 Europe/Berlin slots in between the
// 03:15 audit-log cleanup and the 04:00 feedback aggregator. The
// 36-hour grace window keeps today + the trailing watch-sync window
// intact for real-time visibility; only completed-and-stable days
// fall to the drain.
const DRAIN_CUMULATIVE_QUEUE = "drain-per-sample-cumulative";
const DRAIN_CUMULATIVE_CRON = "45 3 * * *";
// v0.5.4 ios-coord — daily mood-reminder cron.
//
// Runs every 15 minutes so the handler can pick up users whose local
// time has just crossed 22:00 across any IANA timezone without having
// to schedule one cron entry per zone. The handler short-circuits when
// the user's local hour isn't 22, so the 15-min cadence translates to
// ~4 ticks-per-hour × 1 actual-dispatch-window-per-user = at most one
// push per user per day. Idempotency is enforced by the
// `MoodReminderDispatch` ledger inside the handler.
const MOOD_REMINDER_QUEUE = "mood-reminder-check";
const MOOD_REMINDER_CRON = "*/15 * * * *";
// v1.4.38.2 — daily retention sweep for the mood-reminder dispatch
// ledger. Rows older than 90 days are behavioural footprints of
// mood-log gaps; we keep them long enough to debug a duplicate-push
// report (~one billing cycle) but no longer. Slots between the
// audit-log cleanup (03:15) and the drain (03:45).
const MOOD_REMINDER_CLEANUP_QUEUE = "mood-reminder-cleanup";
const MOOD_REMINDER_CLEANUP_CRON = "25 3 * * *";
const MOOD_REMINDER_RETENTION_DAYS = 90;
// v1.4.49 — daily prune for the push-attempt ledger. Same 90-day
// retention as the mood-reminder dispatch ledger; both surfaces are
// behavioural footprints we keep long enough to debug a duplicate-push
// report (~one billing cycle) but no longer. Slots at 03:35 between
// mood-reminder cleanup (03:25) and drain-cumulative (03:45) so the
// 03:xx maintenance window stays ordered.
const PUSH_ATTEMPT_CLEANUP_QUEUE = "push-attempt-cleanup";
const PUSH_ATTEMPT_CLEANUP_CRON = "35 3 * * *";
const PUSH_ATTEMPT_RETENTION_DAYS = 90;
// v1.7.0 — daily prune for soft-deleted measurement tombstones. Rows
// whose `deletedAt` predates the refresh-token lifetime + margin are
// hard-deleted (a device offline that long re-pairs with a full backfill,
// not an incremental delta, so it never relies on the tombstone).
// Retention lives on the helper module keyed to the refresh lifetime so
// the two never drift. Slots at 03:40 between push-attempt cleanup (03:35)
// and the drain (03:45) inside the existing 03:xx maintenance window.
const MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE = "measurement-tombstone-cleanup";
const MEASUREMENT_TOMBSTONE_CLEANUP_CRON = "40 3 * * *";
// v1.4.38 — the per-sample cutoff hours constant now lives on the
// helper module so the worker, the admin route, and the CLI all read
// the same source of truth. Re-export pulled in alongside
// `drainPerSampleCumulative` above.
interface DrainCumulativePayload {
  triggeredAt: string;
}

interface ReminderCheckPayload {
  triggeredAt: string;
}

interface WithingsSyncPayload {
  triggeredAt: string;
}

/**
 * v1.4.25 W17b — payload for the activity-sync queue. When enqueued
 * by the webhook handler, `userId` is set so the worker syncs only
 * that user; when enqueued by the cron schedule, `userId` is absent
 * and the worker iterates every connection (safety-net behaviour).
 */
interface WithingsActivitySyncPayload {
  triggeredAt: string;
  userId?: string;
}

/**
 * v1.4.25 W17c — payload for the sleep-sync queue. Same shape and
 * webhook-vs-cron semantics as the activity payload.
 */
interface WithingsSleepSyncPayload {
  triggeredAt: string;
  userId?: string;
}

interface GeneralStatusPayload {
  triggeredAt: string;
}

interface BloodPressureStatusPayload {
  triggeredAt: string;
}

interface WeightStatusPayload {
  triggeredAt: string;
}

interface PulseStatusPayload {
  triggeredAt: string;
}

interface BmiStatusPayload {
  triggeredAt: string;
}

interface MedicationComplianceStatusPayload {
  triggeredAt: string;
}

interface MoodLogSyncPayload {
  triggeredAt: string;
}

interface DataBackupPayload {
  triggeredAt: string;
}

interface RateLimitCleanupPayload {
  triggeredAt: string;
}

interface IdempotencyCleanupPayload {
  triggeredAt: string;
}

interface AuditLogCleanupPayload {
  triggeredAt: string;
}

interface WithingsOAuthStateCleanupPayload {
  triggeredAt: string;
}

interface OffhostBackupPayload {
  triggeredAt: string;
}

interface HostMetricSamplePayload {
  triggeredAt: string;
}

interface FeedbackAggregatorPayload {
  triggeredAt: string;
}

interface GeoBackfillPayload {
  triggeredAt: string;
}

interface MoodReminderPayload {
  triggeredAt: string;
}

// Re-export timezone utilities under local names for backward compatibility
const getUserTodayBounds = getUserTodayBoundsUtil;

/**
 * Process expired TelegramScheduledDeletion records.
 * Deletes messages from Telegram and removes the DB records.
 * Called at the start of every reminder check (every 15 minutes).
 */
async function cleanupScheduledTelegramDeletions(): Promise<void> {
  const prisma = getWorkerPrisma();
  try {
    let totalDeleted = 0;

    // Process in batches until all expired records are handled
    while (true) {
      const expired = await prisma.telegramScheduledDeletion.findMany({
        where: { deleteAfter: { lte: new Date() } },
        take: 100,
      });

      if (expired.length === 0) break;

      // Group by userId to fetch bot token once per user
      const byUser = new Map<
        string,
        { chatId: string; messageId: number; id: string }[]
      >();
      for (const record of expired) {
        const list = byUser.get(record.userId) ?? [];
        list.push({
          chatId: record.chatId,
          messageId: record.messageId,
          id: record.id,
        });
        byUser.set(record.userId, list);
      }

      const deletedIds: string[] = [];
      for (const [userId, messages] of byUser) {
        const user = await prisma.user.findFirst({
          where: { id: userId, telegramBotToken: { not: null } },
          select: { telegramBotToken: true },
        });
        if (!user?.telegramBotToken) {
          // No bot token — just clean up the records
          deletedIds.push(...messages.map((m) => m.id));
          continue;
        }
        const botToken = decrypt(user.telegramBotToken);
        for (const msg of messages) {
          try {
            await deleteMessage(botToken, msg.chatId, msg.messageId);
          } catch {
            // Best-effort: message may already be deleted
          }
          deletedIds.push(msg.id);
        }
      }

      if (deletedIds.length > 0) {
        await prisma.telegramScheduledDeletion.deleteMany({
          where: { id: { in: deletedIds } },
        });
        totalDeleted += deletedIds.length;
      }
    }

    if (totalDeleted > 0) {
      const { getEvent } = await import("@/lib/logging/context");
      getEvent()?.addMeta("telegram_scheduled_cleanup", totalDeleted);
    }
  } catch (err) {
    const { getEvent } = await import("@/lib/logging/context");
    getEvent()?.addWarning(`telegram-scheduled-cleanup failed: ${err}`);
  }
}

/**
 * Check all active medications for each user and determine reminder phases.
 * Uses phase-based logic (GREEN/YELLOW/ORANGE/RED) to send one notification
 * per phase transition rather than every 15 minutes.
 */
async function handleReminderCheck(jobs: Job<ReminderCheckPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.medication_reminder", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      recordReminderCheck();
      const now = new Date();

      // Clean up expired scheduled Telegram message deletions
      await cleanupScheduledTelegramDeletions();

      // Clean up expired snoozes
      await prisma.medication.updateMany({
        where: { snoozedUntil: { lt: now } },
        data: { snoozedUntil: null },
      });

      // Get all active medications with schedules and phase config
      const medications = await prisma.medication.findMany({
        where: { active: true },
        include: {
          schedules: true,
          phaseConfig: true,
          user: {
            select: {
              id: true,
              timezone: true,
              // Used to localise the reminder title / message / keyboard
              // labels per user. Null falls back to the app default.
              locale: true,
              // v1.4.49 M-DOUBLE-REMINDER — read the per-user prefs
              // blob so the dispatch step can skip APNs sends for users
              // whose iOS client has opted in to local SpeziScheduler
              // reminders. Null = legacy default (clientManaged: false),
              // i.e. the server reminder fires as before.
              notificationPrefs: true,
            },
          },
        },
      });

      for (const med of medications) {
        const userTz = med.user.timezone || "Europe/Berlin";
        const { start: todayStart, end: todayEnd } = getUserTodayBounds(
          now,
          userTz,
        );

        const currentTime = now.toLocaleTimeString("en-GB", {
          timeZone: userTz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

        // Get today's date string in user's timezone for message tracking
        const localDateStr = now.toLocaleDateString("sv-SE", {
          timeZone: userTz,
        }); // YYYY-MM-DD format

        // v1.7.0 code-correctness M4 — fetch today's intake events so a
        // logged dose suppresses the reminder for the SLOT it belongs to,
        // not a positional running counter. The pre-v1.7 code suppressed
        // by `eventCount > schedulesProcessed`, which attributed a logged
        // morning dose to whichever slot iterated first; with an unsorted
        // `timesOfDay = ["20:00","08:00"]` that suppressed the evening
        // reminder while the morning still fired. We match by time-of-day
        // proximity instead. Worker-minted RED placeholders (takenAt null,
        // not skipped, source REMINDER) are NOT a user action, so they are
        // excluded from the suppression set.
        const todayEvents = await prisma.medicationIntakeEvent.findMany({
          where: {
            medicationId: med.id,
            userId: med.user.id,
            // v1.7.0 sync — a tombstoned dose is no longer a logged
            // action, so it must not suppress today's reminder.
            deletedAt: null,
            scheduledFor: { gte: todayStart, lte: todayEnd },
          },
          select: { scheduledFor: true, takenAt: true, skipped: true },
        });
        const loggedDoseInstants = todayEvents
          .filter((e) => e.takenAt !== null || e.skipped)
          .map((e) => (e.takenAt ?? e.scheduledFor).getTime());

        // Resolve phase configuration
        const phaseConfig = med.phaseConfig ?? DEFAULT_PHASE_CONFIG;

        // Slots a logged dose has already claimed (by index into the
        // chronologically-sorted slotTimes) so one dose can't suppress two.
        const claimedSlotInstants = new Set<number>();

        const sortedSchedules = [...med.schedules].sort((a, b) =>
          a.windowStart.localeCompare(b.windowStart),
        );

        // v1.5.0 — fetch the latest `takenAt` for this medication
        // once per tick when any schedule on it is rolling. The
        // canonical recurrence engine needs `lastIntakeAt` to compute
        // the next-due instant for rolling cadences; calendar
        // cadences ignore the field, so the fetch is conditional to
        // avoid an extra round-trip on the common path. Failures bias
        // toward "treat as never logged" so a flaky DB doesn't
        // suppress reminders.
        const hasRollingSchedule = med.schedules.some(
          (s) => s.rollingIntervalDays !== null,
        );
        let lastIntakeAt: Date | null = null;
        if (hasRollingSchedule) {
          const lastIntake = await prisma.medicationIntakeEvent.findFirst({
            where: {
              userId: med.user.id,
              medicationId: med.id,
              // v1.7.0 sync — a tombstoned intake no longer anchors the
              // rolling-interval next-due computation.
              deletedAt: null,
              takenAt: { not: null },
            },
            orderBy: { takenAt: "desc" },
            select: { takenAt: true },
          });
          lastIntakeAt = lastIntake?.takenAt ?? null;
        }

        for (const schedule of sortedSchedules) {
          // v1.5.0 — route every "does today emit a slot?" decision
          // through the canonical recurrence engine. Replaces the
          // legacy weekday-only filter that silently ignored
          // `intervalWeeks` (the pre-v1.5 bi-weekly bug — a Wed
          // bi-weekly schedule fired every Wed instead of every other
          // Wed). The engine honours RRULE / rolling / one-shot /
          // legacy-with-interval-weeks / `endsOn` cap; no special-
          // casing here.
          const canonicalSchedule = buildCanonicalSchedule(schedule);
          const recurrenceCtx = buildRecurrenceContext({
            medication: med,
            userTz,
            lastIntakeAt,
          });
          if (
            !scheduleEmitsInWindow(
              canonicalSchedule,
              recurrenceCtx,
              todayStart,
              todayEnd,
            )
          ) {
            continue;
          }

          // v1.7.0 SB-SCHED-4 — multi-time-of-day dispatch. A schedule
          // with `timesOfDay = ["08:00","20:00"]` is two distinct dose
          // slots per day; the pre-v1.7 worker keyed phase + dedup on the
          // single `windowStart`, so the evening dose never reminded.
          // Iterate every first-class time-of-day, each with its own
          // window (anchored at the time, spanning the legacy
          // `windowEnd - windowStart` duration), phase, dedup key
          // (now including the time-of-day), and RED-mint instant.
          //
          // The legacy single-window contract is preserved: a schedule
          // with no first-class `timesOfDay` emits exactly one slot at
          // `windowStart` with `timeOfDay = ""`, which dedupes against
          // pre-v1.7 rows (backfilled to "") byte-for-byte.
          const baseStartMins = parseTimeToMinutes(schedule.windowStart);
          const baseEndMins = parseTimeToMinutes(schedule.windowEnd);
          const windowDuration = baseEndMins - baseStartMins;
          const currentMins = parseTimeToMinutes(currentTime);

          const hasFirstClassTimes =
            schedule.timesOfDay && schedule.timesOfDay.length > 0;
          // v1.7.0 code-correctness M4 — iterate slots in chronological
          // order so phase/dedup/suppression decisions are deterministic
          // and a logged dose maps to the nearest slot, not whichever the
          // stored array order happened to surface first.
          const slotTimes = (
            hasFirstClassTimes ? [...schedule.timesOfDay] : [schedule.windowStart]
          ).sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));

          for (const slotTime of slotTimes) {
            // Dedup key time-of-day: "" for a legacy single-window
            // schedule (byte-stable against pre-v1.7 rows), else the
            // explicit HH:mm.
            const dedupTimeOfDay = hasFirstClassTimes ? slotTime : "";
            const slotStartMins = parseTimeToMinutes(slotTime);
            const slotEndMins = slotStartMins + windowDuration;
            const minutesToEnd = slotEndMins - currentMins;
            const minutesFromStart = currentMins - slotStartMins;

            // The UTC instant this slot is due (DST-safe).
            const [slotH, slotM] = slotTime.split(":").map(Number);
            const slotInstant = localHmAsUtc(
              now,
              med.user.timezone,
              slotH,
              slotM,
            ).getTime();

            // Suppress this slot's reminder if a user-logged dose (taken
            // or skipped) sits within half the window duration of the
            // slot's due time. Matching by proximity — not a positional
            // counter — means a partially-dosed day still reminds for the
            // correct missing slot. Each logged dose claims at most one
            // slot so two slots can't both be suppressed by one dose.
            const matchRadiusMs =
              Math.max(windowDuration, 60) * 60_000 * 0.5;
            let matchedIdx = -1;
            let matchedDist = Infinity;
            for (let li = 0; li < loggedDoseInstants.length; li++) {
              if (claimedSlotInstants.has(li)) continue;
              const dist = Math.abs(loggedDoseInstants[li] - slotInstant);
              if (dist <= matchRadiusMs && dist < matchedDist) {
                matchedDist = dist;
                matchedIdx = li;
              }
            }
            if (matchedIdx >= 0) {
              claimedSlotInstants.add(matchedIdx);
              continue;
            }

            // Skip if medication is snoozed
            if (med.snoozedUntil && now < med.snoozedUntil) {
              continue;
            }

            // Resolve phase thresholds
            const thresholds = resolvePhaseThresholds(
              phaseConfig,
              windowDuration,
            );

            // Determine current phase for this slot's window.
            const currentPhase = determinePhase(
              minutesToEnd,
              minutesFromStart,
              thresholds,
            );

            if (!currentPhase) {
              continue;
            }

            // Check if this phase was already notified today for this
            // time-of-day.
            const existingMessage =
              await prisma.telegramReminderMessage.findUnique({
                where: {
                  medicationId_scheduleId_date_phase_timeOfDay: {
                    medicationId: med.id,
                    scheduleId: schedule.id,
                    date: localDateStr,
                    phase: currentPhase,
                    timeOfDay: dedupTimeOfDay,
                  },
                },
              });

            if (existingMessage) {
              // Already sent for this phase + time-of-day — skip
              continue;
            }

            const doseInfo = schedule.dose ?? med.dose;
            const timeWindow = `${slotTime}`;

            // DST-safe slot instant, computed once above.
            const slotScheduledFor = new Date(slotInstant);

            // RED phase: create missed intake event for this slot.
            if (currentPhase === "RED") {
              // v1.8.2 — gate the missed-dose mint through the shared
              // guard. It refuses to mint when the slot already carries an
              // existing pending REMINDER row (P2002-collision avoidance,
              // tombstones included) OR an ACTIONED row (taken / skipped)
              // from ANY source. The intake write paths snap a "Genommen" /
              // "Übersprungen" write onto the canonical slot instant
              // (source-agnostic update), so a user who acted before the
              // RED phase opens has a live taken/skipped row at this exact
              // slot — minting here would re-create the duplicate the
              // write paths just collapsed.
              const shouldMint = await shouldMintMissedDoseRow(prisma, {
                userId: med.user.id,
                medicationId: med.id,
                scheduledFor: slotScheduledFor,
              });

              if (shouldMint) {
                await prisma.medicationIntakeEvent.create({
                  data: {
                    userId: med.user.id,
                    medicationId: med.id,
                    scheduledFor: slotScheduledFor,
                    takenAt: null,
                    skipped: false,
                    source: "REMINDER",
                  },
                });

                evt.addMeta("missed_dose", `${med.name}:${slotTime}`);

                // v1.4.39 W-MED — refresh the compliance rollup so the
                // per-day `scheduled` count increments before any read.
                await recomputeMedicationComplianceForEvent({
                  userId: med.user.id,
                  medicationId: med.id,
                  scheduledFor: slotScheduledFor,
                  tz: med.user.timezone,
                });
              }
            }

            // Send notification if enabled
            if (med.notificationsEnabled) {
              // v1.4.49 M-DOUBLE-REMINDER — opt-in client-managed
              // suppression. ONLY suppresses MEDICATION_REMINDER.
              if (
                isMedicationReminderClientManaged(med.user.notificationPrefs)
              ) {
                const doseAtIso = slotScheduledFor.toISOString();
                evt.addMeta(
                  "medication_reminder_suppressed_client_managed",
                  `${med.name}:${slotTime}`,
                );
                evt.addMeta("medication_reminder_suppressed_meta", {
                  user_id: med.user.id,
                  medication_id: med.id,
                  schedule_id: schedule.id,
                  phase: currentPhase,
                  dose_at: doseAtIso,
                });
                continue;
              }

              const { title, message } = getPhaseMessage(
                currentPhase,
                med.name,
                doseInfo,
                timeWindow,
                minutesToEnd,
                med.user.locale,
              );

              const keyboard = getPhaseKeyboard(
                currentPhase,
                med.id,
                med.user.locale,
              );

              // v0.5.4 — surface the slot time as an ISO 8601 string so
              // the iOS snooze action pins against the actual slot.
              const scheduledAtIso = slotScheduledFor.toISOString();

              evt.addMeta(
                "notification_phase",
                `${currentPhase}:${med.name}:${slotTime}`,
              );

              try {
                await dispatchNotification({
                  eventType: "MEDICATION_REMINDER",
                  userId: med.user.id,
                  title,
                  message,
                  metadata: {
                    medicationId: med.id,
                    scheduleId: schedule.id,
                    phase: currentPhase,
                    date: localDateStr,
                    // v1.7.0 SB-SCHED-4 — carry the dedup time-of-day so
                    // the Telegram-message ledger keys per slot.
                    timeOfDay: dedupTimeOfDay,
                    scheduledAt: scheduledAtIso,
                    replyMarkup: keyboard,
                  },
                });
              } catch (notifErr) {
                evt.addWarning(
                  `Notification dispatch failed for ${currentPhase} phase ${med.name}: ${notifErr}`,
                );
              }
            }
          }
        }
      }
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * Fallback polling for Withings data.
 * Runs periodically in case webhook delivery is delayed or unavailable.
 */
async function handleWithingsFallbackSync(jobs: Job<WithingsSyncPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.withings_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      recordWithingsSync();
      const connections = await prisma.withingsConnection.findMany({
        select: { userId: true },
      });

      if (connections.length === 0) {
        return;
      }

      let usersSynced = 0;
      let measurementsImported = 0;

      for (const connection of connections) {
        try {
          const imported = await syncUserMeasurements(connection.userId);
          usersSynced++;
          measurementsImported += imported;
        } catch (err) {
          evt.addWarning(
            `Fallback sync failed for user ${connection.userId}: ${err}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.withings_sync",
        result: {
          users_synced: usersSynced,
          total: connections.length,
          measurements_imported: measurementsImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.4.25 W17b — activity-sync handler.
 *
 * Two enqueue paths feed this queue:
 *
 *   1. Webhook (appli=16) — payload carries `userId`, the handler
 *      runs `syncUserActivity` for that one user.
 *   2. Cron (`withings-activity-sync` at :00 every hour) — payload
 *      has no `userId`, the handler iterates every Withings
 *      connection and re-syncs each. Catches the 1 % of webhook
 *      deliveries Withings drops.
 *
 * Sync failures per-user are logged as warnings; the queue carries on
 * so one user's parked-at-reauth state doesn't starve every other
 * connection on the cron tick.
 */
async function handleWithingsActivitySync(
  jobs: Job<WithingsActivitySyncPayload>[],
) {
  await withBackgroundEvent("job.withings_activity_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({ userId: job.data.userId });
        }
      }
      // No user-specific enqueue → cron fallback iterating everyone.
      if (targets.length === 0) {
        const connections = await prisma.withingsConnection.findMany({
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) return;

      let usersSynced = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          const imported = await syncUserActivity(userId);
          usersSynced++;
          measurementsImported += imported;
        } catch (err) {
          evt.addWarning(
            `Withings activity sync failed for user ${userId}: ${err}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.withings_activity_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.4.25 W17c — sleep-sync handler. Same enqueue semantics as the
 * activity handler: per-user when the webhook fires, full-iteration
 * when the cron ticks.
 */
async function handleWithingsSleepSync(jobs: Job<WithingsSleepSyncPayload>[]) {
  await withBackgroundEvent("job.withings_sleep_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({ userId: job.data.userId });
        }
      }
      if (targets.length === 0) {
        const connections = await prisma.withingsConnection.findMany({
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) return;

      let usersSynced = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          const imported = await syncUserSleep(userId);
          usersSynced++;
          measurementsImported += imported;
        } catch (err) {
          evt.addWarning(
            `Withings sleep sync failed for user ${userId}: ${err}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.withings_sleep_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

async function handleGeneralStatusGenerate(jobs: Job<GeneralStatusPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.insights.general", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      recordInsightsRun();
      const users = await prisma.user.findMany({
        select: { id: true, locale: true },
      });

      if (users.length === 0) return;

      let generated = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await generateGeneralStatusForUser(user.id, {
            locale: user.locale ?? "de",
            force: false,
          });
          generated++;
        } catch (error) {
          failed++;
          evt.addWarning(
            `general-status generation failed for user ${user.id}: ${error}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.insights.general",
        result: { generated, failed, total: users.length },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

async function handleBloodPressureStatusGenerate(
  jobs: Job<BloodPressureStatusPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.insights.blood_pressure", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const users = await prisma.user.findMany({
        select: { id: true, locale: true },
      });

      if (users.length === 0) return;

      let generated = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await generateBloodPressureStatusForUser(user.id, {
            locale: user.locale ?? "de",
            force: false,
          });
          generated++;
        } catch (error) {
          failed++;
          evt.addWarning(
            `blood-pressure-status generation failed for user ${user.id}: ${error}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.insights.blood_pressure",
        result: { generated, failed, total: users.length },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

async function handleWeightStatusGenerate(jobs: Job<WeightStatusPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.insights.weight", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const users = await prisma.user.findMany({
        select: { id: true, locale: true },
      });

      if (users.length === 0) return;

      let generated = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await generateWeightStatusForUser(user.id, {
            locale: user.locale ?? "de",
            force: false,
          });
          generated++;
        } catch (error) {
          failed++;
          evt.addWarning(
            `weight-status generation failed for user ${user.id}: ${error}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.insights.weight",
        result: { generated, failed, total: users.length },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

async function handlePulseStatusGenerate(jobs: Job<PulseStatusPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.insights.pulse", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const users = await prisma.user.findMany({
        select: { id: true, locale: true },
      });

      if (users.length === 0) return;

      let generated = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await generatePulseStatusForUser(user.id, {
            locale: user.locale ?? "de",
            force: false,
          });
          generated++;
        } catch (error) {
          failed++;
          evt.addWarning(
            `pulse-status generation failed for user ${user.id}: ${error}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.insights.pulse",
        result: { generated, failed, total: users.length },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

async function handleBmiStatusGenerate(jobs: Job<BmiStatusPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.insights.bmi", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const users = await prisma.user.findMany({
        select: { id: true, locale: true },
      });

      if (users.length === 0) return;

      let generated = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await generateBmiStatusForUser(user.id, {
            locale: user.locale ?? "de",
            force: false,
          });
          generated++;
        } catch (error) {
          failed++;
          evt.addWarning(
            `bmi-status generation failed for user ${user.id}: ${error}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.insights.bmi",
        result: { generated, failed, total: users.length },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

async function handleMedicationComplianceStatusGenerate(
  jobs: Job<MedicationComplianceStatusPayload>[],
) {
  void jobs;
  await withBackgroundEvent(
    "job.insights.medication_compliance",
    async (evt) => {
      const prisma = getWorkerPrisma();
      try {
        const users = await prisma.user.findMany({
          select: { id: true, locale: true },
        });

        if (users.length === 0) return;

        let generated = 0;
        let failed = 0;

        for (const user of users) {
          try {
            await generateMedicationComplianceStatusForUser(user.id, {
              locale: user.locale ?? "de",
              force: false,
            });
            generated++;
          } catch (error) {
            failed++;
            evt.addWarning(
              `medication-compliance-status generation failed for user ${user.id}: ${error}`,
            );
          }
        }

        evt.setBackground({
          task_name: "job.insights.medication_compliance",
          result: { generated, failed, total: users.length },
        });
      } catch (err) {
        evt.setError(err);
        recordError();
        throw err;
      }
    },
  );
}

/**
 * Fallback polling for moodLog data.
 * Syncs mood entries for all users with moodLog enabled.
 */
async function handleMoodLogSync(jobs: Job<MoodLogSyncPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.moodlog_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      // Check global toggle
      const appSettings = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: { moodLogGlobal: true },
      });
      if (appSettings && !appSettings.moodLogGlobal) {
        evt.addMeta("skipped", "global_toggle_disabled");
        return;
      }

      const users = await prisma.user.findMany({
        where: { moodLogEnabled: true },
        select: { id: true },
      });

      if (users.length === 0) return;

      let synced = 0;
      let totalImported = 0;

      for (const user of users) {
        try {
          const imported = await syncMoodLogEntries(user.id);
          synced++;
          totalImported += imported;
        } catch (err) {
          evt.addWarning(`Fallback sync failed for user ${user.id}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: "job.moodlog_sync",
        result: {
          synced,
          total: users.length,
          entries_imported: totalImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v0.5.4 ios-coord — daily mood-reminder dispatcher.
 *
 * Delegates the dispatch decision to `runMoodReminderTick` in
 * `mood-reminder.ts` so the unit tests can exercise the logic without
 * spinning up pg-boss. The handler is a thin shim that wires the worker
 * Prisma singleton + the wide-event sink to the pure function.
 */
interface MoodReminderCleanupPayload {
  triggeredAt: string;
}

async function handleMoodReminderCleanup(
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
interface PushAttemptCleanupPayload {
  triggeredAt: string;
}

async function handlePushAttemptCleanup(
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

interface MeasurementTombstoneCleanupPayload {
  triggeredAt: string;
}

async function handleMeasurementTombstoneCleanup(
  jobs: Job<MeasurementTombstoneCleanupPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.measurement_tombstone_cleanup", async (evt) => {
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
  });
}

async function handleMoodReminderCheck(jobs: Job<MoodReminderPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.mood_reminder", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const summary = await runMoodReminderTick(prisma, new Date());
      evt.setBackground({
        task_name: "job.mood_reminder",
        result: {
          candidates_scanned: summary.candidatesScanned,
          in_window: summary.inWindow,
          dispatched: summary.dispatched,
          skipped_already_logged: summary.skippedAlreadyLogged,
          skipped_already_dispatched: summary.skippedAlreadyDispatched,
          skipped_outside_window: summary.skippedOutsideWindow,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

async function handleRateLimitCleanup(jobs: Job<RateLimitCleanupPayload>[]) {
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

async function handleIdempotencyCleanup(
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

async function handleAuditLogCleanup(jobs: Job<AuditLogCleanupPayload>[]) {
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

async function handleWithingsOAuthStateCleanup(
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

async function handleHostMetricSample(jobs: Job<HostMetricSamplePayload>[]) {
  void jobs;
  await withBackgroundEvent("job.host_metric_sample", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const { pruned } = await runHostMetricTick(p);
      evt.addMeta("host_metric_pruned", pruned);
    } catch (err) {
      // The chart degrades gracefully when samples are missing — log
      // and move on rather than poisoning the boss queue with retries.
      evt.addWarning(`host-metric-sample failed: ${err}`);
    }
  });
}

async function handleFeedbackAggregator(
  jobs: Job<FeedbackAggregatorPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.feedback_aggregator", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const summary = await aggregateRecommendationFeedback(p);
      evt.addMeta("feedback_buckets", summary.buckets.length);
      evt.addMeta(
        "feedback_total_rows",
        summary.buckets.reduce((acc, b) => acc + b.total, 0),
      );
      evt.addMeta("feedback_window_days", summary.windowDays);
    } catch (err) {
      // The admin dashboard tolerates a stale summary — log and move
      // on rather than poisoning the boss queue with retries that
      // would block the next cleanup window.
      evt.addWarning(`feedback-aggregator failed: ${err}`);
    }
  });
}

/**
 * v1.4.37 — geo-backfill worker. Walks `audit_logs` rows that landed
 * with a null `location` (offline MMDB missing at write time, online
 * provider unreachable) and re-resolves them through the now-bundled
 * resolver chain. The helper is idempotent and capped per pass so
 * the hourly cadence cannot starve a live login spike.
 *
 * v1.4.38 — in-process singleton guard. pg-boss already coalesces
 * concurrent cron ticks across multiple worker containers via the
 * shared queue lease, but a single container that takes longer than
 * one cron interval can pick up two jobs back-to-back when the
 * second tick fires while the first pass is still running. The
 * in-process `geoBackfillRunning` flag fans the second invocation
 * out as a no-op log line instead of stacking two concurrent passes
 * inside the same Node process — the next cron tick after the first
 * completes will catch up the work the skipped pass would have done.
 */
let geoBackfillRunning = false;
async function handleGeoBackfill(jobs: Job<GeoBackfillPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.geo_backfill", async (evt) => {
    if (geoBackfillRunning) {
      // Earlier pass still in flight; skip this tick. Idempotent + the
      // next tick after the in-flight pass completes will pick up
      // anything we miss here.
      evt.addWarning(
        "geo-backfill skipped — earlier pass still in flight inside the same worker process",
      );
      evt.addMeta("geo_backfill_skipped", true);
      return;
    }
    geoBackfillRunning = true;
    const p = getWorkerPrisma();
    try {
      const summary = await runGeoBackfill(p);
      evt.addMeta("geo_backfill_scanned", summary.scanned);
      evt.addMeta("geo_backfill_located", summary.located);
      evt.addMeta("geo_backfill_carrier_resolved", summary.carrierResolved);
      evt.addMeta("geo_backfill_still_unresolved", summary.stillUnresolved);
    } catch (err) {
      // The admin sign-in overview tolerates a stale Standort cell —
      // log and move on so a one-off resolver hiccup does not poison
      // the queue and block the next pass.
      evt.addWarning(`geo-backfill failed: ${err}`);
    } finally {
      geoBackfillRunning = false;
    }
  });
}

async function handlePrDetection(
  jobs: Job<PrDetectionPayload | { userId?: undefined }>[],
) {
  for (const job of jobs) {
    await withBackgroundEvent("job.pr_detection", async (evt) => {
      const p = getWorkerPrisma();
      // The cron-fired job carries an empty payload — iterate all
      // users in that case. The push-suppression flag is irrelevant
      // for the cron path (the dispatcher's per-user opt-in handles
      // the loud/quiet decision once the row is written).
      const payloadUserId = (job.data as PrDetectionPayload | undefined)
        ?.userId;
      const silent =
        (job.data as PrDetectionPayload | undefined)?.silent ?? false;
      const userIds: string[] = payloadUserId
        ? [payloadUserId]
        : (await p.user.findMany({ select: { id: true } })).map((u) => u.id);

      let insertedTotal = 0;
      let tiesTotal = 0;
      for (const userId of userIds) {
        try {
          const result = await detectPersonalRecordsForUser(userId, {
            silent,
            prisma: p,
          });
          insertedTotal += result.inserted;
          tiesTotal += result.ties;
        } catch (err) {
          evt.addWarning(`pr-detection failed for user ${userId}: ${err}`);
        }
      }
      evt.addMeta("pr_detection_users", userIds.length);
      evt.addMeta("pr_detection_inserted", insertedTotal);
      evt.addMeta("pr_detection_ties", tiesTotal);
      evt.addMeta("pr_detection_silent", silent);
      evt.addMeta("pr_detection_mode", payloadUserId ? "ingest" : "cron");
    });
  }
}

/**
 * v1.4.25 W19b — daily expire-stale pass for `MedicationInventoryItem`
 * rows. Flips IN_USE pens whose 30-day window has lapsed to EXPIRED
 * via the pure state-machine evaluator.
 */
async function handleMedicationInventoryExpire(
  jobs: Job<MedicationInventoryExpirePayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.medication_inventory_expire", async (evt) => {
    try {
      const count = await expireStaleInUseItems({ nowMs: Date.now() });
      evt.addMeta("inventory_expired_count", count);
    } catch (err) {
      evt.addWarning(
        `medication-inventory-expire failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

async function handleInsightPregenerateJob(
  jobs: Job<InsightPregeneratePayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.insight_pregenerate", async (evt) => {
    try {
      const summary = await runInsightPregenerate(getWorkerPrisma());
      evt.setBackground({
        task_name: "job.insight_pregenerate",
        result: { ...summary },
      });
    } catch (err) {
      evt.addWarning(
        `insight-pregenerate failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

/**
 * v1.8.3 — on-demand per-metric status generation. The read-only status
 * route enqueues one job per cold card; this handler runs the matching
 * generator with `force: true` so the assessment cache row lands and the
 * polling client picks it up. Each job carries `{ userId, metric, locale }`.
 */
async function handleInsightStatusGenerate(
  jobs: Job<InsightStatusGeneratePayload>[],
) {
  await withBackgroundEvent("job.insight_status_generate", async (evt) => {
    for (const job of jobs) {
      if (!job.data?.userId || !job.data?.metric) continue;
      try {
        await runInsightStatusGenerate(job.data);
        evt.addMeta("status_generated", `${job.data.metric}:${job.data.locale}`);
      } catch (err) {
        evt.addWarning(
          `insight-status-generate failed for ${job.data.metric}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  });
}

/**
 * v1.4.46 — hourly auto-skip for stale unmarked medication intakes.
 *
 * Flips `MedicationIntakeEvent.skipped` to `true` for every event the
 * user neither took nor explicitly skipped within the 24 h grace
 * window. The pure helper lives in `@/lib/jobs/intake-auto-skip` so a
 * unit test can drive it with an in-memory fake Prisma; this wrapper
 * threads the worker's pg-boss + background-event plumbing.
 */
async function handleIntakeAutoSkip(jobs: Job<IntakeAutoSkipPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.intake_auto_skip", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const result = await runIntakeAutoSkipPass(prisma, {
        nowMs: Date.now(),
      });
      evt.addMeta("intake_auto_skip_count", result.skippedCount);
      evt.addMeta("intake_auto_skip_cutoff", result.cutoff.toISOString());
    } catch (err) {
      evt.addWarning(
        `intake-auto-skip failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

async function handleOffhostBackup(jobs: Job<OffhostBackupPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.offhost_backup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const report = await runOffhostBackup(p);
      evt.addMeta("offhost_backup_uploaded", report.uploaded);
      evt.addMeta("offhost_backup_failed", report.failed);
      evt.addMeta("offhost_backup_total_users", report.totalUsers);
      evt.addMeta("offhost_backup_endpoint", report.config.endpoint);
      evt.addMeta("offhost_backup_bucket", report.config.bucket);
      // Per-user failure detail is also emitted as warnings inside
      // runOffhostBackup; echo a structured digest for at-a-glance triage.
      if (report.failures.length > 0) {
        evt.addMeta(
          "offhost_backup_failures",
          JSON.stringify(report.failures.slice(0, 10)),
        );
      }
    } catch (err) {
      // Not configured ⇒ skip silently with a warning, not an error.
      evt.addWarning(`offhost-backup skipped/failed: ${err}`);
    }
  });
}

async function handleDataBackup(jobs: Job<DataBackupPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.data_backup", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const users = await prisma.user.findMany({
        select: { id: true, username: true },
      });

      let backed = 0;
      for (const user of users) {
        try {
          const [measurements, medications, intakeEvents, moodEntries] =
            await Promise.all([
              prisma.measurement.findMany({
                where: { userId: user.id },
                orderBy: { measuredAt: "desc" },
              }),
              prisma.medication.findMany({
                where: { userId: user.id },
                include: { schedules: true },
              }),
              prisma.medicationIntakeEvent.findMany({
                where: { userId: user.id },
                include: { medication: { select: { name: true } } },
                orderBy: { scheduledFor: "desc" },
              }),
              prisma.moodEntry.findMany({
                where: { userId: user.id },
                orderBy: { moodLoggedAt: "desc" },
              }),
            ]);

          const backupJson = JSON.stringify({
            // Bumped only when the on-disk shape changes incompatibly.
            // Mirrors `BACKUP_SCHEMA_VERSION` in
            // `src/lib/validations/backup.ts` — keep them in sync.
            schemaVersion: "1",
            exportedAt: new Date().toISOString(),
            userId: user.id,
            measurements: measurements.map((m) => ({
              type: m.type,
              value: m.value,
              unit: m.unit,
              measuredAt: m.measuredAt.toISOString(),
              source: m.source,
              notes: m.notes,
            })),
            medications: medications.map((m) => ({
              name: m.name,
              dose: m.dose,
              active: m.active,
              schedules: m.schedules.map((s) => ({
                windowStart: s.windowStart,
                windowEnd: s.windowEnd,
                label: s.label,
                dose: s.dose,
              })),
            })),
            intakeEvents: intakeEvents.map((e) => ({
              medication: e.medication.name,
              scheduledFor: e.scheduledFor.toISOString(),
              takenAt: e.takenAt?.toISOString() ?? null,
              skipped: e.skipped,
              source: e.source,
            })),
            moodEntries: moodEntries.map((e) => ({
              date: e.date,
              mood: e.mood,
              score: e.score,
              tags: e.tags,
              source: e.source,
              loggedAt: e.moodLoggedAt.toISOString(),
            })),
          });

          // Encrypt the backup data (contains sensitive health information)
          const encryptedBackup = encrypt(backupJson);

          await prisma.dataBackup.upsert({
            where: {
              userId_type: { userId: user.id, type: "WEEKLY_AUTO" },
            },
            update: {
              data: encryptedBackup,
              createdAt: new Date(),
            },
            create: {
              userId: user.id,
              type: "WEEKLY_AUTO",
              data: encryptedBackup,
            },
          });
          backed++;
        } catch (err) {
          evt.addWarning(`Failed for user ${user.id}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: "job.data_backup",
        result: { backed, total: users.length },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * Internal logger that prefers structured Wide-Event annotations when a
 * worker context is active, and falls back to stderr only for true
 * lifecycle events that fire outside any handler (init, fatal startup
 * errors, shutdown). Avoids the historical pattern of `console.log`
 * everywhere in this file, which polluted production stdout and was
 * never queryable in Loki.
 */
function workerLog(level: "info" | "error", msg: string, err?: unknown): void {
  if (level === "error") {
    // Errors during worker init or shutdown happen outside any request
    // context, so stderr is the only audience the operator has.
    if (err !== undefined) console.error(`[pg-boss] ${msg}`, err);
    else console.error(`[pg-boss] ${msg}`);
  }
  // info-level lifecycle messages are intentionally silent — pg-boss own
  // events surface state, and Wide Events from handlers carry the work.
}

export async function startReminderWorker() {
  // v1.4 G3: refuse to boot if the operator marked this container as
  // web-only via HEALTHLOG_PROCESS_TYPE.
  assertSubsystemEnabled("worker");

  if (!DATABASE_URL) {
    workerLog("error", "CRITICAL: DATABASE_URL is not set, refusing to start");
    return;
  }

  const boss = new PgBoss(DATABASE_URL);

  boss.on("error", (error: unknown) => {
    workerLog("error", "boss emitted error", error);
    recordError();
  });

  await boss.start();
  setGlobalBoss(boss);
  markWorkerStarted();

  // V3 audit STILL-V2-C-2: encrypt-at-rest one-shot migration. Rotates
  // any rows that still hold a plaintext mood_log_webhook_secret to the
  // AES-256-GCM envelope. Idempotent — encrypted rows are skipped.
  try {
    const p = getWorkerPrisma();
    const rotated = await rotateLegacyMoodLogSecrets({
      findLegacy: () =>
        p.user.findMany({
          where: { moodLogWebhookSecret: { not: null } },
          select: { id: true, moodLogWebhookSecret: true },
        }),
      rotate: async (id, encryptedSecret) => {
        await p.user.update({
          where: { id },
          data: { moodLogWebhookSecret: encryptedSecret },
        });
      },
    });
    if (rotated > 0) {
      workerLog(
        "error",
        `moodlog-secret-migration: rotated ${rotated} legacy plaintext secret(s)`,
      );
    }
  } catch (err) {
    workerLog("error", `moodlog-secret-migration failed: ${err}`);
  }

  // Graceful shutdown: drain in-flight jobs on SIGTERM/SIGINT (sent by
  // Docker Compose `docker stop`, Kubernetes pod termination, Coolify
  // redeploys). Without this, pending handlers were force-killed and could
  // either be lost or replayed on next start. We only register the listeners
  // once — re-entering startReminderWorker (e.g. on hot-reload in dev) is
  // a no-op for the handlers because they capture `boss` by closure and the
  // first signal stops everything.
  let shutdownInProgress = false;
  const onSignal = async (signal: "SIGTERM" | "SIGINT") => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    workerLog("error", `received ${signal}, draining boss`);
    try {
      // graceful=true waits for active handlers to finish, then closes the
      // pg connection pool. timeout cap so a stuck handler can't block deploys.
      await boss.stop({ graceful: true, timeout: 30_000 });
    } catch (err) {
      workerLog("error", "boss.stop failed during shutdown", err);
    }
  };
  process.once("SIGTERM", () => void onSignal("SIGTERM"));
  process.once("SIGINT", () => void onSignal("SIGINT"));

  // pg-boss v12 requires explicit queue creation before scheduling
  const allQueues = [
    QUEUE_NAME,
    WITHINGS_SYNC_QUEUE,
    WITHINGS_ACTIVITY_QUEUE,
    WITHINGS_SLEEP_QUEUE,
    GENERAL_STATUS_QUEUE,
    BLOOD_PRESSURE_STATUS_QUEUE,
    WEIGHT_STATUS_QUEUE,
    PULSE_STATUS_QUEUE,
    BMI_STATUS_QUEUE,
    MEDICATION_COMPLIANCE_STATUS_QUEUE,
    MOODLOG_SYNC_QUEUE,
    DATA_BACKUP_QUEUE,
    RATE_LIMIT_CLEANUP_QUEUE,
    IDEMPOTENCY_CLEANUP_QUEUE,
    AUDIT_LOG_CLEANUP_QUEUE,
    // v1.4.47 W6 — daily sweep for the Withings OAuth state ledger.
    // Same pg-boss v12 createQueue contract as the other cleanup
    // crons; without this entry the schedule below silently no-ops
    // and abandoned rows pile up.
    WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
    OFFHOST_BACKUP_QUEUE,
    HOST_METRIC_QUEUE,
    FEEDBACK_AGGREGATOR_QUEUE,
    GEO_BACKFILL_QUEUE,
    PR_DETECTION_QUEUE,
    MEDICATION_INVENTORY_EXPIRE_QUEUE,
    // v1.4.46 — hourly auto-skip pass for stale unmarked intakes.
    // Same pg-boss v12 createQueue contract as the other crons; without
    // this entry the schedule silently no-ops and pending rows older
    // than 24 h pile up unflipped.
    INTAKE_AUTO_SKIP_QUEUE,
    APPLE_HEALTH_IMPORT_QUEUE,
    ROLLUP_RECOMPUTE_QUEUE,
    ROLLUP_FULL_BACKFILL_QUEUE,
    // v1.4.39 W-MOOD — per-bucket WEEK/MONTH/YEAR fold queue for the
    // mood rollup tier. The DAY pass runs inline in the write hook;
    // these enqueue paths cover the cross-granularity buckets the
    // worker materialises off the request path.
    MOOD_ROLLUP_RECOMPUTE_QUEUE,
    // v1.4.39 W-MOOD — boot-time fold queue for the mood rollup tier.
    // Mirrors the measurement-rollup full-backfill semantics: the
    // discovery query enqueues one full-fold per user with mood
    // entries but no rollup rows; the user drops off the list once
    // the fold completes.
    MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
    // v1.4.39 W-MED — boot-time fold for the medication-compliance
    // rollup tier. Discovery enqueues one job per user with intake
    // events but no rollup coverage; idempotent across reboots.
    MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
    // v1.5.6 — boot-time legacy step consolidation. Discovery enqueues
    // one job per user still holding live pre-v1.5.0 granular step
    // rows; the per-user pass collapses them into one daily total and
    // soft-deletes the originals. Idempotent across reboots — a
    // consolidated user drops off the discovery list. The queue MUST be
    // registered here or pg-boss never provisions it and the boot
    // enqueue silently never drains.
    STEP_CONSOLIDATION_QUEUE,
    // v1.7.0 — daily-mean consolidation for high-frequency spot
    // HealthKit metrics (walking speed/step length, respiratory rate,
    // audio exposure). Boot discovery enqueues one job per user holding
    // live per-sample mean-type rows; the per-user pass collapses each
    // day to its mean and soft-deletes the originals. Idempotent across
    // reboots. The queue MUST be registered here or pg-boss never
    // provisions it and the boot enqueue silently never drains.
    MEAN_CONSOLIDATION_QUEUE,
    // v1.8.2 — one-time duplicate dose-slot cleanup. Boot discovery
    // enqueues one job per user holding two live intake rows that snap to
    // the same canonical slot (the pre-fix REMINDER-pending + API-taken
    // pair). The per-user pass keeps the winner (taken > skipped >
    // pending), soft-deletes the losers, and recomputes the affected
    // compliance rollups. Idempotent across reboots — a deduped user
    // falls off the discovery list. The queue MUST be registered here or
    // pg-boss never provisions it and the boot enqueue silently never
    // drains.
    INTAKE_SLOT_DEDUP_QUEUE,
    // v1.4.37 W7c — explicit createQueue is required before the
    // nightly schedule below registers (pg-boss v12 contract). Without
    // this entry the drain schedule silently no-ops and the
    // per-sample APPLE_HEALTH rows never collapse.
    DRAIN_CUMULATIVE_QUEUE,
    // v0.5.4 ios-coord — mood-reminder cron tick. Same pg-boss v12
    // createQueue contract as the drain queue above; without this
    // entry the every-15-min schedule silently no-ops and the
    // dispatcher never fires.
    MOOD_REMINDER_QUEUE,
    MOOD_REMINDER_CLEANUP_QUEUE,
    // v1.4.49 — push-attempt ledger cleanup. Same createQueue contract
    // as the other cleanup jobs; the daily schedule below would
    // silently no-op without this entry.
    PUSH_ATTEMPT_CLEANUP_QUEUE,
    // v1.7.0 — nightly comprehensive-insight pre-generation so the
    // daily briefing is warm before the user opens /insights or the
    // dashboard snapshot. Same pg-boss v12 createQueue contract; without
    // this entry the 04:30 schedule silently no-ops and every briefing
    // falls back to the lazy on-demand generation it was meant to retire.
    INSIGHT_PREGENERATE_QUEUE,
    // v1.8.3 — on-demand per-metric status generation. The read-only
    // status route enqueues here on a cold card; without this entry
    // pg-boss never provisions the queue and the enqueue silently drops,
    // leaving every status card stuck on "preparing". No cron schedule —
    // it is a send-only queue driven by navigation.
    INSIGHT_STATUS_GENERATE_QUEUE,
    // v1.7.0 — soft-deleted measurement tombstone prune. Same createQueue
    // contract as the other cleanup jobs; without this entry the daily
    // schedule silently no-ops and pruned-past-retention tombstones pile
    // up forever.
    MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE,
  ];

  for (const q of allQueues) {
    await boss.createQueue(q);
  }

  // v1.4.34 — reconcile any `ImportJob` rows that were mid-parse when
  // the worker last shut down. Flips orphaned rows to `failed` so the
  // operator can re-upload without leaving the polling endpoint
  // stuck on `parsing` / `upserting`.
  try {
    await reconcileOrphanImportJobs();
  } catch (err) {
    workerLog("error", "Failed to reconcile orphan ImportJob rows", err);
  }

  // v1.4.48 M1 — boot probe for legacy `integration_statuses` rows
  // that still carry `consecutive_failures_by_kind = NULL`. After
  // v1.4.47 dropped the single-column fallback, such rows alert two
  // strikes later than they did pre-upgrade. The probe is a single
  // count query + Wide-Event warning if any survive; fire-and-forget
  // so a probe failure never blocks worker boot.
  try {
    await withBackgroundEvent("worker.boot.integration_status_null_probe", async () => {
      await probeIntegrationStatusNullBuckets(getWorkerPrisma());
    });
  } catch (err) {
    workerLog("error", "integration-status-null-probe failed", err);
  }

  // Schedule recurring cron jobs
  const schedules: [string, string][] = [
    [QUEUE_NAME, CHECK_INTERVAL_CRON],
    [WITHINGS_SYNC_QUEUE, WITHINGS_SYNC_CRON],
    [WITHINGS_ACTIVITY_QUEUE, WITHINGS_ACTIVITY_CRON],
    [WITHINGS_SLEEP_QUEUE, WITHINGS_SLEEP_CRON],
    [GENERAL_STATUS_QUEUE, GENERAL_STATUS_CRON],
    [BLOOD_PRESSURE_STATUS_QUEUE, BLOOD_PRESSURE_STATUS_CRON],
    [WEIGHT_STATUS_QUEUE, WEIGHT_STATUS_CRON],
    [PULSE_STATUS_QUEUE, PULSE_STATUS_CRON],
    [BMI_STATUS_QUEUE, BMI_STATUS_CRON],
    [MEDICATION_COMPLIANCE_STATUS_QUEUE, MEDICATION_COMPLIANCE_STATUS_CRON],
    [MOODLOG_SYNC_QUEUE, MOODLOG_SYNC_CRON],
    [DATA_BACKUP_QUEUE, DATA_BACKUP_CRON],
    [RATE_LIMIT_CLEANUP_QUEUE, RATE_LIMIT_CLEANUP_CRON],
    [IDEMPOTENCY_CLEANUP_QUEUE, IDEMPOTENCY_CLEANUP_CRON],
    [AUDIT_LOG_CLEANUP_QUEUE, AUDIT_LOG_CLEANUP_CRON],
    [WITHINGS_OAUTH_STATE_CLEANUP_QUEUE, WITHINGS_OAUTH_STATE_CLEANUP_CRON],
    [OFFHOST_BACKUP_QUEUE, OFFHOST_BACKUP_CRON],
    [HOST_METRIC_QUEUE, HOST_METRIC_CRON],
    [FEEDBACK_AGGREGATOR_QUEUE, FEEDBACK_AGGREGATOR_CRON],
    // v1.4.37 — hourly geo backfill. The helper is idempotent + capped
    // at 5 000 rows per pass; running it at :40 every hour catches the
    // long tail of audit rows that landed with the offline MMDB
    // missing or the online provider unreachable.
    [GEO_BACKFILL_QUEUE, GEO_BACKFILL_CRON],
    // Fallback rescan every 30 minutes — protects against ingest paths
    // that ship measurements without enqueueing a per-user job. The
    // cron payload deliberately omits a `userId` so the handler iterates
    // every user; per-user push-suppression cannot apply on the cron
    // path (the silent flag is set by the ingest hooks).
    [PR_DETECTION_QUEUE, PR_DETECTION_FALLBACK_CRON],
    // v1.4.25 W19b — daily expire-stale pass for the per-pen inventory
    // entities. Flips IN_USE rows whose 30-day clock has blown to
    // EXPIRED at 03:30 Europe/Berlin (in the existing 02:xx–03:xx
    // maintenance window, right after idempotency-cleanup).
    [MEDICATION_INVENTORY_EXPIRE_QUEUE, MEDICATION_INVENTORY_EXPIRE_CRON],
    // v1.4.46 — hourly auto-skip for medication intakes the user never
    // marked. Cron `5 * * * *` slots off the top-of-the-hour
    // reminder-check (:00) and the moodlog-sync (:30) so the three
    // hourly ticks don't pile up on the same boss poll.
    [INTAKE_AUTO_SKIP_QUEUE, INTAKE_AUTO_SKIP_CRON],
    // v1.4.37 W7c — nightly fold of per-sample APPLE_HEALTH cumulative
    // rows into one row per day per type. Slots between the
    // audit-log cleanup (03:15) and the feedback aggregator (04:00).
    [DRAIN_CUMULATIVE_QUEUE, DRAIN_CUMULATIVE_CRON],
    // v0.5.4 ios-coord — every-15-min tick for the daily mood reminder.
    // The handler short-circuits unless the candidate user's local
    // time is the 22:00 hour, so the cron costs ~one user-row scan
    // per tick for the entire opted-in cohort.
    [MOOD_REMINDER_QUEUE, MOOD_REMINDER_CRON],
    [MOOD_REMINDER_CLEANUP_QUEUE, MOOD_REMINDER_CLEANUP_CRON],
    // v1.4.49 — daily 03:35 Europe/Berlin prune for push_attempts.
    [PUSH_ATTEMPT_CLEANUP_QUEUE, PUSH_ATTEMPT_CLEANUP_CRON],
    // v1.7.0 — nightly 04:30 Europe/Berlin comprehensive-insight
    // pre-generation. Budget-gated per user inside the handler.
    [INSIGHT_PREGENERATE_QUEUE, INSIGHT_PREGENERATE_CRON],
    // v1.7.0 — daily 03:40 Europe/Berlin prune for expired measurement
    // tombstones.
    [MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE, MEASUREMENT_TOMBSTONE_CLEANUP_CRON],
  ];

  for (const [name, cron] of schedules) {
    await boss.schedule(name, cron, {}, { tz: "Europe/Berlin" });
  }

  // Register the handler
  await boss.work<ReminderCheckPayload>(
    QUEUE_NAME,
    { localConcurrency: 1 },
    handleReminderCheck,
  );
  await boss.work<WithingsSyncPayload>(
    WITHINGS_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWithingsFallbackSync,
  );
  await boss.work<WithingsActivitySyncPayload>(
    WITHINGS_ACTIVITY_QUEUE,
    { localConcurrency: 1 },
    handleWithingsActivitySync,
  );
  await boss.work<WithingsSleepSyncPayload>(
    WITHINGS_SLEEP_QUEUE,
    { localConcurrency: 1 },
    handleWithingsSleepSync,
  );
  await boss.work<GeneralStatusPayload>(
    GENERAL_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleGeneralStatusGenerate,
  );
  await boss.work<BloodPressureStatusPayload>(
    BLOOD_PRESSURE_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleBloodPressureStatusGenerate,
  );
  await boss.work<WeightStatusPayload>(
    WEIGHT_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleWeightStatusGenerate,
  );
  await boss.work<PulseStatusPayload>(
    PULSE_STATUS_QUEUE,
    { localConcurrency: 1 },
    handlePulseStatusGenerate,
  );
  await boss.work<BmiStatusPayload>(
    BMI_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleBmiStatusGenerate,
  );
  await boss.work<MedicationComplianceStatusPayload>(
    MEDICATION_COMPLIANCE_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleMedicationComplianceStatusGenerate,
  );
  await boss.work<MoodLogSyncPayload>(
    MOODLOG_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleMoodLogSync,
  );
  await boss.work<DataBackupPayload>(
    DATA_BACKUP_QUEUE,
    { localConcurrency: 1 },
    handleDataBackup,
  );
  await boss.work<RateLimitCleanupPayload>(
    RATE_LIMIT_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleRateLimitCleanup,
  );
  await boss.work<IdempotencyCleanupPayload>(
    IDEMPOTENCY_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleIdempotencyCleanup,
  );
  await boss.work<AuditLogCleanupPayload>(
    AUDIT_LOG_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleAuditLogCleanup,
  );
  await boss.work<WithingsOAuthStateCleanupPayload>(
    WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleWithingsOAuthStateCleanup,
  );
  await boss.work<OffhostBackupPayload>(
    OFFHOST_BACKUP_QUEUE,
    { localConcurrency: 1 },
    handleOffhostBackup,
  );
  await boss.work<HostMetricSamplePayload>(
    HOST_METRIC_QUEUE,
    { localConcurrency: 1 },
    handleHostMetricSample,
  );
  await boss.work<FeedbackAggregatorPayload>(
    FEEDBACK_AGGREGATOR_QUEUE,
    { localConcurrency: 1 },
    handleFeedbackAggregator,
  );
  await boss.work<GeoBackfillPayload>(
    GEO_BACKFILL_QUEUE,
    { localConcurrency: 1 },
    handleGeoBackfill,
  );
  // v0.5.4 ios-coord — single-flight worker. localConcurrency=1 keeps
  // two reminder ticks from interleaving against the same user row;
  // the dedup ledger would still save us, but skipping the race here
  // avoids spurious P2002 errors in the wide-event log.
  await boss.work<MoodReminderPayload>(
    MOOD_REMINDER_QUEUE,
    { localConcurrency: 1 },
    handleMoodReminderCheck,
  );
  await boss.work<MoodReminderCleanupPayload>(
    MOOD_REMINDER_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleMoodReminderCleanup,
  );
  // v1.4.49 — daily prune of the push-attempt ledger. Single-flight
  // matches every other cleanup queue; two ticks racing on the same
  // DELETE statement is wasted work and the second tick's payload
  // would be a no-op anyway.
  await boss.work<PushAttemptCleanupPayload>(
    PUSH_ATTEMPT_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handlePushAttemptCleanup,
  );
  // v1.7.0 — daily prune of expired measurement tombstones. Single-flight
  // like every other cleanup queue.
  await boss.work<MeasurementTombstoneCleanupPayload>(
    MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleMeasurementTombstoneCleanup,
  );
  await boss.work<PrDetectionPayload>(
    PR_DETECTION_QUEUE,
    { localConcurrency: PR_DETECTION_CONCURRENCY },
    handlePrDetection,
  );
  await boss.work<MedicationInventoryExpirePayload>(
    MEDICATION_INVENTORY_EXPIRE_QUEUE,
    { localConcurrency: 1 },
    handleMedicationInventoryExpire,
  );
  // v1.7.0 — nightly comprehensive-insight pre-generation. Single-flight
  // so two ticks can't double-generate the same user; the per-user
  // budget gate inside the handler also covers the race, but
  // serialising here avoids wasted chain-resolves.
  await boss.work<InsightPregeneratePayload>(
    INSIGHT_PREGENERATE_QUEUE,
    { localConcurrency: 1 },
    handleInsightPregenerateJob,
  );
  // v1.8.3 — on-demand per-metric status generation enqueued by the
  // read-only status route on a cold card. Low concurrency so a first
  // visit that cold-misses several cards can't saturate the Prisma pool
  // or fan out an unbounded number of concurrent provider calls.
  await boss.work<InsightStatusGeneratePayload>(
    INSIGHT_STATUS_GENERATE_QUEUE,
    { localConcurrency: INSIGHT_STATUS_GENERATE_CONCURRENCY },
    handleInsightStatusGenerate,
  );
  // v1.4.46 — hourly auto-skip for stale unmarked intakes.
  // Single-flight: two ticks racing against the same row pile is wasted
  // work, and the underlying `updateMany` is the canonical idempotent
  // shape anyway.
  await boss.work<IntakeAutoSkipPayload>(
    INTAKE_AUTO_SKIP_QUEUE,
    { localConcurrency: 1 },
    handleIntakeAutoSkip,
  );
  // v1.4.34 — Apple Health export.zip ingest worker. localConcurrency
  // caps at 1 because the parse loop is CPU-bound and a concurrent
  // second 1 GB import would race the first for RSS.
  await boss.work<AppleHealthImportPayload>(
    APPLE_HEALTH_IMPORT_QUEUE,
    { localConcurrency: APPLE_HEALTH_IMPORT_CONCURRENCY },
    async (jobs) => {
      // pg-boss v12 work callbacks always receive an array (batched
      // worker mode); for our concurrency-1 + batchSize-1 case we just
      // process each job sequentially.
      for (const job of jobs) {
        await handleAppleHealthImport(job);
      }
    },
  );

  // v1.5.0 — persistent measurement rollup worker. Folds the
  // WEEK / MONTH / YEAR buckets that the write-path hooks enqueue;
  // the DAY bucket is already recomputed synchronously by the hook
  // itself. Concurrency-2 keeps two recomputes in flight without
  // crowding the dashboard request pool.
  await boss.work<RollupRecomputePayload>(
    ROLLUP_RECOMPUTE_QUEUE,
    { localConcurrency: ROLLUP_RECOMPUTE_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const payload = job.data;
        await recomputeUserRollups(payload.userId, {
          types: [payload.type],
          granularities: [payload.granularity],
          from: new Date(payload.from),
          to: new Date(payload.to),
        });
      }
    },
  );

  // v1.4.35.1 — boot-time full-fold worker. The boot enqueue helper
  // below sends one job per uncovered user; this handler runs the
  // full `recomputeUserRollups` against the default 5-year window
  // across every granularity. Serial concurrency so the populator
  // never crowds the dashboard request pool.
  await boss.work<RollupFullBackfillPayload>(
    ROLLUP_FULL_BACKFILL_QUEUE,
    { localConcurrency: ROLLUP_FULL_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        const { rowsUpserted, durationMs } = await recomputeUserRollups(userId);
        workerLog(
          "info",
          `[rollup-full-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
        );
      }
    },
  );

  // v1.5.6 — legacy step consolidation worker. The boot enqueue helper
  // below sends one job per user still holding live pre-v1.5.0 granular
  // step rows; this handler collapses them into one daily-total row per
  // calendar day and soft-deletes the originals. Serial concurrency so
  // the populator never crowds the dashboard request pool.
  await boss.work<StepConsolidationPayload>(
    STEP_CONSOLIDATION_QUEUE,
    { localConcurrency: STEP_CONSOLIDATION_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        const { daysConsolidated, legacyRowsSoftDeleted } =
          await runStepConsolidationForUser(userId);
        workerLog(
          "info",
          `[step-consolidation] user=${userId} days=${daysConsolidated} legacyRowsSoftDeleted=${legacyRowsSoftDeleted}`,
        );
      }
    },
  );

  // v1.7.0 — daily-mean consolidation worker. The boot enqueue helper
  // below sends one job per user holding live per-sample high-frequency
  // mean-type rows; this handler collapses each completed day to its
  // mean and soft-deletes the originals. Serial concurrency so the
  // populator never crowds the dashboard request pool.
  await boss.work<MeanConsolidationPayload>(
    MEAN_CONSOLIDATION_QUEUE,
    { localConcurrency: MEAN_CONSOLIDATION_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        const { daysConsolidated, perSampleRowsSoftDeleted } =
          await runMeanConsolidationForUser(userId);
        workerLog(
          "info",
          `[mean-consolidation] user=${userId} days=${daysConsolidated} perSampleRowsSoftDeleted=${perSampleRowsSoftDeleted}`,
        );
      }
    },
  );

  // v1.8.2 — duplicate dose-slot cleanup worker. The boot enqueue helper
  // below sends one job per user holding two live intake rows that snap
  // to the same canonical slot; this handler keeps the winner, soft-
  // deletes the losers, normalises the winner's scheduledFor, and
  // recomputes the affected compliance rollups. Serial concurrency so the
  // one-time pass never crowds the request pool.
  await boss.work<IntakeSlotDedupPayload>(
    INTAKE_SLOT_DEDUP_QUEUE,
    { localConcurrency: INTAKE_SLOT_DEDUP_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          const summary = await dedupeUserIntakeSlots(userId);
          workerLog(
            "info",
            `[intake-slot-dedup] user=${userId} slotsCollapsed=${summary.slotsCollapsed} rowsSoftDeleted=${summary.rowsSoftDeleted} rowsNormalised=${summary.rowsNormalised} daysRecomputed=${summary.daysRecomputed}`,
          );
        } catch (err) {
          recordError();
          workerLog(
            "error",
            `[intake-slot-dedup] user=${userId} failed`,
            err,
          );
          throw err;
        }
      }
    },
  );

  // v1.4.39 W-MOOD — mood-rollup per-bucket worker. Folds the
  // WEEK / MONTH / YEAR buckets that the mood-entry write hooks
  // enqueue; the DAY bucket runs synchronously in the hook itself.
  // No current read path consumes these buckets — they exist so a
  // future cross-granularity reader can ship without a backfill
  // step. Concurrency-2 mirrors the measurement-rollup worker.
  await boss.work<MoodRollupRecomputePayload>(
    MOOD_ROLLUP_RECOMPUTE_QUEUE,
    { localConcurrency: MOOD_ROLLUP_RECOMPUTE_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const payload = job.data;
        await recomputeUserMoodRollups(payload.userId, {
          granularities: [payload.granularity],
          from: new Date(payload.from),
          to: new Date(payload.to),
        });
      }
    },
  );

  // v1.4.39 W-MOOD — mood-rollup boot-time fold worker. The boot
  // discovery helper below sends one job per user with mood entries
  // but zero rollup rows; this handler folds the full 5-year window
  // across every granularity. Concurrency-1 so the populator never
  // crowds the request pool.
  await boss.work<MoodRollupFullBackfillPayload>(
    MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
    { localConcurrency: MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          const { rowsUpserted, durationMs } =
            await recomputeUserMoodRollups(userId);
          workerLog(
            "info",
            `[mood-rollup-full-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
          );
        } catch (err) {
          recordError();
          workerLog(
            "error",
            `[mood-rollup-full-backfill] user=${userId} failed`,
            err,
          );
          throw err;
        }
      }
    },
  );

  // v1.4.39 W-MED — medication-compliance boot-backfill worker. The
  // discovery helper below sends one job per user with intake events
  // but zero rollup coverage; this handler folds the trailing 90-day
  // window per account. Concurrency-1 so the populator never crowds
  // the request pool.
  await boss.work<MedicationComplianceBackfillPayload>(
    MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
    { localConcurrency: MEDICATION_COMPLIANCE_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          const { rowsUpserted, durationMs } =
            await recomputeUserMedicationCompliance(userId);
          workerLog(
            "info",
            `[medication-compliance-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
          );
        } catch (err) {
          recordError();
          workerLog(
            "error",
            `[medication-compliance-backfill] user=${userId} failed`,
            err,
          );
          throw err;
        }
      }
    },
  );

  // v1.4.37 W7c — nightly drain worker. Walks every user × cumulative
  // type and folds per-sample APPLE_HEALTH rows older than the cutoff
  // into one `stats:…` row per calendar day. Idempotent — a second run
  // collapses zero buckets once every day is in the `stats:` shape.
  // Concurrency-1 so the drain never crowds the dashboard request pool
  // and a long backfill on Marc's account (300 k+ measurement rows)
  // stays a single sequential walk.
  await boss.work<DrainCumulativePayload>(
    DRAIN_CUMULATIVE_QUEUE,
    { localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          const summary = await drainPerSampleCumulative(getWorkerPrisma(), {
            dryRun: false,
            cutoffHours: DRAIN_CUMULATIVE_CUTOFF_HOURS,
            log: (line) => workerLog("info", line),
          });
          workerLog(
            "info",
            `[drain-cumulative] triggeredAt=${job.data.triggeredAt} usersScanned=${summary.totals.usersScanned} bucketsCollapsed=${summary.totals.bucketsCollapsed} perSampleRowsDeleted=${summary.totals.perSampleRowsDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted}`,
          );
        } catch (err) {
          recordError();
          workerLog("error", "[drain-cumulative] run failed", err);
        }
      }
    },
  );

  // v1.4.35.1 — fire-and-forget boot-time backfill discovery. Finds
  // every user with measurements but no rollup coverage and enqueues
  // a full-fold per account. Idempotent across reboots: the discovery
  // query only matches accounts with zero rollup rows, so once a
  // fold completes the user drops off the list. Errors are returned
  // through the helper's result value — the worker boot never fails
  // because of a backfill miss.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeRollupBackfill();
    if (error) {
      workerLog(
        "error",
        `[rollup-full-backfill] boot discovery failed: ${error}`,
      );
    } else {
      // v1.4.38.7 — log the discovery result on every boot, including
      // the silent `enqueued=0 skipped=0` case. Without this, an
      // operator chasing "analytics is slow" cannot tell whether the
      // discovery query ran successfully (and found nothing to fold)
      // vs. silently no-op'd. The line is one row per worker boot, so
      // the log cost is negligible.
      workerLog(
        "info",
        `[rollup-full-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[rollup-full-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.5.6 — fire-and-forget boot discovery for the legacy step
  // consolidation pass. Finds every user still holding live pre-v1.5.0
  // granular step rows and enqueues one consolidation job per account.
  // Idempotent across reboots: consolidated legacy rows are
  // soft-deleted, so the `deleted_at IS NULL` discovery predicate drops
  // them and the user falls off the list. Errors are returned through
  // the helper's result value — the worker boot never fails because of
  // a consolidation miss.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeStepConsolidation();
    if (error) {
      workerLog(
        "error",
        `[step-consolidation] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[step-consolidation] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[step-consolidation] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.7.0 — fire-and-forget boot discovery for the daily-mean
  // consolidation pass. Finds every user holding live per-sample
  // high-frequency mean-type rows and enqueues one job per account.
  // Idempotent across reboots: consolidated rows are soft-deleted, so
  // the discovery predicate drops them. Errors are returned through the
  // helper's result value — the worker boot never fails on a miss.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeMeanConsolidation();
    if (error) {
      workerLog(
        "error",
        `[mean-consolidation] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[mean-consolidation] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[mean-consolidation] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.8.2 — fire-and-forget boot discovery for the duplicate dose-slot
  // cleanup. Finds every user holding two live intake rows within the
  // drift window on the same medication and enqueues one dedup job per
  // account. Idempotent across reboots: collapsed losers are soft-deleted
  // so the `deleted_at IS NULL` discovery predicate drops them. Errors are
  // returned through the helper's result value — the worker boot never
  // fails because of a dedup miss.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeIntakeSlotDedup();
    if (error) {
      workerLog(
        "error",
        `[intake-slot-dedup] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[intake-slot-dedup] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[intake-slot-dedup] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.4.39 W-MOOD — fire-and-forget boot discovery for the mood
  // rollup tier. Mirrors the v1.4.35.1 measurement-rollup pattern:
  // one job per user with mood entries but no rollup coverage.
  // Idempotent across reboots and singleton-keyed inside pg-boss so
  // a fast restart while a backfill is queued doesn't double up.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeMoodRollupBackfill();
    if (error) {
      workerLog(
        "error",
        `[mood-rollup-full-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[mood-rollup-full-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[mood-rollup-full-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.4.39 W-MED — fire-and-forget boot discovery for the medication
  // compliance rollup tier. Mirrors the v1.4.35.1 pattern: one job per
  // user with intake events but no rollup coverage. Idempotent across
  // reboots and singleton-keyed inside pg-boss.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeMedicationComplianceBackfill();
    if (error) {
      workerLog(
        "error",
        `[medication-compliance-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[medication-compliance-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[medication-compliance-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  return boss;
}

// Run standalone
if (
  process.argv[1]?.endsWith("reminder-worker.ts") ||
  process.argv[1]?.endsWith("reminder-worker.js")
) {
  startReminderWorker().catch((err) => {
    workerLog("error", "Failed to start reminder worker", err);
    process.exit(1);
  });
}
