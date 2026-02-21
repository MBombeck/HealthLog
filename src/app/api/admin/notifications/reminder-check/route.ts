import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";

export const dynamic = "force-dynamic";

function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function getUserTodayBounds(
  now: Date,
  tz: string,
): { start: Date; end: Date } {
  const localStr = now.toLocaleString("en-US", { timeZone: tz });
  const localDate = new Date(localStr);
  const offsetMs =
    Math.round((localDate.getTime() - now.getTime()) / 60000) * 60000;
  const localMidnight = new Date(localDate);
  localMidnight.setHours(0, 0, 0, 0);
  const start = new Date(localMidnight.getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

function getDayOfWeekInTz(now: Date, tz: string): number {
  return new Date(now.toLocaleString("en-US", { timeZone: tz })).getDay();
}

const dayLabels = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

interface ScheduleStatus {
  window: string;
  days: string;
  status: "open" | "late" | "threshold" | "missed" | "skipped";
  label: string;
  minutesPastEnd: number | null;
}

interface MedicationResult {
  name: string;
  dose: string;
  user: string;
  timezone: string;
  localTime: string;
  dayOfWeek: string;
  notificationsEnabled: boolean;
  schedules: ScheduleStatus[];
  eventsToday: number;
}

export async function POST() {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  try {
    const now = new Date();

    const appSettings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { reminderMissedMinutes: true },
    });
    const missedMinutes = appSettings?.reminderMissedMinutes ?? 240;

    const medications = await prisma.medication.findMany({
      where: { active: true },
      include: {
        schedules: true,
        user: { select: { id: true, username: true, timezone: true } },
      },
    });

    const results: MedicationResult[] = [];

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

      const scheduleStatuses: ScheduleStatus[] = [];

      for (const schedule of med.schedules) {
        const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
        const endMins = parseTimeToMinutes(schedule.windowEnd);
        const currentMins = parseTimeToMinutes(currentTime);
        const minutesPastEnd = currentMins - endMins;

        const dayMatch =
          recurrence.daysOfWeek.length === 0 ||
          recurrence.daysOfWeek.includes(todayDow);

        const daysInfo =
          recurrence.daysOfWeek.length > 0
            ? recurrence.daysOfWeek.map((d) => dayLabels[d]).join(", ")
            : "Täglich";

        let status: ScheduleStatus["status"];
        let label: string;

        if (!dayMatch) {
          status = "skipped";
          label = "Heute kein geplanter Tag";
        } else if (currentMins <= endMins) {
          status = "open";
          label = `Fenster noch offen (endet um ${schedule.windowEnd})`;
        } else if (minutesPastEnd <= missedMinutes) {
          status = "threshold";
          label = `Fenster vorbei seit ${minutesPastEnd} Min (Threshold: ${missedMinutes} Min)`;
        } else {
          status = "missed";
          label = `Missed-Threshold erreicht (${minutesPastEnd} Min > ${missedMinutes} Min)`;
        }

        scheduleStatuses.push({
          window: `${schedule.windowStart}–${schedule.windowEnd}`,
          days: daysInfo,
          status,
          label,
          minutesPastEnd: dayMatch && currentMins > endMins ? minutesPastEnd : null,
        });
      }

      const eventCount = await prisma.medicationIntakeEvent.count({
        where: {
          medicationId: med.id,
          userId: med.user.id,
          scheduledFor: { gte: todayStart, lte: todayEnd },
        },
      });

      results.push({
        name: med.name,
        dose: med.dose,
        user: med.user.username,
        timezone: userTz,
        localTime: currentTime,
        dayOfWeek: dayLabels[todayDow],
        notificationsEnabled: med.notificationsEnabled,
        schedules: scheduleStatuses,
        eventsToday: eventCount,
      });
    }

    return apiSuccess({
      timestamp: now.toISOString(),
      missedThresholdMinutes: missedMinutes,
      medications: results,
      message:
        results.length > 0
          ? `${results.length} aktive Medikamente geprüft`
          : "Keine aktiven Medikamente gefunden",
    });
  } catch (error) {
    console.error("Reminder check dry-run failed:", error);
    return apiError("Reminder-Check konnte nicht ausgeführt werden", 500);
  }
}
