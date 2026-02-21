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
import { syncUserMeasurements } from "@/lib/withings/sync";
import { generateGeneralStatusForUser } from "@/lib/insights/general-status";
import { generateBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import { generateWeightStatusForUser } from "@/lib/insights/weight-status";
import { generatePulseStatusForUser } from "@/lib/insights/pulse-status";
import { generateBmiStatusForUser } from "@/lib/insights/bmi-status";
import { generateMedicationComplianceStatusForUser } from "@/lib/insights/medication-compliance-status";

const DATABASE_URL = process.env.DATABASE_URL!;

function createPrisma() {
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });
  return new PrismaClient({ adapter });
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

          if (!med.notificationsEnabled) {
            continue;
          }

          // Send notification via dispatcher (best-effort, respects user preferences)
          const doseInfo = schedule.dose ?? med.dose;
          const timeWindow = `${schedule.windowStart}–${schedule.windowEnd}`;
          await dispatchNotification({
            eventType: "MEDICATION_REMINDER",
            userId: med.user.id,
            title: `Erinnerung: ${med.name}`,
            message: `Erinnerung: <b>${med.name}</b> (${doseInfo}, ${timeWindow}) wurde noch nicht als eingenommen markiert.`,
            metadata: { medicationId: med.id },
          });
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

async function handleGeneralStatusGenerate(jobs: Job<GeneralStatusPayload>[]) {
  void jobs;
  const prisma = createPrisma();
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
  } finally {
    await prisma.$disconnect();
  }
}

async function handleBloodPressureStatusGenerate(
  jobs: Job<BloodPressureStatusPayload>[],
) {
  void jobs;
  const prisma = createPrisma();
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
  } finally {
    await prisma.$disconnect();
  }
}

async function handleWeightStatusGenerate(jobs: Job<WeightStatusPayload>[]) {
  void jobs;
  const prisma = createPrisma();
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
  } finally {
    await prisma.$disconnect();
  }
}

async function handlePulseStatusGenerate(jobs: Job<PulseStatusPayload>[]) {
  void jobs;
  const prisma = createPrisma();
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
  } finally {
    await prisma.$disconnect();
  }
}

async function handleBmiStatusGenerate(jobs: Job<BmiStatusPayload>[]) {
  void jobs;
  const prisma = createPrisma();
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
  } finally {
    await prisma.$disconnect();
  }
}

async function handleMedicationComplianceStatusGenerate(
  jobs: Job<MedicationComplianceStatusPayload>[],
) {
  void jobs;
  const prisma = createPrisma();
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
  await boss.schedule(
    GENERAL_STATUS_QUEUE,
    GENERAL_STATUS_CRON,
    {},
    {
      tz: "Europe/Berlin",
    },
  );
  console.log(
    `[pg-boss] Scheduled ${GENERAL_STATUS_QUEUE} at ${GENERAL_STATUS_CRON}`,
  );
  await boss.schedule(
    BLOOD_PRESSURE_STATUS_QUEUE,
    BLOOD_PRESSURE_STATUS_CRON,
    {},
    {
      tz: "Europe/Berlin",
    },
  );
  console.log(
    `[pg-boss] Scheduled ${BLOOD_PRESSURE_STATUS_QUEUE} at ${BLOOD_PRESSURE_STATUS_CRON}`,
  );
  await boss.schedule(
    WEIGHT_STATUS_QUEUE,
    WEIGHT_STATUS_CRON,
    {},
    {
      tz: "Europe/Berlin",
    },
  );
  console.log(
    `[pg-boss] Scheduled ${WEIGHT_STATUS_QUEUE} at ${WEIGHT_STATUS_CRON}`,
  );
  await boss.schedule(
    PULSE_STATUS_QUEUE,
    PULSE_STATUS_CRON,
    {},
    {
      tz: "Europe/Berlin",
    },
  );
  console.log(
    `[pg-boss] Scheduled ${PULSE_STATUS_QUEUE} at ${PULSE_STATUS_CRON}`,
  );
  await boss.schedule(
    BMI_STATUS_QUEUE,
    BMI_STATUS_CRON,
    {},
    {
      tz: "Europe/Berlin",
    },
  );
  console.log(`[pg-boss] Scheduled ${BMI_STATUS_QUEUE} at ${BMI_STATUS_CRON}`);
  await boss.schedule(
    MEDICATION_COMPLIANCE_STATUS_QUEUE,
    MEDICATION_COMPLIANCE_STATUS_CRON,
    {},
    {
      tz: "Europe/Berlin",
    },
  );
  console.log(
    `[pg-boss] Scheduled ${MEDICATION_COMPLIANCE_STATUS_QUEUE} at ${MEDICATION_COMPLIANCE_STATUS_CRON}`,
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
