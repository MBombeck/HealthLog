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
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
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
import { runHostMetricTick } from "@/lib/jobs/host-metric-sampler";
import { aggregateRecommendationFeedback } from "@/lib/jobs/feedback-aggregator";
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
import { expireStaleInUseItems } from "@/lib/medications/inventory/service";
import { rotateLegacyMoodLogSecrets } from "@/lib/moodlog-secret";
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
import { withBackgroundEvent } from "@/lib/logging/background";
import { assertSubsystemEnabled } from "@/lib/process-type";
import { runOffhostBackup } from "@/lib/jobs/offhost-backup";
import {
  getUserTodayBounds as getUserTodayBoundsUtil,
  getDayOfWeekInTz as getDayOfWeekInTzUtil,
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
const TELEGRAM_CLEANUP_QUEUE = "telegram-message-cleanup";
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

interface TelegramCleanupPayload {
  userId: string;
  chatId: string;
  messageId: number;
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

interface OffhostBackupPayload {
  triggeredAt: string;
}

interface HostMetricSamplePayload {
  triggeredAt: string;
}

interface FeedbackAggregatorPayload {
  triggeredAt: string;
}

// Re-export timezone utilities under local names for backward compatibility
const getUserTodayBounds = getUserTodayBoundsUtil;
const getDayOfWeekInTz = getDayOfWeekInTzUtil;

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

        const todayDow = getDayOfWeekInTz(now, userTz);

        // Get today's date string in user's timezone for message tracking
        const localDateStr = now.toLocaleDateString("sv-SE", {
          timeZone: userTz,
        }); // YYYY-MM-DD format

        // Count existing intake events for this medication today
        const eventCount = await prisma.medicationIntakeEvent.count({
          where: {
            medicationId: med.id,
            userId: med.user.id,
            scheduledFor: { gte: todayStart, lte: todayEnd },
          },
        });

        // Resolve phase configuration
        const phaseConfig = med.phaseConfig ?? DEFAULT_PHASE_CONFIG;

        let schedulesProcessed = 0;
        const sortedSchedules = [...med.schedules].sort((a, b) =>
          a.windowStart.localeCompare(b.windowStart),
        );

        for (const schedule of sortedSchedules) {
          // Check day-of-week / recurrence constraints
          const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
          if (
            recurrence.daysOfWeek.length > 0 &&
            !recurrence.daysOfWeek.includes(todayDow)
          ) {
            continue;
          }

          const startMins = parseTimeToMinutes(schedule.windowStart);
          const endMins = parseTimeToMinutes(schedule.windowEnd);
          const currentMins = parseTimeToMinutes(currentTime);
          const windowDuration = endMins - startMins;
          const minutesToEnd = endMins - currentMins;
          const minutesFromStart = currentMins - startMins;

          // Skip if enough intake events exist
          if (eventCount > schedulesProcessed) {
            schedulesProcessed++;
            continue;
          }

          // Skip if medication is snoozed
          if (med.snoozedUntil && now < med.snoozedUntil) {
            schedulesProcessed++;
            continue;
          }

          // Resolve phase thresholds
          const thresholds = resolvePhaseThresholds(
            phaseConfig,
            windowDuration,
          );

          // Determine current phase
          const currentPhase = determinePhase(
            minutesToEnd,
            minutesFromStart,
            thresholds,
          );

          if (!currentPhase) {
            schedulesProcessed++;
            continue;
          }

          // Check if this phase was already notified today
          const existingMessage =
            await prisma.telegramReminderMessage.findUnique({
              where: {
                medicationId_scheduleId_date_phase: {
                  medicationId: med.id,
                  scheduleId: schedule.id,
                  date: localDateStr,
                  phase: currentPhase,
                },
              },
            });

          if (existingMessage) {
            // Already sent for this phase — skip
            schedulesProcessed++;
            continue;
          }

          const doseInfo = schedule.dose ?? med.dose;
          const timeWindow = `${schedule.windowStart}–${schedule.windowEnd}`;

          // RED phase: create missed intake event
          if (currentPhase === "RED") {
            const [h, m] = schedule.windowStart.split(":").map(Number);
            const scheduledFor = new Date(
              todayStart.getTime() + h * 3600000 + m * 60000,
            );

            const existingMissed = await prisma.medicationIntakeEvent.count({
              where: {
                medicationId: med.id,
                userId: med.user.id,
                scheduledFor,
                takenAt: null,
                source: "REMINDER",
              },
            });

            if (existingMissed === 0) {
              await prisma.medicationIntakeEvent.create({
                data: {
                  userId: med.user.id,
                  medicationId: med.id,
                  scheduledFor,
                  takenAt: null,
                  skipped: false,
                  source: "REMINDER",
                },
              });

              evt.addMeta(
                "missed_dose",
                `${med.name}:${schedule.windowStart}-${schedule.windowEnd}`,
              );
            }
          }

          // Send notification if enabled
          if (med.notificationsEnabled) {
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

            evt.addMeta(
              "notification_phase",
              `${currentPhase}:${med.name}:${schedule.windowStart}-${schedule.windowEnd}`,
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
                  replyMarkup: keyboard,
                },
              });
            } catch (notifErr) {
              evt.addWarning(
                `Notification dispatch failed for ${currentPhase} phase ${med.name}: ${notifErr}`,
              );
            }
          }

          schedulesProcessed++;
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
async function handleWithingsSleepSync(
  jobs: Job<WithingsSleepSyncPayload>[],
) {
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
 * Delete a Telegram message after a 24h delay.
 * Scheduled by the Telegram sender when a notification is sent.
 */
async function handleTelegramCleanup(jobs: Job<TelegramCleanupPayload>[]) {
  await withBackgroundEvent("job.telegram_cleanup", async (evt) => {
    const prisma = getWorkerPrisma();
    let deleted = 0;
    for (const job of jobs) {
      try {
        const { userId, chatId, messageId } = job.data;
        const user = await prisma.user.findFirst({
          where: { id: userId, telegramBotToken: { not: null } },
          select: { telegramBotToken: true },
        });
        if (user?.telegramBotToken) {
          const botToken = decrypt(user.telegramBotToken);
          await deleteMessage(botToken, chatId, messageId);
          deleted++;
        }
      } catch (err) {
        evt.addWarning(`Failed to delete message: ${err}`);
      }
    }
    evt.setBackground({
      task_name: "job.telegram_cleanup",
      result: { deleted, total: jobs.length },
    });
  });
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
      const payloadUserId = (job.data as PrDetectionPayload | undefined)?.userId;
      const silent = (job.data as PrDetectionPayload | undefined)?.silent ?? false;
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
    TELEGRAM_CLEANUP_QUEUE,
    MOODLOG_SYNC_QUEUE,
    DATA_BACKUP_QUEUE,
    RATE_LIMIT_CLEANUP_QUEUE,
    IDEMPOTENCY_CLEANUP_QUEUE,
    AUDIT_LOG_CLEANUP_QUEUE,
    OFFHOST_BACKUP_QUEUE,
    HOST_METRIC_QUEUE,
    FEEDBACK_AGGREGATOR_QUEUE,
    PR_DETECTION_QUEUE,
    MEDICATION_INVENTORY_EXPIRE_QUEUE,
  ];

  for (const q of allQueues) {
    await boss.createQueue(q);
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
    [OFFHOST_BACKUP_QUEUE, OFFHOST_BACKUP_CRON],
    [HOST_METRIC_QUEUE, HOST_METRIC_CRON],
    [FEEDBACK_AGGREGATOR_QUEUE, FEEDBACK_AGGREGATOR_CRON],
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
  await boss.work<TelegramCleanupPayload>(
    TELEGRAM_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleTelegramCleanup,
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
