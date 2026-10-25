/**
 * Today's intake events across the record's medications:
 * `GET /api/medications/intake?scope=today`.
 *
 * The route authenticates (READ over the `medications` section) and parses
 * the query; the projection, the read and the status mapping run here.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { projectTodayIntakesAndRecompute } from "@/lib/medications/scheduling/project-today-intakes";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";

export async function readTodayIntakes(input: {
  userId: string;
  userTz: string;
}) {
  const { userId, userTz } = input;
  // The real local day, 23 or 25 hours on a DST day: a fixed 24 h left the
  // last hour of the 25-hour day off the list, so a dose at 23:30 that night
  // could not be offered. Same window as the dashboard's meds tile.
  const { start: todayStart, end } = getUserTodayBounds(new Date(), userTz);
  const todayEnd = new Date(end.getTime() + 1);

  // Project pending intake rows for every active schedule whose window opens
  // today, then idempotently backfill any missing rows. Without it the
  // endpoint returned `[]` for daily meds (`schedule.daysOfWeek = null` in the
  // DB) until the reminder worker entered the RED phase at the end of the
  // dose window — leaving the iOS Dashboard tile + the "Erfassen" sheet empty
  // for the whole morning. The shared helper mirrors the dashboard-summary
  // call site so the two routes converge on the same row set.
  const { projected, backfilled } = await projectTodayIntakesAndRecompute({
    userId,
    userTz,
    todayStart,
    todayEnd,
  });

  const events = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      // Exclude tombstoned rows from the today list.
      deletedAt: null,
      scheduledFor: { gte: todayStart, lt: todayEnd },
      // The today list is what clients offer doses from (#1033); a
      // medication with intake tracking off is not on it.
      ...TRACKED_INTAKE_EVENT_WHERE,
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    include: { medication: { select: { id: true, snoozedUntil: true } } },
  });

  annotate({
    action: { name: "medications.intake.today" },
    meta: {
      count: events.length,
      projected,
      backfilled,
    },
  });

  return events.map((e) => ({
    id: e.id,
    medicationId: e.medicationId,
    scheduledAt: e.scheduledFor.toISOString(),
    takenAt: e.takenAt?.toISOString() ?? null,
    status: e.skipped
      ? "skipped"
      : e.takenAt
        ? "taken"
        : // A never-acted dose the auto-miss cron flipped is a
          // terminal MISS, not a perpetual "pending". (Today's freshly
          // projected rows are < 24 h old so this rarely fires here, but
          // a stale row surfacing in the window reads honestly.)
          e.autoMissed
          ? "missed"
          : e.medication.snoozedUntil && e.medication.snoozedUntil > new Date()
            ? "snoozed"
            : "pending",
    snoozedUntil: e.medication.snoozedUntil?.toISOString() ?? null,
  }));
}
