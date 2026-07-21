/**
 * Test script for notification delivery and reminder check.
 *
 * Usage (from a source checkout with the target environment exported):
 *   pnpm dlx tsx scripts/test-notifications.ts
 *
 * What it does:
 *   1. Lists all configured notification channels
 *   2. Sends a test notification through each enabled channel
 *   3. Runs the reminder check logic once with verbose logging
 */

import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { decrypt } from "@/lib/crypto";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { getUserTodayBounds, getDayOfWeekInTz } from "@/lib/tz/local-day";

const DATABASE_URL = process.env.DATABASE_URL!;

function createPrisma() {
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });
  return new PrismaClient({ adapter });
}

function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

// getUserTodayBounds and getDayOfWeekInTz imported from @/lib/tz/local-day

const dayLabels = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

async function main() {
  const prisma = createPrisma();

  try {
    console.log("=== HealthLog Notification Test ===\n");

    // ── Step 1: List channels ──
    console.log("── 1. Notification Channels ──\n");
    const channels = await prisma.notificationChannel.findMany({
      include: { user: { select: { id: true, username: true } } },
    });

    if (channels.length === 0) {
      console.log("❌ Keine Notification-Channels konfiguriert!");
      console.log(
        "   → Gehe zu Einstellungen > Benachrichtigungen und richte einen Kanal ein.\n",
      );
      return;
    }

    for (const ch of channels) {
      const status = ch.enabled ? "✅ aktiv" : "⏸️  deaktiviert";
      let configInfo = "";
      try {
        const config = JSON.parse(decrypt(ch.config));
        if (ch.type === "TELEGRAM") {
          configInfo = `Chat-ID: ${config.chatId}`;
        } else if (ch.type === "NTFY") {
          configInfo = `Topic: ${config.topic}`;
        } else {
          configInfo = "Web Push";
        }
      } catch {
        configInfo = "(Config nicht lesbar)";
      }
      console.log(
        `  ${ch.type} [${status}] — User: ${ch.user.username} — ${configInfo}`,
      );
    }

    // ── Step 2: Send test notification ──
    console.log("\n── 2. Test-Notification senden ──\n");
    const enabledChannels = channels.filter((ch) => ch.enabled);

    if (enabledChannels.length === 0) {
      console.log("❌ Keine aktivierten Channels — überspringe Test.\n");
    } else {
      const userIds = [...new Set(enabledChannels.map((ch) => ch.userId))];
      for (const userId of userIds) {
        console.log(`  Sende Test-Notification an User ${userId}...`);
        try {
          await dispatchNotification({
            eventType: "SYSTEM_ALERT",
            userId,
            title: "🔔 Test-Notification",
            message:
              "<b>HealthLog Test:</b> Wenn du diese Nachricht siehst, funktionieren deine Benachrichtigungen!",
          });
          console.log("  ✅ Dispatched (best-effort, check deine Kanäle)\n");
        } catch (err) {
          console.error("  ❌ Fehler:", err);
        }
      }
    }

    // ── Step 3: Reminder check dry-run ──
    console.log("── 3. Reminder-Check (Dry-Run) ──\n");

    const now = new Date();
    console.log(`  Aktuelle Zeit (UTC): ${now.toISOString()}`);

    const appSettings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { reminderMissedMinutes: true },
    });
    const missedMinutes = appSettings?.reminderMissedMinutes ?? 240;
    console.log(`  Verpasst-Schwellenwert: ${missedMinutes} Minuten\n`);

    const medications = await prisma.medication.findMany({
      where: { active: true },
      include: {
        schedules: true,
        user: { select: { id: true, username: true, timezone: true } },
      },
    });

    if (medications.length === 0) {
      console.log("  Keine aktiven Medikamente gefunden.\n");
      return;
    }

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

      console.log(
        `  📋 ${med.name} (${med.dose}) — User: ${med.user.username}`,
      );
      console.log(
        `     Timezone: ${userTz}, Lokale Zeit: ${currentTime}, Tag: ${dayLabels[todayDow]}`,
      );
      console.log(
        `     Notifications: ${med.notificationsEnabled ? "✅ an" : "❌ aus"}`,
      );
      console.log(`     Schedules: ${med.schedules.length}`);

      for (const schedule of med.schedules) {
        const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
        const endMins = parseTimeToMinutes(schedule.windowEnd);
        const currentMins = parseTimeToMinutes(currentTime);
        const minutesPastEnd = currentMins - endMins;

        const dayMatch =
          recurrence.daysOfWeek.length === 0 ||
          recurrence.daysOfWeek.includes(todayDow);
        const windowPassed = currentMins > endMins;
        const thresholdPassed = minutesPastEnd > missedMinutes;

        let status: string;
        if (!dayMatch) {
          status = "⏭️  Heute kein geplanter Tag";
        } else if (!windowPassed) {
          status = `🟢 Fenster noch offen (endet um ${schedule.windowEnd})`;
        } else if (!thresholdPassed) {
          status = `🟡 Fenster vorbei seit ${minutesPastEnd} Min (Threshold: ${missedMinutes} Min)`;
        } else {
          status = `🔴 Missed-Threshold erreicht (${minutesPastEnd} Min > ${missedMinutes} Min)`;
        }

        const daysInfo =
          recurrence.daysOfWeek.length > 0
            ? ` [${recurrence.daysOfWeek.map((d) => dayLabels[d]).join(", ")}]`
            : " [Täglich]";

        console.log(
          `       ${schedule.windowStart}–${schedule.windowEnd}${daysInfo}: ${status}`,
        );
      }

      // Count existing events today
      const eventCount = await prisma.medicationIntakeEvent.count({
        where: {
          medicationId: med.id,
          userId: med.user.id,
          scheduledFor: { gte: todayStart, lte: todayEnd },
        },
      });
      console.log(`     Heutige Events: ${eventCount}\n`);
    }

    console.log("=== Test abgeschlossen ===");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
