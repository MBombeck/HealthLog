/**
 * pg-boss based reminder worker.
 * Checks for overdue medication intakes and creates reminder events.
 *
 * Usage: Run as a standalone process or call startReminderWorker() from a
 * custom server setup. In dev, use: npx tsx src/lib/jobs/reminder-worker.ts
 */
import { PgBoss } from "pg-boss";
import type { Job } from "pg-boss";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const DATABASE_URL = process.env.DATABASE_URL!;

function createPrisma() {
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });
  return new PrismaClient({ adapter });
}

const QUEUE_NAME = "medication-reminder-check";
const CHECK_INTERVAL_CRON = "*/15 * * * *"; // every 15 minutes

interface ReminderCheckPayload {
  triggeredAt: string;
}

/**
 * Check all active medications for each user and find overdue doses.
 * A dose is overdue when current time is past windowEnd and no intake event
 * exists for today in that schedule window.
 */
async function handleReminderCheck(_jobs: Job<ReminderCheckPayload>[]) {
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
        user: { select: { id: true, timezone: true } },
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
        }
      }
    }
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

  // Register the handler
  await boss.work<ReminderCheckPayload>(
    QUEUE_NAME,
    { localConcurrency: 1 },
    handleReminderCheck,
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
