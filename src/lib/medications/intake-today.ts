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
import { slotsHeldBySnooze } from "@/lib/medications/snooze-scope";
import { resolveDosesByRow } from "@/lib/medications/dose-state/today";
import { serializeResolvedDose } from "@/lib/medications/dose-state/resolve";

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
    include: {
      medication: {
        select: {
          id: true,
          snoozedUntil: true,
          updatedAt: true,
          schedules: {
            select: {
              windowStart: true,
              windowEnd: true,
              timesOfDay: true,
              reminderGraceMinutes: true,
              doseWindows: true,
            },
          },
        },
      },
    },
  });

  // A snooze answers one dose, not the medication: the slots it holds by the
  // reminder worker's own rule, per medication.
  const now = new Date();
  const heldByMedication = new Map<string, Set<number>>();
  for (const e of events) {
    if (heldByMedication.has(e.medicationId)) continue;
    heldByMedication.set(
      e.medicationId,
      slotsHeldBySnooze({
        snoozedUntil: e.medication.snoozedUntil,
        snoozedAt: e.medication.updatedAt,
        schedules: e.medication.schedules,
        slotInstants: events
          .filter((x) => x.medicationId === e.medicationId)
          .map((x) => x.scheduledFor),
        tz: userTz,
        now,
      }),
    );
  }

  // The resolved dose state of each row, from each medication's ledger
  // (`dose-state/resolve.ts`): one answer for every client.
  const resolved = await resolveDosesByRow({
    userId,
    userTz,
    medicationIds: events.map((e) => e.medicationId),
    takenViaByRow: new Map(events.map((e) => [e.id, e.takenVia])),
    from: todayStart,
    to: todayEnd,
    now,
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
    // Where the outcome was recorded, so a client can say "already taken at
    // 07:12 via an integration" before offering a second take.
    source: e.source,
    takenVia: e.takenAt ? e.takenVia : null,
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
          : heldByMedication.get(e.medicationId)?.has(e.scheduledFor.getTime())
            ? "snoozed"
            : "pending",
    snoozedUntil: heldByMedication
      .get(e.medicationId)
      ?.has(e.scheduledFor.getTime())
      ? (e.medication.snoozedUntil?.toISOString() ?? null)
      : null,
    ...todayDoseFields(resolved.get(e.id) ?? null, e.takenAt !== null),
  }));
}

/**
 * The resolved fields of a today row. A row the ledger places on no slot (an
 * ad-hoc take) reads `taken` with no window.
 */
function todayDoseFields(
  dose: Parameters<typeof serializeResolvedDose>[0] | null,
  taken: boolean,
) {
  if (dose) {
    const s = serializeResolvedDose(dose);
    return {
      state: s.state,
      slotInstant: s.slotInstant,
      dueAt: s.dueAt,
      overdueSince: s.overdueSince,
      missedAfter: s.missedAfter,
      lateTakeCounts: s.lateTakeCounts,
    };
  }
  return {
    state: taken ? ("taken" as const) : null,
    slotInstant: null,
    dueAt: null,
    overdueSince: null,
    missedAfter: null,
    lateTakeCounts: false,
  };
}
