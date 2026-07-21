/**
 * v1.7.0 SB-SCHED-3 — server-computed `nextDueAt`.
 *
 * Stops the iOS client re-implementing the recurrence engine: the
 * server computes the next due instant per medication by asking the
 * canonical engine (`nextOccurrenceAfter`) for each schedule and taking
 * the earliest. Pure / synchronous — the caller fetches `lastIntakeAt`
 * (rolling cadences re-anchor on it) and the user timezone.
 *
 * Returns null when no schedule has an upcoming slot (paused course,
 * one-shot already in the past, `endsOn` crossed, every schedule PRN).
 */
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  type WorkerMedicationRow,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { nextOccurrenceAfter } from "@/lib/medications/scheduling/recurrence";
import { buildBandsForMedication } from "@/lib/medications/scheduling/band-minter";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";

/**
 * v1.15.10 — radius an intake may sit from a slot's canonical instant and
 * still count as resolving it. Intake writes snap `scheduledFor` to the exact
 * engine slot instant, so the match is normally exact; the ±6h tolerance is
 * the same defensive half-gap the compliance open-dose search uses (a 12h-gap
 * twice-daily med splits cleanly at ±6h).
 */
const RESOLVE_RADIUS_MS = 6 * 60 * 60 * 1000;

/**
 * v1.16.9 — exact-match slop for an AD-HOC row. An ad-hoc take anchors
 * `scheduledFor = takenAt` on its own instant, so it can only resolve a
 * slot it actually sits on (sub-minute drift absorbed); letting it use
 * the ±6h radius hid genuinely-due slots — a 14:30 ad-hoc take resolved
 * tonight's 20:00 dose while the ledger still counted that slot missed.
 */
const ADHOC_RESOLVE_EPSILON_MS = 60 * 1000;

/**
 * A row that resolves a slot (taken / deliberately skipped /
 * cron-auto-missed), with its anchoring shape preserved.
 *
 * `slotAnchored: false` marks the ad-hoc shape (`scheduledFor ===
 * takenAt`): such a row resolves a slot only on a near-exact anchor
 * match, never across the ±6h radius. Slot-anchored rows (the write
 * paths snap their `scheduledFor` to the canonical slot instant) keep
 * the defensive radius.
 */
export interface ResolvedSlotMark {
  at: Date;
  slotAnchored: boolean;
}

/**
 * Map a resolved intake row to its `ResolvedSlotMark`. The ad-hoc shape
 * is detectable only for taken rows (`scheduledFor === takenAt` to the
 * millisecond — the documented standalone-insert contract); skips and
 * auto-misses anchor on their slot by construction.
 */
export function toResolvedSlotMark(row: {
  scheduledFor: Date;
  takenAt: Date | null;
}): ResolvedSlotMark {
  return {
    at: row.scheduledFor,
    slotAnchored:
      row.takenAt === null ||
      row.takenAt.getTime() !== row.scheduledFor.getTime(),
  };
}

function buildIsResolved(
  resolved: ResolvedSlotMark[],
): (slotAt: Date) => boolean {
  return (slotAt: Date): boolean => {
    const slot = slotAt.getTime();
    for (const r of resolved) {
      const radius = r.slotAnchored
        ? RESOLVE_RADIUS_MS
        : ADHOC_RESOLVE_EPSILON_MS;
      if (Math.abs(r.at.getTime() - slot) <= radius) return true;
    }
    return false;
  };
}

/**
 * v1.16.4 — how far back the open-overdue search mints bands. The widest
 * possible band reach is a weekly slot's on-time half-width plus its
 * overdue tail (1 + 4 days); one spare day absorbs DST / timezone skew.
 * Exported so the list route can widen its resolved-slot read to the
 * same horizon.
 */
export const OVERDUE_LOOKBACK_MS =
  (DOSE_WINDOW_DEFAULTS.weeklyOnTimeDays +
    DOSE_WINDOW_DEFAULTS.weeklyOverdueDays +
    1) *
  24 *
  60 *
  60 *
  1000;

export function computeNextDueAt(input: {
  medication: WorkerMedicationRow;
  schedules: WorkerScheduleRow[];
  now: Date;
  userTz: string;
  lastIntakeAt: Date | null;
  /**
   * v1.15.10 — slot instants the user has already acted on (taken / skipped /
   * auto-missed). The next-due search skips any occurrence that matches one of
   * these so a twice-daily med whose remaining slots today are all logged
   * advances to the next genuinely-open slot (tomorrow's first dose) instead
   * of re-surfacing a resolved present/past slot. Omit for the legacy
   * purely-time-anchored next-due. v1.16.9 — each mark carries its
   * anchoring shape; ad-hoc rows only resolve on a near-exact match.
   */
  resolvedSlots?: ResolvedSlotMark[];
}): Date | null {
  const { medication, schedules, now, userTz, lastIntakeAt } = input;
  if (schedules.length === 0) return null;

  const isResolved = buildIsResolved(input.resolvedSlots ?? []);

  const ctx = buildRecurrenceContext({ medication, userTz, lastIntakeAt });
  let earliest: Date | null = null;
  for (const schedule of schedules) {
    const canonical = buildCanonicalSchedule(schedule);
    // Walk forward past slots the user has already resolved. Bounded so a
    // fully-logged-ahead history can't spin.
    let after = now;
    for (let step = 0; step < 64; step++) {
      const next = nextOccurrenceAfter(canonical, after, ctx);
      if (next === null) break;
      if (!isResolved(next.at)) {
        if (earliest === null || next.at.getTime() < earliest.getTime()) {
          earliest = next.at;
        }
        break;
      }
      after = new Date(next.at.getTime());
    }
  }
  return earliest;
}

/** The instant a medication card should surface, plus its canonical band state. */
export interface DisplayDue {
  at: Date;
  /**
   * Earliest instant at which the canonical attribution band accepts this
   * slot. This is cadence- and per-dose-window-aware.
   */
  availableFrom?: Date;
  /**
   * True when `at` is an OPEN overdue slot: its anchor has passed but `now`
   * is still inside the slot's catch-up band (`anchor < now ≤ overdueEnd`)
   * and the user has not acted on it. The card renders this slot as
   * "overdue — still takeable" instead of jumping to the next future slot.
   */
  overdue: boolean;
}

export interface ComputeDisplayDueInput {
  medication: WorkerMedicationRow;
  schedules: WorkerScheduleRow[];
  now: Date;
  userTz: string;
  lastIntakeAt: Date | null;
  resolvedSlots?: ResolvedSlotMark[];
  /**
   * Floor of the CURRENT schedule era (the newest revision's `validUntil`),
   * when the medication has archived revisions. The overdue search mints
   * bands from the LIVE schedule rows only, so it must not reach back past
   * the era boundary — a pre-edit slot belongs to the old era's cadence and
   * must not be re-minted at the new times.
   */
  eraStart?: Date | null;
}

/**
 * v1.16.4 — the display-due resolution for the medication list cards.
 *
 * `computeNextDueAt` walks strictly forward from `now`, so the moment a
 * slot's anchor passed the card jumped to the NEXT slot — even while the
 * dose was still takeable inside its catch-up band. This wrapper first
 * searches the current era for an open overdue slot (band model:
 * `anchor < now ≤ overdueEnd`, no taken / skipped / auto-missed row on the
 * anchor) and surfaces it with `overdue: true`; only when every passed
 * band is closed or resolved does it fall through to the future next-due.
 */
export function computeDisplayDue(
  input: ComputeDisplayDueInput,
): DisplayDue | null {
  const open = findOpenOverdueSlot(input);
  if (open) return { ...open, overdue: true };
  const next = computeNextDueAt(input);
  if (!next) return null;
  return {
    at: next,
    availableFrom: findAvailabilityStart(input, next) ?? next,
    overdue: false,
  };
}

function findOpenOverdueSlot(
  input: ComputeDisplayDueInput,
): { at: Date; availableFrom: Date } | null {
  const { medication, schedules, now, userTz, lastIntakeAt } = input;
  if (schedules.length === 0) return null;

  const isResolved = buildIsResolved(input.resolvedSlots ?? []);

  let floor = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
  if (input.eraStart && input.eraStart.getTime() > floor.getTime()) {
    floor = input.eraStart;
  }
  if (floor.getTime() >= now.getTime()) return null;

  const ctx = buildRecurrenceContext({ medication, userTz, lastIntakeAt });
  let latest: { at: Date; availableFrom: Date } | null = null;
  for (const schedule of schedules) {
    const { bands } = buildBandsForMedication({
      medication,
      schedule: buildCanonicalSchedule(schedule),
      ctx,
      userTz,
      range: { from: floor, to: now },
      now,
      intakeInstants: lastIntakeAt ? [lastIntakeAt] : [],
    });
    for (const band of bands) {
      const anchor = band.at.getTime();
      // Open overdue: the anchor has passed, now is still inside the
      // catch-up band, and no live intake row resolves the slot. An anchor
      // before the era floor is rejected explicitly — the minter works in
      // local-day granularity, so the range floor alone is not a guarantee.
      if (anchor < floor.getTime()) continue;
      if (anchor >= now.getTime()) continue;
      if (now.getTime() > band.overdueEnd.getTime()) continue;
      if (isResolved(band.at)) continue;
      if (
        latest === null ||
        anchor > latest.at.getTime() ||
        (anchor === latest.at.getTime() &&
          band.earlyStart.getTime() < latest.availableFrom.getTime())
      ) {
        latest = { at: band.at, availableFrom: band.earlyStart };
      }
    }
  }
  return latest;
}

function findAvailabilityStart(
  input: ComputeDisplayDueInput,
  at: Date,
): Date | null {
  const ctx = buildRecurrenceContext({
    medication: input.medication,
    userTz: input.userTz,
    lastIntakeAt: input.lastIntakeAt,
  });
  const from = new Date(at.getTime() - OVERDUE_LOOKBACK_MS);
  let earliest: Date | null = null;

  for (const scheduleRow of input.schedules) {
    const schedule = buildCanonicalSchedule(scheduleRow);
    const intakeInstants =
      schedule.rollingIntervalDays === null
        ? input.lastIntakeAt
          ? [input.lastIntakeAt]
          : []
        : [input.lastIntakeAt, at].filter(
            (instant): instant is Date => instant !== null,
          );
    const { bands } = buildBandsForMedication({
      medication: input.medication,
      schedule,
      ctx,
      userTz: input.userTz,
      range: { from, to: at },
      now: input.now,
      intakeInstants,
    });
    for (const band of bands) {
      if (band.at.getTime() !== at.getTime()) continue;
      if (earliest === null || band.earlyStart.getTime() < earliest.getTime()) {
        earliest = band.earlyStart;
      }
    }
  }

  return earliest;
}
