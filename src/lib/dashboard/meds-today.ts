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
 *   3. **Next due** — every active medication's dose ledger, read in one
 *      batch (`dose-state/ledger.ts`), and its next dose by the dose
 *      resolver (`dose-state/resolve.ts`): the earliest open slot (`due` or
 *      `overdue`), else the earliest `pending` one. The same answer the
 *      today list and the card's current dose give. The block surfaces the
 *      earliest candidate, an overdue one first.
 *
 * Consumer contract (snapshot caching): `nextDueAt` / `nextDueOverdue`
 * are computed at build time and may be served from a cache. A
 * `nextDueAt` in the past with `nextDueOverdue: false` means the slot's
 * anchor passed AFTER the block was built — render the plain day
 * summary, never an overdue state, until a fresh block arrives.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { projectTodayIntakesAndRecompute } from "@/lib/medications/scheduling/project-today-intakes";
import {
  computeNextDueAt,
  OVERDUE_LOOKBACK_MS,
} from "@/lib/medications/scheduling/next-due";
import {
  DOSE_LEDGER_MEDICATION_INCLUDE,
  loadDoseLedgers,
  type DoseLedgerMedication,
} from "@/lib/medications/dose-state/ledger";
import {
  resolveDoseState,
  resolveLedgerSlot,
  type ResolvedDose,
} from "@/lib/medications/dose-state/resolve";
import {
  defaultDoseBand,
  doseCadenceFamily,
} from "@/lib/analytics/compliance/dose-status";
import { medicationWindow } from "@/lib/medications/course-window";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import { buildCanonicalSchedule } from "@/lib/medications/scheduling/worker-helpers";
import type { WorkerScheduleRow } from "@/lib/medications/scheduling/worker-helpers";
import { formatInUserTz } from "@/lib/tz/format";
import { getUserTodayBounds, localHmAsUtc } from "@/lib/tz/local-day";
import {
  dueSchedules,
  TRACKED_INTAKE_EVENT_WHERE,
  TRACKED_INTAKE_WHERE,
} from "@/lib/medications/intake-tracking";

export interface MedsTodayDueCandidate {
  medicationId: string;
  medicationName: string;
  dueAt: string;
  overdue: boolean;
  /** When the dose turns due by the resolver: its `dueAt` (ISO8601). */
  availableFrom: string;
  /**
   * When the dose's own window opens (ISO8601): the start of an explicit
   * per-dose window, else the slot instant itself. What "next dose at" names.
   * Optional only so older cached snapshots remain valid.
   */
  opensAt?: string;
}

/**
 * Which of today's intake rows are scheduled doses of the day, as one filter
 * on the tally read. Only tracked medications (#1033). An as-needed
 * medication schedules nothing, so its intakes (ad-hoc rows, `scheduledFor
 * === takenAt`) are not part of the day's total. A still-pending placeholder
 * of a medication paused since it was minted is no longer expected; an
 * actioned row of it is history and stays. (Ending a course tombstones the
 * placeholders after its moment, so `deletedAt` already takes those.)
 */
const SCHEDULED_DOSE_TODAY_WHERE = {
  medication: { ...TRACKED_INTAKE_EVENT_WHERE.medication, asNeeded: false },
  AND: [
    {
      OR: [
        { takenAt: { not: null } },
        { skipped: true },
        { autoMissed: true },
        { medication: { active: true } },
      ],
    },
  ],
} satisfies Prisma.MedicationIntakeEventWhereInput;

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
   * The slot instants (ISO8601, ascending) of the rows `scheduledToday`
   * counts. Kept as instants rather than a "due so far" flag so a cached
   * snapshot still answers correctly later in the day: the Today fact checks
   * them against its own `now` to tell whether any dose was due yet (#173).
   * Optional only so snapshots cached before it stay valid; the live builder
   * always emits it.
   */
  scheduledTodayAt?: string[];
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
  // matching the summary route's window convention. `todayEnd` is the
  // inclusive last millisecond of the real local day, so +1 ms is the next
  // day's start: 23 or 25 hours on a DST day, where a fixed 24 h missed the
  // last hour of the 25-hour day.
  const todayEndExclusive = new Date(todayEnd.getTime() + 1);

  // Projection FIRST so the tally read below sees the freshly minted
  // pending rows. Idempotent — `skipDuplicates` + the
  // `(userId, medicationId, scheduledFor, source)` unique index make a
  // concurrent intake-route hit safe.
  const { slotKeys } = await projectTodayIntakesAndRecompute({
    userId,
    userTz,
    todayStart,
    todayEnd: todayEndExclusive,
  });

  // The ledger window: back as far as the widest band tail (so a
  // long-resolved past slot cannot resurface as open), forward two days for
  // the lookahead.
  const ledgerFrom = new Date(todayStart.getTime() - OVERDUE_LOOKBACK_MS);
  const ledgerTo = new Date(todayEnd.getTime() + 2 * 24 * 60 * 60 * 1000);

  const [medications, todayEvents] = await Promise.all([
    // v1.39.1 (#1033) — a medication with intake tracking off has no
    // place on the doses card: not counted, never the next due dose.
    prisma.medication.findMany({
      where: { userId, active: true, ...TRACKED_INTAKE_WHERE },
      include: DOSE_LEDGER_MEDICATION_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        deletedAt: null,
        scheduledFor: { gte: todayStart, lt: todayEndExclusive },
        ...SCHEDULED_DOSE_TODAY_WHERE,
      },
      select: {
        medicationId: true,
        takenAt: true,
        skipped: true,
        scheduledFor: true,
      },
    }),
  ]);

  // The day's scheduled doses only: an ad-hoc take (stored on its own
  // instant, `scheduledFor = takenAt`, as an extra dose or one before its
  // slot's window) is not one of them, so "1 of 2" for a once-daily
  // medication can no longer happen. A row on a slot of today's schedule
  // counts whatever its stored instants say.
  const slotEvents = todayEvents.filter(
    (e) =>
      slotKeys.has(`${e.medicationId}|${e.scheduledFor.toISOString()}`) ||
      e.takenAt === null ||
      e.takenAt.getTime() !== e.scheduledFor.getTime(),
  );
  const takenToday = slotEvents.filter(
    (e) => e.takenAt !== null && !e.skipped,
  ).length;
  const skippedToday = slotEvents.filter((e) => e.skipped).length;

  // The next dose of each medication, from its dose ledger and the dose
  // resolver: the one answer the today list, the card's current dose and
  // every device read. The tile used to run a due computation of its own
  // (a radius match over resolved slots), which could call a dose pinned or
  // recorded early "overdue" while the list said "taken".
  const ledgers = await loadDoseLedgers({
    userId,
    userTz,
    now,
    ledgers: medications.map((medication) => ({
      medication,
      from: ledgerFrom,
      to: ledgerTo,
    })),
  });

  const dueCandidates: MedsTodayDueCandidate[] = [];
  for (const m of medications) {
    const ledger = ledgers.get(m.id);
    const dose =
      nextDoseOf(ledger?.rows ?? [], now) ??
      unmintedNextDose(m, ledger?.lastIntakeAt ?? null, userTz, now);
    if (!dose) continue;
    dueCandidates.push({
      medicationId: m.id,
      medicationName: m.name,
      dueAt: dose.slotInstant.toISOString(),
      overdue: dose.state === "overdue",
      availableFrom: dose.dueAt.toISOString(),
      opensAt: doseWindowOpening(
        m.schedules,
        dose.timeOfDay,
        dose.slotInstant,
        userTz,
      ).toISOString(),
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
    scheduledToday: slotEvents.length,
    takenToday,
    skippedToday,
    scheduledTodayAt: slotEvents
      .map((e) => e.scheduledFor.toISOString())
      .sort(),
    nextDueAt: next?.dueAt ?? null,
    nextDueOverdue: next?.overdue ?? false,
    nextDueMedicationName: next?.medicationName ?? null,
    nextDueMedicationId: next?.medicationId ?? null,
    dueCandidates,
  };
}

/**
 * When the dose at `at` can first be taken on the person's clock, as they
 * set it: the start of the schedule's explicit window for that time of day
 * (a 17:00 dose with a 12:00 to 22:00 window opens at 12:00), else the slot
 * instant itself. The engine's band start reaches an early grace further
 * back, which is right for crediting a take but not what a person reads as
 * the time of their dose.
 */
function doseWindowOpening(
  schedules: readonly WorkerScheduleRow[],
  timeOfDay: string | null,
  at: Date,
  userTz: string,
): Date {
  const wallClock = timeOfDay ?? formatInUserTz(at, userTz, "wall-clock");
  for (const schedule of schedules) {
    const windows = buildCanonicalSchedule(schedule).doseWindows ?? [];
    const entry = windows.find((w) => w.timeOfDay === wallClock);
    if (!entry) continue;
    const [hour, minute] = entry.start.split(":").map(Number);
    const opens = localHmAsUtc(at, userTz, hour, minute);
    return opens.getTime() < at.getTime() ? opens : at;
  }
  return at;
}

/**
 * The next dose of a medication whose ledger holds no open or pending slot:
 * a rolling cadence's next occurrence, which the retrospective ledger does
 * not mint until it is taken. Resolved on the default band for its cadence,
 * the rule `complianceDisplay.currentDose` applies to the same dose.
 */
function unmintedNextDose(
  m: DoseLedgerMedication,
  lastIntakeAt: Date | null,
  userTz: string,
  now: Date,
): (ResolvedDose & { timeOfDay: string | null }) | null {
  const schedules = dueSchedules(m).filter((s) => s.scheduleType !== "PRN");
  if (schedules.length === 0) return null;
  const at = computeNextDueAt({
    medication: {
      id: m.id,
      ...medicationWindow(m),
      oneShot: m.oneShot,
      createdAt: m.createdAt,
    },
    schedules,
    now,
    userTz,
    lastIntakeAt,
  });
  if (!at) return null;
  const resolved = resolveDoseState(
    defaultDoseBand(at, doseCadenceFamily(schedules[0])),
    null,
    now,
  );
  if (!["pending", "due", "overdue"].includes(resolved.state)) return null;
  return { ...resolved, timeOfDay: null };
}

/**
 * A medication's next dose by the resolver: its earliest open slot (`due`
 * or `overdue`), else its earliest slot still `pending`. A slot already
 * answered, or past its miss cutoff, is nobody's next dose.
 */
function nextDoseOf(
  rows: readonly DoseHistoryRow[],
  now: Date,
): (ResolvedDose & { timeOfDay: string | null }) | null {
  let open: (ResolvedDose & { timeOfDay: string | null }) | null = null;
  let pending: (ResolvedDose & { timeOfDay: string | null }) | null = null;
  for (const row of rows) {
    const resolved = resolveLedgerSlot(row, now);
    if (!resolved) continue;
    const dose = { ...resolved, timeOfDay: row.timeOfDay };
    const t = resolved.slotInstant.getTime();
    if (resolved.state === "due" || resolved.state === "overdue") {
      if (!open || t < open.slotInstant.getTime()) open = dose;
    } else if (resolved.state === "pending") {
      if (!pending || t < pending.slotInstant.getTime()) pending = dose;
    }
  }
  return open ?? pending;
}
