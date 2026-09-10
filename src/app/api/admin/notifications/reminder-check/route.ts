import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues, safeJson } from "@/lib/api-response";
import { adminReminderCheckSchema } from "@/lib/validations/notifications";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import { getUserTodayBounds, getDayOfWeekInTz } from "@/lib/tz/local-day";

export const dynamic = "force-dynamic";

function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  // Normalize "24:00" → "00:00" (some ICU builds emit that for midnight).
  const hours = h === 24 ? 0 : h;
  return hours * 60 + m;
}

const dayLabels = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

interface ScheduleStatus {
  window: string;
  days: string;
  status: "open" | "late" | "threshold" | "missed" | "skipped";
  label: string;
  minutesPastEnd: number | null;
  notificationSent: boolean;
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

/**
 * POST: Execute the reminder check — analyses medications AND sends
 * notifications for overdue schedules (late + missed). Returns detailed
 * results for display in the admin panel.
 *
 * ## Scope
 *
 * The sweep is instance-wide by default: no body, every active medication on
 * the instance, one dispatch per overdue slot. That is the operator button's
 * long-standing behaviour and it stays.
 *
 * An optional `userId` in the body narrows it to ONE account. The direction
 * that matters is easy to state backwards, so it is written here: the hazard a
 * caller of this route creates is not that somebody else writes into its
 * window, it is that THIS call dispatches into everybody else's — a run reaches
 * every account that has an overdue dose and a configured channel. A caller
 * that only means to sweep one account names it and stops being a second
 * writer for every other one.
 *
 * Naming an account cannot widen anything. `requireAdmin()` is cookie-only by
 * construction, so a Bearer token — wildcard scope included — never reaches
 * this handler at all, and the field only ever removes rows from the `where`.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  // A bodyless POST is the admin console's own call (`apiPost(path)` sends no
  // body and no content-type), so the parse only runs when a JSON body is
  // actually presented. An empty object is the same instance-wide sweep.
  let input: unknown = {};
  if (
    (request.headers.get("content-type") ?? "").includes("application/json")
  ) {
    const { data, error } = await safeJson(request, { maxBytes: 4 * 1024 });
    if (error) return error;
    input = data ?? {};
  }
  const parsed = adminReminderCheckSchema.safeParse(input);
  if (!parsed.success) return returnAllZodIssues(parsed.error);
  const scopedUserId = parsed.data.userId ?? null;

  annotate({
    action: { name: "admin.notifications.reminder-check" },
    meta: { scope: scopedUserId ? "account" : "instance" },
  });

  const now = new Date();

  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { reminderMissedMinutes: true },
  });
  const missedMinutes = appSettings?.reminderMissedMinutes ?? 240;

  const medications = await prisma.medication.findMany({
    where: {
      active: true,
      // Absent selector ⇒ no `userId` key ⇒ the instance-wide sweep.
      ...(scopedUserId ? { userId: scopedUserId } : {}),
    },
    include: {
      schedules: true,
      user: { select: { id: true, username: true, timezone: true } },
    },
  });

  const results: MedicationResult[] = [];
  let notificationsSent = 0;

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

    const eventCount = await prisma.medicationIntakeEvent.count({
      where: {
        medicationId: med.id,
        userId: med.user.id,
        scheduledFor: { gte: todayStart, lte: todayEnd },
      },
    });

    const scheduleStatuses: ScheduleStatus[] = [];
    let schedulesProcessed = 0;

    const sortedSchedules = [...med.schedules].sort((a, b) =>
      a.windowStart.localeCompare(b.windowStart),
    );

    for (const schedule of sortedSchedules) {
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
      let notificationSent = false;

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

      // Send notification for overdue schedules that haven't been taken
      const isOverdue = dayMatch && minutesPastEnd > 0;
      const hasEvent = eventCount > schedulesProcessed;

      if (isOverdue && !hasEvent && med.notificationsEnabled) {
        const doseInfo = schedule.dose ?? med.dose;
        const timeWindow = `${schedule.windowStart}–${schedule.windowEnd}`;

        try {
          // v1.4.27 F21 — each notification renders in the affected
          // user's `User.locale` (the recipient is the user whose dose
          // is overdue, not the admin running the check).
          // `dispatchLocalisedNotification` resolves the locale from
          // the userId inside the helper.
          if (status === "missed") {
            await dispatchLocalisedNotification({
              userId: med.user.id,
              eventType: "MEDICATION_REMINDER",
              titleKey: "notifications.admin.reminderCheckMissedTitle",
              messageKey: "notifications.admin.reminderCheckMissedBody",
              params: {
                medication: med.name,
                dose: doseInfo,
                window: timeWindow,
              },
              metadata: { medicationId: med.id },
            });
          } else {
            await dispatchLocalisedNotification({
              userId: med.user.id,
              eventType: "MEDICATION_REMINDER",
              titleKey: "notifications.admin.reminderCheckOverdueTitle",
              messageKey: "notifications.admin.reminderCheckOverdueBody",
              params: {
                medication: med.name,
                dose: doseInfo,
                window: timeWindow,
                minutes: minutesPastEnd,
              },
              metadata: { medicationId: med.id },
            });
          }
          notificationSent = true;
          notificationsSent++;
        } catch (err) {
          getEvent()?.addWarning(
            "Notification failed for " + med.name + ": " + err,
          );
        }
      }

      if (dayMatch && minutesPastEnd > 0) {
        schedulesProcessed++;
      }

      scheduleStatuses.push({
        window: `${schedule.windowStart}–${schedule.windowEnd}`,
        days: daysInfo,
        status,
        label,
        minutesPastEnd:
          dayMatch && currentMins > endMins ? minutesPastEnd : null,
        notificationSent,
      });
    }

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
    scoped: scopedUserId !== null,
    medications: results,
    notificationsSent,
    message:
      results.length > 0
        ? `${results.length} Medikamente geprüft, ${notificationsSent} Erinnerungen gesendet`
        : "Keine aktiven Medikamente gefunden",
  });
});
