/**
 * Today's medication block for the dashboard hero + summary tally.
 *
 * `buildMedsTodayBlock` is the one shared builder behind every surface
 * that answers "how is the medication day going?":
 *
 *   1. **Projection** — `projectTodayIntakesAndRecompute` idempotently
 *      mints the day's pending `MedicationIntakeEvent` rows for active
 *      schedules (same helper the intake route + dashboard summary use),
 *      so the tally below never under-counts a daily med whose rows the
 *      reminder worker has not minted yet.
 *   2. **Tally** — one today-window event read produces
 *      `scheduledToday` / `takenToday` / `skippedToday` with the exact
 *      semantics the summary route's compliance tile always had
 *      (taken = `takenAt !== null && !skipped`; tombstones excluded).
 *   3. **Next due** — the same four feeder reads +
 *      `computeDisplayDue` loop the medications list route runs
 *      (`src/app/api/medications/route.ts`), restricted to ACTIVE
 *      medications: latest non-skipped intake per med (rolling cadences
 *      re-anchor on it), resolved slots over the overdue-lookback
 *      horizon, and the current-era floor per med. The block surfaces
 *      the EARLIEST display-due across medications — an open overdue
 *      slot sits in the past, so it naturally wins over any future slot.
 *
 * The feeder reads are not lifted out of the medications list route
 * because that route reuses the same rows for its own response fields
 * (`lastTakenAt`, `todayEventCount`, per-card next-due); the clean
 * shared seam is `computeDisplayDue` itself, which both call sites go
 * through.
 *
 * Consumer contract (snapshot caching): `nextDueAt` / `nextDueOverdue`
 * are computed at build time and may be served from a cache. A
 * `nextDueAt` in the past with `nextDueOverdue: false` means the slot's
 * anchor passed AFTER the block was built — render the plain day
 * summary, never an overdue state, until a fresh block arrives.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { projectTodayIntakesAndRecompute } from "@/lib/medications/scheduling/project-today-intakes";
import {
  computeDisplayDue,
  OVERDUE_LOOKBACK_MS,
  toResolvedSlotMark,
  type ResolvedSlotMark,
} from "@/lib/medications/scheduling/next-due";
import { getUserTodayBounds } from "@/lib/tz/local-day";

export interface MedsTodayDueCandidate {
  medicationId: string;
  medicationName: string;
  dueAt: string;
  overdue: boolean;
  /** Canonical attribution-band start for this slot (ISO8601). */
  availableFrom: string;
}

export interface MedsTodayBlock {
  /** Active medications (paused courses excluded). */
  activeCount: number;
  /** Intake-event rows scheduled in the user's local today (all states). */
  scheduledToday: number;
  /** Rows with `takenAt` set and not skipped. */
  takenToday: number;
  /** Rows the user deliberately skipped. */
  skippedToday: number;
  /**
   * Earliest display-due instant across active medications (ISO8601),
   * or null when nothing is due (no schedules, course ended, all PRN).
   * May lie outside today — the consumer gates on the local day.
   */
  nextDueAt: string | null;
  /**
   * True when `nextDueAt` is an OPEN overdue slot (anchor passed, still
   * inside its catch-up band, unresolved). A cached `nextDueAt` in the
   * past with `nextDueOverdue: false` must render as the plain summary,
   * never as overdue — see the module doc.
   */
  nextDueOverdue: boolean;
  /** Name of the medication carrying `nextDueAt`; null when none due. */
  nextDueMedicationName: string | null;
  /**
   * Id of the medication carrying `nextDueAt`; null when none due. Threaded
   * through so a consumer (the Today digest's dose-window rail item) can
   * deep-link straight to the overdue medication's card instead of the bare
   * list.
   */
  nextDueMedicationId: string | null;
  /**
   * Every active medication's current display-due candidate. Optional only so
   * older cached snapshots remain valid; the live builder always emits it.
   */
  dueCandidates?: MedsTodayDueCandidate[];
}

export async function buildMedsTodayBlock(
  prisma: PrismaClient,
  userId: string,
  userTz: string,
  now: Date,
): Promise<MedsTodayBlock> {
  const { start: todayStart, end: todayEnd } = getUserTodayBounds(now, userTz);
  // The projector + tally read use an exclusive upper bound (`lt`),
  // matching the summary route's window convention.
  const todayEndExclusive = new Date(
    todayStart.getTime() + 24 * 60 * 60 * 1000,
  );

  // Projection FIRST so the tally read below sees the freshly minted
  // pending rows. Idempotent — `skipDuplicates` + the
  // `(userId, medicationId, scheduledFor, source)` unique index make a
  // concurrent intake-route hit safe.
  await projectTodayIntakesAndRecompute({
    userId,
    userTz,
    todayStart,
    todayEnd: todayEndExclusive,
  });

  // Resolved-slot window — same horizon the medications list route uses:
  // back as far as the widest band tail (so a long-resolved past slot
  // cannot resurface as overdue), forward two days for the lookahead.
  const resolvedWindowStart = new Date(
    todayStart.getTime() - OVERDUE_LOOKBACK_MS,
  );
  const resolvedWindowEnd = new Date(
    todayEnd.getTime() + 2 * 24 * 60 * 60 * 1000,
  );

  const [medications, todayEvents, latestIntakes, resolvedEvents, eraFloors] =
    await Promise.all([
      prisma.medication.findMany({
        where: { userId, active: true },
        include: { schedules: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId,
          deletedAt: null,
          scheduledFor: { gte: todayStart, lt: todayEndExclusive },
        },
        select: { takenAt: true, skipped: true },
      }),
      prisma.medicationIntakeEvent.groupBy({
        by: ["medicationId"],
        where: {
          userId,
          deletedAt: null,
          skipped: false,
          takenAt: { not: null },
        },
        _max: { takenAt: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId,
          deletedAt: null,
          scheduledFor: { gte: resolvedWindowStart, lte: resolvedWindowEnd },
          OR: [
            { takenAt: { not: null } },
            { skipped: true },
            { autoMissed: true },
          ],
        },
        // v1.16.9 — `takenAt` rides along so an ad-hoc row (`scheduledFor
        // === takenAt`) cannot ±6h-resolve a different slot.
        select: { medicationId: true, scheduledFor: true, takenAt: true },
      }),
      // Current-era floor per medication: the newest revision's
      // `validUntil` is where the LIVE schedule rows became valid; the
      // open-overdue search must not reach past it into a previous
      // era's cadence.
      prisma.medicationScheduleRevision.groupBy({
        by: ["medicationId"],
        where: { medication: { userId }, supersededByRevisionId: null },
        _max: { validUntil: true },
      }),
    ]);

  const takenToday = todayEvents.filter(
    (e) => e.takenAt !== null && !e.skipped,
  ).length;
  const skippedToday = todayEvents.filter((e) => e.skipped).length;

  const lastTakenAtByMedId = new Map<string, Date | null>(
    latestIntakes.map((entry) => [entry.medicationId, entry._max.takenAt]),
  );
  const resolvedSlotsByMedId = new Map<string, ResolvedSlotMark[]>();
  for (const e of resolvedEvents) {
    const mark = toResolvedSlotMark(e);
    const list = resolvedSlotsByMedId.get(e.medicationId);
    if (list) list.push(mark);
    else resolvedSlotsByMedId.set(e.medicationId, [mark]);
  }
  const eraStartByMedId = new Map<string, Date>();
  for (const f of eraFloors) {
    if (f._max.validUntil)
      eraStartByMedId.set(f.medicationId, f._max.validUntil);
  }

  const dueCandidates: MedsTodayDueCandidate[] = [];
  for (const m of medications) {
    const display = computeDisplayDue({
      medication: {
        id: m.id,
        startsOn: m.startsOn,
        endsOn: m.endsOn,
        oneShot: m.oneShot,
        createdAt: m.createdAt,
      },
      schedules: m.schedules,
      now,
      userTz,
      lastIntakeAt: lastTakenAtByMedId.get(m.id) ?? null,
      resolvedSlots: resolvedSlotsByMedId.get(m.id) ?? [],
      eraStart: eraStartByMedId.get(m.id) ?? null,
    });
    if (!display) continue;
    dueCandidates.push({
      medicationId: m.id,
      medicationName: m.name,
      dueAt: display.at.toISOString(),
      overdue: display.overdue,
      availableFrom: (display.availableFrom ?? display.at).toISOString(),
    });
  }
  dueCandidates.sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      a.availableFrom.localeCompare(b.availableFrom) ||
      a.dueAt.localeCompare(b.dueAt) ||
      a.medicationId.localeCompare(b.medicationId),
  );
  const next = dueCandidates[0] ?? null;

  return {
    activeCount: medications.length,
    scheduledToday: todayEvents.length,
    takenToday,
    skippedToday,
    nextDueAt: next?.dueAt ?? null,
    nextDueOverdue: next?.overdue ?? false,
    nextDueMedicationName: next?.medicationName ?? null,
    nextDueMedicationId: next?.medicationId ?? null,
    dueCandidates,
  };
}
