/**
 * Shared cached medications-list read for the two entry points:
 *
 *   - `GET /api/medications` (the client cell's endpoint), and
 *   - the medications RSC wrapper (`src/app/medications/page.tsx`), which
 *     server-prefetches the same payload into a dehydrated TanStack cache so
 *     the first HTML paints the medication cards instead of skeletons-until-JS.
 *
 * Both read through the SAME `caches.medications` SWR cell (keyed on
 * `userId`), so an RSC prefetch warms the API path and vice versa — the
 * builder never runs twice for one user within the 60 s fresh TTL, and the
 * write-invalidation semantics (`invalidateUserMedications`) cover both
 * readers. Mirrors `src/lib/dashboard/snapshot-read.ts` for the dashboard.
 */
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { getMedicationCategories } from "@/lib/medication-category";
import {
  effectiveUnitsPerDose,
  estimateUnitsRunwayDays,
} from "@/components/medications/detail/supply-runway";
import { serializeScheduleUnitsPerDose } from "@/lib/medications/schedule-units-dto";
import {
  computeDisplayDue,
  OVERDUE_LOOKBACK_MS,
  toResolvedSlotMark,
  type ResolvedSlotMark,
} from "@/lib/medications/scheduling/next-due";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  dueSchedules,
  isRecordOnly,
  scheduleWireFields,
} from "@/lib/medications/intake-tracking";
import { liveEraStartsByMedication } from "@/lib/medications/scheduling/live-era";

export type MedicationsListResult = Array<Record<string, unknown>>;

export async function buildMedicationsList(
  userId: string,
  userTz: string,
): Promise<MedicationsListResult> {
  const { start: todayStartUtc, end: todayEndUtc } = getUserTodayBounds(
    new Date(),
    userTz,
  );

  // v1.15.10 — the slots the user has already acted on near "now", so the
  // next-due search can skip them. A resolved slot is a taken, deliberately
  // skipped, or cron-auto-missed row. Bound the window to [today-start,
  // today-end + 2d] — the next-due lookahead only needs the slots adjacent to
  // now, and a tight window keeps the read cheap. The 60s list cache covers
  // the rest.
  const resolvedWindowEnd = new Date(
    todayEndUtc.getTime() + 2 * 24 * 60 * 60 * 1000,
  );
  // v1.16.4 — the open-overdue search reaches back as far as the widest
  // band tail (weekly on-time + overdue), so the resolved-slot read must
  // cover the same horizon or a long-resolved past slot would resurface
  // as "overdue".
  const resolvedWindowStart = new Date(
    todayStartUtc.getTime() - OVERDUE_LOOKBACK_MS,
  );

  const [
    medications,
    latestIntakes,
    todayEvents,
    resolvedEvents,
    eraFloors,
    usableStock,
    inventoryCounts,
  ] = await Promise.all([
    prisma.medication.findMany({
      where: { userId },
      include: { schedules: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.medicationIntakeEvent.groupBy({
      by: ["medicationId"],
      // v1.7.0 sync — exclude tombstoned rows from the last-taken map.
      where: {
        userId,
        deletedAt: null,
        skipped: false,
        takenAt: { not: null },
      },
      _max: { takenAt: true },
    }),
    prisma.medicationIntakeEvent.groupBy({
      by: ["medicationId"],
      // v1.7.0 sync — exclude tombstoned rows from the today-count map.
      // v1.16.9 — count only ACTIONED rows (taken or skipped). The
      // dashboard projector mints pending rows for every slot of the
      // day, so counting all rows made `todayEventCount` cover every
      // passed dose after any dashboard visit — and the cards'
      // overdue-pill suppression (`todayEventCount < passedDoseCount`)
      // went dark nondeterministically for genuinely overdue doses.
      where: {
        userId,
        deletedAt: null,
        scheduledFor: { gte: todayStartUtc, lte: todayEndUtc },
        OR: [{ takenAt: { not: null } }, { skipped: true }],
      },
      _count: { id: true },
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
      // v1.16.9 — `takenAt` rides along so the ad-hoc shape
      // (`scheduledFor === takenAt`) is detectable: such a row must not
      // ±6h-resolve a DIFFERENT slot (a 14:30 ad-hoc take hid tonight's
      // genuinely-due 20:00 dose).
      select: { medicationId: true, scheduledFor: true, takenAt: true },
    }),
    // v1.16.4 — current-era floor per medication: the newest revision's
    // `validUntil` is where the LIVE schedule rows became valid. The
    // open-overdue search mints from the live rows, so it must not reach
    // past this boundary into a previous era's cadence.
    prisma.medicationScheduleRevision.groupBy({
      by: ["medicationId"],
      // Superseded rows are audit records — a correction may have
      // shortened the era, so the boundary reads only active rows.
      where: { medication: { userId }, supersededByRevisionId: null },
      _max: { validUntil: true },
    }),
    // v1.16.10 — usable stock per medication (one batched aggregate,
    // not per-row): the sum of `unitsRemaining` over ACTIVE / IN_USE
    // containers with units left — the same usable-container filter
    // the GLP-1 details endpoint applies. Feeds the list payload's
    // `stockUnitsRemaining` / `stockDosesRemaining` for the table view.
    prisma.medicationInventoryItem.groupBy({
      by: ["medicationId"],
      where: {
        userId,
        state: { in: ["ACTIVE", "IN_USE"] },
        unitsRemaining: { gt: 0 },
      },
      _sum: { unitsRemaining: true },
    }),
    // …and the any-state item count, so a medication whose containers
    // are all used up / expired reads as stock 0 (tracking is ON, the
    // supply ran out) instead of null (tracking off).
    prisma.medicationInventoryItem.groupBy({
      by: ["medicationId"],
      where: { userId },
      _count: { id: true },
    }),
  ]);

  const resolvedSlotsByMedId = new Map<string, ResolvedSlotMark[]>();
  for (const e of resolvedEvents) {
    const mark = toResolvedSlotMark(e);
    const list = resolvedSlotsByMedId.get(e.medicationId);
    if (list) list.push(mark);
    else resolvedSlotsByMedId.set(e.medicationId, [mark]);
  }

  // The live era start per medication (see `live-era.ts`).
  const eraStartByMedId = liveEraStartsByMedication(eraFloors);

  const lastTakenAtByMedicationId = Object.fromEntries(
    latestIntakes.map((entry) => [
      entry.medicationId,
      entry._max.takenAt ? entry._max.takenAt.toISOString() : null,
    ]),
  );
  // v1.7.0 SB-SCHED-3 — Date-typed last-intake map for the engine
  // (rolling cadences re-anchor on it). Same groupBy as the ISO map.
  const lastTakenAtDateByMedicationId = Object.fromEntries(
    latestIntakes.map((entry) => [entry.medicationId, entry._max.takenAt]),
  );
  const todayEventCountByMedId = Object.fromEntries(
    todayEvents.map(
      (entry: { medicationId: string; _count: { id: number } }) => [
        entry.medicationId,
        entry._count.id,
      ],
    ),
  );

  const usableUnitsByMedId = new Map<string, number>();
  for (const entry of usableStock) {
    usableUnitsByMedId.set(
      entry.medicationId,
      Number(entry._sum.unitsRemaining ?? 0),
    );
  }
  const trackedMedIds = new Set(inventoryCounts.map((e) => e.medicationId));

  let categoryMap: Record<string, string> = {};
  try {
    categoryMap = await getMedicationCategories(medications.map((m) => m.id));
  } catch {
    getEvent()?.addWarning("Medication categories could not be loaded");
  }

  // v1.7.0 SB-SCHED-3 — server-computed next due instant. Time-derived;
  // the list GET is cached 60 s on userId, so a 60 s staleness window is
  // accepted here as it already is for `todayEventCount`.
  const now = new Date();

  return medications.map((m) => {
    // v1.39.1 (#1033) — intake tracking off: the stored rows are a record,
    // not a dose plan. Nothing is due and no runway derives from them.
    const liveSchedules = dueSchedules(m);
    // v1.16.4 — an OPEN overdue slot (anchor passed, still inside its
    // catch-up band, unresolved) surfaces FIRST with `nextDueOverdue:
    // true`; only a closed or resolved band falls through to the future
    // next-due. Keeps the card on the still-takeable dose instead of
    // jumping ahead the minute the anchor passes.
    const display = computeDisplayDue({
      medication: {
        id: m.id,
        startsOn: m.startsOn,
        endsOn: m.endsOn,
        oneShot: m.oneShot,
        createdAt: m.createdAt,
      },
      schedules: liveSchedules,
      now,
      userTz,
      lastIntakeAt: lastTakenAtDateByMedicationId[m.id] ?? null,
      resolvedSlots: resolvedSlotsByMedId.get(m.id) ?? [],
      eraStart: eraStartByMedId.get(m.id) ?? null,
    });
    const displaySchedule =
      display?.scheduleId === undefined
        ? null
        : (liveSchedules.find(
            (schedule) => schedule.id === display.scheduleId,
          ) ?? null);
    // A prior-day rolling occurrence can remain the one authoritative
    // actionable dose while today's same HH:mm window has already passed.
    // The client window reducer uses this count to decide whether a passed
    // local clock window is uncovered. Account for exactly that one rolling
    // window here so GLP-1/take-all keep the server's prior scheduledFor
    // instead of rebinding it onto today's date. Other sibling windows remain
    // uncovered because the adjustment is only +1.
    const carriesPriorRollingOccurrence =
      display?.overdue === true &&
      display.at.getTime() < todayStartUtc.getTime() &&
      displaySchedule?.rollingIntervalDays !== null &&
      displaySchedule?.rollingIntervalDays !== undefined;
    // v1.16.10 — dose-derived stock for the table view. NULL when the
    // medication has no inventory items at all (tracking off); 0 when
    // tracking is on but every container is used up / expired.
    const tracksInventory = trackedMedIds.has(m.id);
    const stockUnitsRemaining = tracksInventory
      ? (usableUnitsByMedId.get(m.id) ?? 0)
      : null;
    // #219 / iOS #25 — schedules on the wire carry both the raw nullable
    // per-slot units AND the server-resolved effective value.
    const schedulesDto = serializeScheduleUnitsPerDose(
      m.schedules,
      m.unitsPerDose,
    );
    const liveSchedulesDto = isRecordOnly(m) ? [] : schedulesDto;
    // v1.37.19 — slot-aware doses figure: divide the units pool by the
    // schedule-weighted average units per dose, not the medication-level
    // column alone (wrong for any per-slot medication). Falls back to the
    // medication level when no schedule derives a consumption rate.
    const stockDosesRemaining =
      stockUnitsRemaining === null
        ? null
        : Math.floor(
            stockUnitsRemaining /
              effectiveUnitsPerDose(schedulesDto, Number(m.unitsPerDose)),
          );
    // v1.37.19 — projected runway in whole days on the wire (the low-stock
    // engine's burn-rate math, slot-aware). NULL when inventory tracking is
    // off or no schedule derives a consumption rate; 0 when the supply ran
    // out. Published resolved so no client re-derives the cadence math.
    const runwayDays =
      stockUnitsRemaining === null
        ? null
        : estimateUnitsRunwayDays(
            stockUnitsRemaining,
            liveSchedulesDto,
            Number(m.unitsPerDose),
          );
    return {
      ...m,
      // v1.16.12 — Decimal → number so the wire stays a JSON number, not
      // the string Prisma would otherwise serialise a Decimal to.
      unitsPerDose: Number(m.unitsPerDose),
      // #219 — same Decimal → number unwrap for the per-schedule column.
      // v1.39.1 (#1033) — `schedules: []` plus `recordedSchedules` when
      // intake tracking is off (see `scheduleWireFields`).
      ...scheduleWireFields(m.trackIntake, schedulesDto),
      category: categoryMap[m.id] ?? "OTHER",
      // v1.32.25 — provenance echo. Surfacing the mirror source lets the
      // web UI and an operator tell an externally-mirrored row (today only
      // Apple Health) from a native HealthLog medication. NULL for a native
      // medication.
      externalSource: m.externalSource ?? null,
      lastTakenAt: lastTakenAtByMedicationId[m.id] ?? null,
      todayEventCount:
        (todayEventCountByMedId[m.id] ?? 0) +
        (carriesPriorRollingOccurrence ? 1 : 0),
      nextDueAt: display ? display.at.toISOString() : null,
      nextDueOverdue: display?.overdue ?? false,
      nextDueScheduleId: display?.scheduleId ?? null,
      stockUnitsRemaining,
      stockDosesRemaining,
      runwayDays,
    };
  });
}

/**
 * Resolve + read the medications list through the SWR cache for an already
 * authenticated user row. Shared by the API route and the RSC prefetch; the
 * `User` row is in hand at both call sites, so there is no extra round-trip.
 */
export async function readMedicationsListCached(user: {
  id: string;
  timezone: string | null;
}): Promise<MedicationsListResult> {
  const userTz = user.timezone || "Europe/Berlin";
  return cachedSwr(
    caches.medications as ServerCache<MedicationsListResult>,
    user.id,
    () => buildMedicationsList(user.id, userTz),
    annotate,
  );
}
