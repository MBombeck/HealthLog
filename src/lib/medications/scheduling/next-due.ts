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
import {
  advanceRollingOccurrence,
  nextOccurrenceAfter,
  type CanonicalSchedule,
  type RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";
import { buildBandsForMedication } from "@/lib/medications/scheduling/band-minter";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";
import {
  ADHOC_RESOLVE_EPSILON_MS,
  anchorResolvesOccurrence,
  RESOLVE_RADIUS_MS,
} from "@/lib/medications/scheduling/slot-resolution";

/**
 * A row that resolves a slot (taken / deliberately skipped /
 * cron-auto-missed), with its anchoring shape preserved.
 *
 * `slotAnchored: false` marks the ad-hoc shape (`scheduledFor ===
 * takenAt`): such a row resolves a slot only on a near-exact anchor
 * match, never across the drift radius. Slot-anchored rows (the write
 * paths snap their `scheduledFor` to the canonical slot instant) keep
 * the drift radius, and within it resolve their nearest occurrence only
 * (`anchorResolvesOccurrence`).
 */
export interface ResolvedSlotMark {
  at: Date;
  slotAnchored: boolean;
  /** Canonical schedule owner when attribution could identify it. */
  scheduleId?: string;
  /** When the action was made; used to isolate replacement schedule eras. */
  actionAt?: Date;
  /** Diagnostic state carried by exact occurrence-aware callers. */
  status?: "taken" | "skipped" | "autoMissed";
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

/**
 * Predicate over the canonical occurrences of ONE schedule: true when a
 * resolved row stands for the occurrence at `slotAt`. Each row resolves
 * its nearest occurrence only, so a sibling slot closer than the drift
 * radius is never swallowed (see `slot-resolution.ts` for the rule).
 */
function buildIsResolved(
  resolved: ResolvedSlotMark[],
  identity: {
    schedule: CanonicalSchedule;
    ctx: RecurrenceContext;
    eraStart?: Date | null;
  },
): (slotAt: Date) => boolean {
  return (slotAt: Date): boolean => {
    for (const r of resolved) {
      if (r.scheduleId !== undefined && r.scheduleId !== identity.schedule.id) {
        continue;
      }
      if (
        identity.eraStart &&
        r.actionAt &&
        r.actionAt.getTime() < identity.eraStart.getTime()
      ) {
        continue;
      }
      const resolves = anchorResolvesOccurrence({
        anchor: r.at,
        occurrenceAt: slotAt,
        radiusMs: r.slotAnchored ? RESOLVE_RADIUS_MS : ADHOC_RESOLVE_EPSILON_MS,
        schedule: identity.schedule,
        ctx: identity.ctx,
      });
      if (resolves) return true;
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
  eraStart?: Date | null;
}): Date | null {
  return computeNextDueCandidate(input)?.at ?? null;
}

interface DueCandidate {
  at: Date;
  scheduleId: string;
}

function computeNextDueCandidate(input: {
  medication: WorkerMedicationRow;
  schedules: WorkerScheduleRow[];
  now: Date;
  userTz: string;
  lastIntakeAt: Date | null;
  resolvedSlots?: ResolvedSlotMark[];
  eraStart?: Date | null;
}): DueCandidate | null {
  const { medication, schedules, now, userTz, lastIntakeAt } = input;
  if (schedules.length === 0) return null;

  const ctx = buildRecurrenceContext({ medication, userTz, lastIntakeAt });
  let earliest: DueCandidate | null = null;
  for (const schedule of schedules) {
    const canonical = buildCanonicalSchedule(schedule);
    const isResolved = buildIsResolved(input.resolvedSlots ?? [], {
      schedule: canonical,
      ctx,
      eraStart: input.eraStart,
    });
    // Walk forward past slots the user has already resolved. Bounded so a
    // fully-logged-ahead history can't spin.
    let after = now;
    let next = nextOccurrenceAfter(canonical, after, ctx);
    for (let step = 0; step < 64; step++) {
      if (next === null) break;
      if (!isResolved(next.at)) {
        if (earliest === null || next.at.getTime() < earliest.at.getTime()) {
          earliest = { at: next.at, scheduleId: canonical.id };
        }
        break;
      }
      if (canonical.rollingIntervalDays !== null) {
        next = advanceRollingOccurrence(canonical, next, ctx);
        continue;
      }
      after = new Date(next.at.getTime());
      next = nextOccurrenceAfter(canonical, after, ctx);
    }
  }
  return earliest;
}

/** The instant a medication card should surface, plus its canonical band state. */
export interface DisplayDue {
  at: Date;
  /** Canonical owner of this occurrence (sibling schedules stay distinct). */
  scheduleId?: string;
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
  const next = computeNextDueCandidate(input);
  if (!next) return null;
  // A rolling occurrence whose actionable band has closed remains the same
  // unresolved identity until a real take re-anchors it. Do not relabel that
  // stale past occurrence as a non-overdue "next" dose.
  if (next.at.getTime() < input.now.getTime()) return null;
  return {
    at: next.at,
    scheduleId: next.scheduleId,
    availableFrom:
      findAvailabilityStart(input, next.at, next.scheduleId) ?? next.at,
    overdue: false,
  };
}

function findOpenOverdueSlot(
  input: ComputeDisplayDueInput,
): { at: Date; availableFrom: Date; scheduleId: string } | null {
  const { medication, schedules, now, userTz, lastIntakeAt } = input;
  if (schedules.length === 0) return null;

  let floor = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
  if (input.eraStart && input.eraStart.getTime() > floor.getTime()) {
    floor = input.eraStart;
  }
  if (floor.getTime() >= now.getTime()) return null;

  const ctx = buildRecurrenceContext({ medication, userTz, lastIntakeAt });
  const intakeInstants = lastIntakeAt ? [lastIntakeAt] : [];
  let latest: {
    at: Date;
    availableFrom: Date;
    scheduleId: string;
  } | null = null;
  for (const schedule of schedules) {
    const canonical = buildCanonicalSchedule(schedule);
    const isResolved = buildIsResolved(input.resolvedSlots ?? [], {
      schedule: canonical,
      ctx,
      eraStart: input.eraStart,
    });
    const { bands } = buildBandsForMedication({
      medication,
      schedule: canonical,
      ctx,
      userTz,
      range: { from: floor, to: now },
      now,
      intakeInstants,
      includeOpenRollingOccurrence: true,
    });
    // A rolling cadence's retrospective grid anchors an expected slot AT each
    // logged intake instant (`expandRollingRetrospective`), so every instant
    // fed in above comes back as a band. Such a band is served BY DEFINITION —
    // the take that minted it IS the action on it — but `isResolved` keys on
    // the row's `scheduledFor`, which for a late take is the SLOT anchor days
    // away from `takenAt`. The two coordinate systems never meet, so the band
    // read as an open overdue slot at exactly the instant the dose was taken
    // and the card told the user to take a weekly injection again. Drop the
    // self-minted anchors before the openness test; the genuine open
    // occurrence (`lastIntakeAt + N`, unioned in above) and any back-filled
    // missed cycle are untouched.
    const selfMinted =
      schedule.rollingIntervalDays !== null
        ? new Set(intakeInstants.map((instant) => instant.getTime()))
        : null;
    for (const band of bands) {
      const anchor = band.at.getTime();
      // Open overdue: the anchor has passed, now is still inside the
      // catch-up band, and no live intake row resolves the slot. An anchor
      // before the era floor is rejected explicitly — the minter works in
      // local-day granularity, so the range floor alone is not a guarantee.
      if (anchor < floor.getTime()) continue;
      if (anchor >= now.getTime()) continue;
      if (now.getTime() > band.overdueEnd.getTime()) continue;
      if (selfMinted?.has(anchor)) continue;
      if (isResolved(band.at)) continue;
      if (
        latest === null ||
        anchor > latest.at.getTime() ||
        (anchor === latest.at.getTime() &&
          band.earlyStart.getTime() < latest.availableFrom.getTime())
      ) {
        latest = {
          at: band.at,
          availableFrom: band.earlyStart,
          scheduleId: schedule.id,
        };
      }
    }
  }
  return latest;
}

function findAvailabilityStart(
  input: ComputeDisplayDueInput,
  at: Date,
  scheduleId?: string,
): Date | null {
  const ctx = buildRecurrenceContext({
    medication: input.medication,
    userTz: input.userTz,
    lastIntakeAt: input.lastIntakeAt,
  });
  const from = new Date(at.getTime() - OVERDUE_LOOKBACK_MS);
  let earliest: Date | null = null;

  for (const scheduleRow of input.schedules) {
    if (scheduleId !== undefined && scheduleRow.id !== scheduleId) continue;
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
