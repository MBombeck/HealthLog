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
import { deleteMessage } from "@/lib/telegram";
import { decrypt } from "@/lib/crypto";
import { syncMoodLogEntries } from "@/lib/moodlog/sync";
import {
  DEFAULT_PHASE_CONFIG,
  resolvePhaseThresholds,
  determinePhase,
  getPhaseMessage,
  getPhaseKeyboard,
} from "@/lib/jobs/reminder-phases";

function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
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

interface ReminderCheckPayload {
  triggeredAt: string;
}

interface WithingsSyncPayload {
  triggeredAt: string;
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

/**
 * Get the start and end of "today" in the user's timezone, returned as UTC Dates.
 * Example: For Europe/Berlin (UTC+1) at 2026-02-21 10:00 Berlin,
 * returns start=2026-02-20T23:00:00Z, end=2026-02-21T22:59:59.999Z
 */
function getUserTodayBounds(
  now: Date,
  tz: string,
): { start: Date; end: Date } {
  // Get the user's local time representation to compute the offset
  const localStr = now.toLocaleString("en-US", { timeZone: tz });
  const localDate = new Date(localStr);

  // Offset in ms (positive = user is ahead of UTC)
  const offsetMs =
    Math.round((localDate.getTime() - now.getTime()) / 60000) * 60000;

  // User's local midnight
  const localMidnight = new Date(localDate);
  localMidnight.setHours(0, 0, 0, 0);

  // Convert back to UTC
  const start = new Date(localMidnight.getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  return { start, end };
}

/**
 * Get the day of the week (0=Sun..6=Sat) in the user's timezone.
 */
function getDayOfWeekInTz(now: Date, tz: string): number {
  const localDate = new Date(
    now.toLocaleString("en-US", { timeZone: tz }),
  );
  return localDate.getDay();
}

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
    // eslint-disable-next-line no-constant-condition
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
      console.log(
        `[telegram-scheduled-cleanup] Deleted ${totalDeleted} expired messages`,
      );
    }
  } catch (err) {
    console.error("[telegram-scheduled-cleanup] Failed:", err);
  }
}

/**
 * Check all active medications for each user and determine reminder phases.
 * Uses phase-based logic (GREEN/YELLOW/ORANGE/RED) to send one notification
 * per phase transition rather than every 15 minutes.
 */
async function handleReminderCheck(jobs: Job<ReminderCheckPayload>[]) {
  void jobs;
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

      const currentTime = now.toLocaleTimeString("de-DE", {
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
        const thresholds = resolvePhaseThresholds(phaseConfig, windowDuration);

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

            console.log(
              `[reminder] Missed dose: ${med.name} for user ${med.user.id}, schedule ${schedule.windowStart}-${schedule.windowEnd}`,
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
          );

          const keyboard = getPhaseKeyboard(currentPhase, med.id);

          console.log(
            `[reminder] Phase ${currentPhase}: ${med.name} for user ${med.user.id}, schedule ${schedule.windowStart}-${schedule.windowEnd}`,
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
            console.error(
              `[reminder] Notification dispatch failed for ${currentPhase} phase ${med.name}:`,
              notifErr,
            );
          }
        }

        schedulesProcessed++;
      }
    }
  } catch (err) {
    console.error("[reminder] handleReminderCheck failed:", err);
    recordError();
  }
}

/**
 * Fallback polling for Withings data.
 * Runs periodically in case webhook delivery is delayed or unavailable.
 */
async function handleWithingsFallbackSync(jobs: Job<WithingsSyncPayload>[]) {
  void jobs;
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
        console.error(
          `[withings] Fallback sync failed for user ${connection.userId}:`,
          err,
        );
      }
    }

    console.log(
      `[withings] Fallback sync completed: ${usersSynced}/${connections.length} users, ${measurementsImported} measurements imported`,
    );
  } catch (err) {
    console.error("[withings] handleWithingsFallbackSync failed:", err);
    recordError();
  }
}

async function handleGeneralStatusGenerate(jobs: Job<GeneralStatusPayload>[]) {
  void jobs;
  const prisma = getWorkerPrisma();
  try {
    recordInsightsRun();
    const users = await prisma.user.findMany({
      where: { openaiKeyEncrypted: { not: null } },
      select: { id: true, locale: true },
    });

    if (users.length === 0) {
      return;
    }

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
        console.error(
          `[insights.general-status] generation failed for user ${user.id}:`,
          error,
        );
      }
    }

    console.log(
      `[insights.general-status] completed: generated=${generated}, failed=${failed}, total=${users.length}`,
    );
  } catch (err) {
    console.error("[insights.general-status] handler failed:", err);
    recordError();
  }
}

async function handleBloodPressureStatusGenerate(
  jobs: Job<BloodPressureStatusPayload>[],
) {
  void jobs;
  const prisma = getWorkerPrisma();
  try {
    const users = await prisma.user.findMany({
      where: { openaiKeyEncrypted: { not: null } },
      select: { id: true, locale: true },
    });

    if (users.length === 0) {
      return;
    }

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
        console.error(
          `[insights.blood-pressure-status] generation failed for user ${user.id}:`,
          error,
        );
      }
    }

    console.log(
      `[insights.blood-pressure-status] completed: generated=${generated}, failed=${failed}, total=${users.length}`,
    );
  } catch (err) {
    console.error("[insights.blood-pressure-status] handler failed:", err);
    recordError();
  }
}

async function handleWeightStatusGenerate(jobs: Job<WeightStatusPayload>[]) {
  void jobs;
  const prisma = getWorkerPrisma();
  try {
    const users = await prisma.user.findMany({
      where: { openaiKeyEncrypted: { not: null } },
      select: { id: true, locale: true },
    });

    if (users.length === 0) {
      return;
    }

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
        console.error(
          `[insights.weight-status] generation failed for user ${user.id}:`,
          error,
        );
      }
    }

    console.log(
      `[insights.weight-status] completed: generated=${generated}, failed=${failed}, total=${users.length}`,
    );
  } catch (err) {
    console.error("[insights.weight-status] handler failed:", err);
    recordError();
  }
}

async function handlePulseStatusGenerate(jobs: Job<PulseStatusPayload>[]) {
  void jobs;
  const prisma = getWorkerPrisma();
  try {
    const users = await prisma.user.findMany({
      where: { openaiKeyEncrypted: { not: null } },
      select: { id: true, locale: true },
    });

    if (users.length === 0) {
      return;
    }

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
        console.error(
          `[insights.pulse-status] generation failed for user ${user.id}:`,
          error,
        );
      }
    }

    console.log(
      `[insights.pulse-status] completed: generated=${generated}, failed=${failed}, total=${users.length}`,
    );
  } catch (err) {
    console.error("[insights.pulse-status] handler failed:", err);
    recordError();
  }
}

async function handleBmiStatusGenerate(jobs: Job<BmiStatusPayload>[]) {
  void jobs;
  const prisma = getWorkerPrisma();
  try {
    const users = await prisma.user.findMany({
      where: { openaiKeyEncrypted: { not: null } },
      select: { id: true, locale: true },
    });

    if (users.length === 0) {
      return;
    }

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
        console.error(
          `[insights.bmi-status] generation failed for user ${user.id}:`,
          error,
        );
      }
    }

    console.log(
      `[insights.bmi-status] completed: generated=${generated}, failed=${failed}, total=${users.length}`,
    );
  } catch (err) {
    console.error("[insights.bmi-status] handler failed:", err);
    recordError();
  }
}

async function handleMedicationComplianceStatusGenerate(
  jobs: Job<MedicationComplianceStatusPayload>[],
) {
  void jobs;
  const prisma = getWorkerPrisma();
  try {
    const users = await prisma.user.findMany({
      where: { openaiKeyEncrypted: { not: null } },
      select: { id: true, locale: true },
    });

    if (users.length === 0) {
      return;
    }

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
        console.error(
          `[insights.medication-compliance-status] generation failed for user ${user.id}:`,
          error,
        );
      }
    }

    console.log(
      `[insights.medication-compliance-status] completed: generated=${generated}, failed=${failed}, total=${users.length}`,
    );
  } catch (err) {
    console.error("[insights.medication-compliance-status] handler failed:", err);
    recordError();
  }
}

/**
 * Delete a Telegram message after a 24h delay.
 * Scheduled by the Telegram sender when a notification is sent.
 */
async function handleTelegramCleanup(jobs: Job<TelegramCleanupPayload>[]) {
  const prisma = getWorkerPrisma();
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
      }
    } catch (err) {
      console.error("[telegram-cleanup] Failed to delete message:", err);
    }
  }
}

/**
 * Fallback polling for moodLog data.
 * Syncs mood entries for all users with moodLog enabled.
 */
async function handleMoodLogSync(jobs: Job<MoodLogSyncPayload>[]) {
  void jobs;
  const prisma = getWorkerPrisma();
  try {
    // Check global toggle
    const appSettings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { moodLogGlobal: true },
    });
    if (appSettings && !appSettings.moodLogGlobal) {
      console.log("[moodlog] Global toggle disabled, skipping sync");
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
        console.error(
          `[moodlog] Fallback sync failed for user ${user.id}:`,
          err,
        );
      }
    }

    console.log(
      `[moodlog] Fallback sync completed: ${synced}/${users.length} users, ${totalImported} entries imported`,
    );
  } catch (err) {
    console.error("[moodlog] handleMoodLogSync failed:", err);
    recordError();
  }
}

async function handleDataBackup(jobs: Job<DataBackupPayload>[]) {
  void jobs;
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

        const backup = JSON.stringify({
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

        await prisma.dataBackup.upsert({
          where: {
            userId_type: { userId: user.id, type: "WEEKLY_AUTO" },
          },
          update: {
            data: backup,
            createdAt: new Date(),
          },
          create: {
            userId: user.id,
            type: "WEEKLY_AUTO",
            data: backup,
          },
        });
        backed++;
      } catch (err) {
        console.error(
          `[data-backup] Failed for user ${user.id}:`,
          err,
        );
      }
    }

    console.log(
      `[data-backup] Completed: ${backed}/${users.length} users backed up`,
    );
  } catch (err) {
    console.error("[data-backup] handleDataBackup failed:", err);
    recordError();
  }
}

export async function startReminderWorker() {
  console.log("[pg-boss] Initializing pg-boss with DATABASE_URL...");
  if (!DATABASE_URL) {
    console.error("[pg-boss] CRITICAL: DATABASE_URL is not set!");
    return;
  }

  const boss = new PgBoss(DATABASE_URL);

  boss.on("error", (error: unknown) => {
    console.error("[pg-boss] Error:", error);
    recordError();
  });

  console.log("[pg-boss] Connecting to database...");
  await boss.start();
  setGlobalBoss(boss);
  markWorkerStarted();
  console.log("[pg-boss] Connected and started");

  // pg-boss v12 requires explicit queue creation before scheduling
  const allQueues = [
    QUEUE_NAME,
    WITHINGS_SYNC_QUEUE,
    GENERAL_STATUS_QUEUE,
    BLOOD_PRESSURE_STATUS_QUEUE,
    WEIGHT_STATUS_QUEUE,
    PULSE_STATUS_QUEUE,
    BMI_STATUS_QUEUE,
    MEDICATION_COMPLIANCE_STATUS_QUEUE,
    TELEGRAM_CLEANUP_QUEUE,
    MOODLOG_SYNC_QUEUE,
    DATA_BACKUP_QUEUE,
  ];

  for (const q of allQueues) {
    await boss.createQueue(q);
  }
  console.log(`[pg-boss] Created ${allQueues.length} queues`);

  // Schedule recurring cron jobs
  const schedules: [string, string][] = [
    [QUEUE_NAME, CHECK_INTERVAL_CRON],
    [WITHINGS_SYNC_QUEUE, WITHINGS_SYNC_CRON],
    [GENERAL_STATUS_QUEUE, GENERAL_STATUS_CRON],
    [BLOOD_PRESSURE_STATUS_QUEUE, BLOOD_PRESSURE_STATUS_CRON],
    [WEIGHT_STATUS_QUEUE, WEIGHT_STATUS_CRON],
    [PULSE_STATUS_QUEUE, PULSE_STATUS_CRON],
    [BMI_STATUS_QUEUE, BMI_STATUS_CRON],
    [MEDICATION_COMPLIANCE_STATUS_QUEUE, MEDICATION_COMPLIANCE_STATUS_CRON],
    [MOODLOG_SYNC_QUEUE, MOODLOG_SYNC_CRON],
    [DATA_BACKUP_QUEUE, DATA_BACKUP_CRON],
  ];

  for (const [name, cron] of schedules) {
    await boss.schedule(name, cron, {}, { tz: "Europe/Berlin" });
  }
  console.log(`[pg-boss] Scheduled ${schedules.length} cron jobs`);

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

  return boss;
}

// Run standalone
if (
  process.argv[1]?.endsWith("reminder-worker.ts") ||
  process.argv[1]?.endsWith("reminder-worker.js")
) {
  startReminderWorker().catch((err) => {
    console.error("Failed to start reminder worker:", err);
    process.exit(1);
  });
}
