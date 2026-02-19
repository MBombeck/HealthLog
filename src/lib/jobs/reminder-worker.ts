/**
 * pg-boss based reminder worker.
 * Checks for overdue medication intakes and creates reminder events.
 * Sends Telegram notifications if configured.
 *
 * Usage: Run as a standalone process or call startReminderWorker() from a
 * custom server setup. In dev, use: npx tsx src/lib/jobs/reminder-worker.ts
 */
import { PgBoss } from "pg-boss";
import type { Job } from "pg-boss";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { sendTelegramMessage } from "@/lib/telegram";
import { decrypt } from "@/lib/crypto";
import { syncUserMeasurements } from "@/lib/withings/sync";

const DATABASE_URL = process.env.DATABASE_URL!;

function createPrisma() {
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });
  return new PrismaClient({ adapter });
}

const QUEUE_NAME = "medication-reminder-check";
const CHECK_INTERVAL_CRON = "*/15 * * * *"; // every 15 minutes
const WITHINGS_SYNC_QUEUE = "withings-fallback-sync";
const WITHINGS_SYNC_CRON = "0 * * * *"; // every 60 minutes

interface ReminderCheckPayload {
  triggeredAt: string;
}

interface WithingsSyncPayload {
  triggeredAt: string;
}

/**
 * Check all active medications for each user and find overdue doses.
 * A dose is overdue when current time is past windowEnd and no intake event
 * exists for today in that schedule window.
 */
async function handleReminderCheck(jobs: Job<ReminderCheckPayload>[]) {
  void jobs;
  const prisma = createPrisma();
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    // Get all active medications with schedules
    const medications = await prisma.medication.findMany({
      where: { active: true },
      include: {
        schedules: true,
        user: {
          select: {
            id: true,
            timezone: true,
            telegramEnabled: true,
            telegramBotToken: true,
            telegramChatId: true,
          },
        },
      },
    });

    for (const med of medications) {
      const currentTime = now.toLocaleTimeString("de-DE", {
        timeZone: med.user.timezone || "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      for (const schedule of med.schedules) {
        // Only check if we're past the windowEnd
        if (currentTime <= schedule.windowEnd) continue;

        // Check if there's already an intake event for today in this window
        const existingEvent = await prisma.medicationIntakeEvent.findFirst({
          where: {
            medicationId: med.id,
            userId: med.user.id,
            scheduledFor: { gte: todayStart, lte: todayEnd },
          },
        });

        if (!existingEvent) {
          // Create a "missed" event
          await prisma.medicationIntakeEvent.create({
            data: {
              userId: med.user.id,
              medicationId: med.id,
              scheduledFor: now,
              takenAt: null,
              skipped: false,
              source: "REMINDER",
            },
          });

          console.log(
            `[reminder] Missed dose: ${med.name} for user ${med.user.id}, schedule ${schedule.windowStart}-${schedule.windowEnd}`,
          );

          // Send Telegram notification (best-effort)
          if (
            med.user.telegramEnabled &&
            med.user.telegramBotToken &&
            med.user.telegramChatId
          ) {
            try {
              const botToken = decrypt(med.user.telegramBotToken);
              const doseInfo = schedule.dose ?? med.dose;
              const timeWindow = `${schedule.windowStart}–${schedule.windowEnd}`;
              await sendTelegramMessage(
                botToken,
                med.user.telegramChatId,
                `Erinnerung: <b>${med.name}</b> (${doseInfo}, ${timeWindow}) wurde noch nicht als eingenommen markiert.`,
                {
                  replyMarkup: {
                    inline_keyboard: [
                      [
                        {
                          text: "Als genommen markieren",
                          callback_data: `taken:${med.id}`,
                        },
                      ],
                    ],
                  },
                },
              );
            } catch (err) {
              console.error(
                `[reminder] Telegram notification failed for user ${med.user.id}:`,
                err,
              );
            }
          }
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Fallback polling for Withings data.
 * Runs periodically in case webhook delivery is delayed or unavailable.
 */
async function handleWithingsFallbackSync(jobs: Job<WithingsSyncPayload>[]) {
  void jobs;
  const prisma = createPrisma();
  try {
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
  } finally {
    await prisma.$disconnect();
  }
}

export async function startReminderWorker() {
  const boss = new PgBoss(DATABASE_URL);

  boss.on("error", (error: unknown) => {
    console.error("[pg-boss] Error:", error);
  });

  await boss.start();
  console.log("[pg-boss] Started reminder worker");

  // Schedule the recurring check
  await boss.schedule(
    QUEUE_NAME,
    CHECK_INTERVAL_CRON,
    {},
    {
      tz: "Europe/Berlin",
    },
  );
  console.log(`[pg-boss] Scheduled ${QUEUE_NAME} at ${CHECK_INTERVAL_CRON}`);

  await boss.schedule(
    WITHINGS_SYNC_QUEUE,
    WITHINGS_SYNC_CRON,
    {},
    {
      tz: "Europe/Berlin",
    },
  );
  console.log(
    `[pg-boss] Scheduled ${WITHINGS_SYNC_QUEUE} at ${WITHINGS_SYNC_CRON}`,
  );

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
