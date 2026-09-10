// Extracted from the former single-file `compliance.ts`. See `../compliance.ts`
// (the barrel) for the module map. Pure move — no logic changes.

import {
  nextOccurrenceAfter,
  type CanonicalSchedule,
  type Occurrence,
  type RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";
import {
  ADHOC_RESOLVE_EPSILON_MS,
  anchorResolvesOccurrence,
  RESOLVE_RADIUS_MS,
} from "@/lib/medications/scheduling/slot-resolution";
import {
  lastNonSkippedTakenAt,
  type ComplianceIntakeInstant,
  type ComplianceMedicationContext,
  type ComplianceSchedule,
} from "./types";
import { toCanonicalSchedule, toRecurrenceCtx } from "./adapters";

/**
 * v1.13.x Fix 4 — the current-cycle descriptor. SEPARATE from the
 * percentage rows: a sparse med (weekly+ injection) whose current cycle is
 * not yet due must NOT render a scary red 0%. The percentage rows reflect
 * only CLOSED cycles (the open forward cycle is `upcoming`, excluded from
 * the denominator); this descriptor carries the open-cycle state so the
 * card can render a neutral "next dose in N days" / "due today" / "overdue"
 * line decoupled from the rate.
 *
 * States:
 *   - `on_track`: `now < nextDueAt`. The next dose simply hasn't come round.
 *   - `due`: `nextDueAt ≤ now ≤ graceUntil`. A neutral / amber call-to-action.
 *   - `missed`: `now > graceUntil` and the cycle has no logged intake. The
 *     only state that should tint red.
 *   - `none`: no schedule projects a next dose (PRN, paused, ended). The
 *     card shows no current-cycle line.
 *
 * `hasClosedCycles` is false for a brand-new sparse med with zero closed
 * dose cycles — the card then surfaces a neutral "no closed dose cycles
 * yet" state instead of a misleading 100% / 0%.
 */
export type CurrentCycleState = "on_track" | "due" | "missed" | "none";

export interface CurrentCycle {
  state: CurrentCycleState;
  /** The open cycle's due instant (ISO via JSON). Null when `state === "none"`. */
  nextDueAt: Date | null;
  /** End of the due slot's grace window. Null when `state === "none"`. */
  graceUntil: Date | null;
  /**
   * Whether the trailing window holds at least one CLOSED dose cycle. When
   * false the percentage rows are vacuous (no closed cycle to score) and the
   * card should show a neutral "not enough data yet" state.
   */
  hasClosedCycles: boolean;
}

/**
 * v1.13.x Fix 4 — classify the medication's open (current) dose cycle.
 *
 * Uses the canonical engine's {@link nextOccurrenceAfter} to find the
 * earliest projected dose at or after the start of the search (one ms before
 * `now` so a slot landing exactly now is captured). The rolling branch of
 * `nextOccurrenceAfter` floors to the start of the user's current day, so an
 * overdue rolling dose still surfaces as the next slot — that lets us tell a
 * not-yet-due (`on_track`) cycle apart from an overdue one (`due` / `missed`).
 *
 * `hasClosedCycles` reads `expectedShort` from the already-computed window
 * selection: a window holding zero expected (closed) doses means the
 * percentage rows are vacuous and the card should show a neutral state.
 */
/**
 * v1.15.10 — true when an intake event has already resolved the slot at
 * `slotAt`. A resolved slot is one the user took, deliberately skipped, or
 * the auto-miss cron flagged — any of which means the card must NOT keep
 * surfacing that slot as the next dose. Anchors on the snapped
 * `scheduledFor` (the canonical, exact path), falling back to the take
 * instant for a legacy row without one. A drifted anchor resolves its
 * nearest occurrence only, within the shared drift radius, so a sibling
 * slot closer than that radius is never swallowed; an ad-hoc row
 * (`scheduledFor === takenAt`) resolves only the slot it sits on. Same rule
 * as the list's next-due (`slot-resolution.ts`), so the cycle descriptor
 * and the card's due slot cannot disagree.
 */
function slotIsResolved(
  slotAt: Date,
  intakes: ComplianceIntakeInstant[],
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
): boolean {
  for (const e of intakes) {
    const isResolved = e.skipped || e.autoMissed === true || e.takenAt !== null;
    if (!isResolved) continue;
    const ref = (e.scheduledFor ?? e.takenAt) as Date | undefined;
    if (!ref) continue;
    const adHoc =
      e.scheduledFor !== undefined &&
      e.takenAt !== null &&
      e.scheduledFor.getTime() === e.takenAt.getTime();
    const resolves = anchorResolvesOccurrence({
      anchor: ref,
      occurrenceAt: slotAt,
      radiusMs: adHoc ? ADHOC_RESOLVE_EPSILON_MS : RESOLVE_RADIUS_MS,
      schedule,
      ctx,
    });
    if (resolves) return true;
  }
  return false;
}

export function buildCurrentCycle(
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  now: Date,
  expectedShort: number,
  intakes?: ComplianceIntakeInstant[],
): CurrentCycle {
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-cycle");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const allIntakes = intakes ?? [];
  const lastIntakeAt = lastNonSkippedTakenAt(allIntakes) ?? ctx.lastIntakeAt;

  // The open cycle's due instant + grace, picked as the SOONEST across every
  // schedule. Two paths:
  //   - ROLLING: the engine's `nextOccurrenceAfter` deliberately rolls an
  //     overdue re-anchored dose forward (it floors to the start of the
  //     user's current day), so it cannot surface an open cycle that is more
  //     than a day overdue. For the current-cycle descriptor we instead
  //     compute the due instant directly: `(lastNonSkippedIntake) + N` (or
  //     `startsOn ?? createdAt` with no intake). This is what lets `due` /
  //     `missed` be distinguished from `on_track`.
  //   - NON-ROLLING: `nextOccurrenceAfter` already surfaces the next due
  //     slot (RRULE / legacy / one-shot / cyclic).
  let dueAt: Date | null = null;
  let graceUntil: Date | null = null;
  const consider = (at: Date, grace: Date): void => {
    if (dueAt === null || at.getTime() < dueAt.getTime()) {
      dueAt = at;
      graceUntil = grace;
    }
  };

  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    const canonical = toCanonicalSchedule(s, `compliance-cycle-${i}`);
    if (canonical.scheduleType === "PRN") continue;
    const n = canonical.rollingIntervalDays;
    if (n !== null && n > 0) {
      const anchor =
        lastIntakeAt !== null
          ? new Date(lastIntakeAt.getTime() + n * DAY_MS)
          : (ctx.startsOn ?? ctx.createdAt);
      if (ctx.endsOn && anchor.getTime() > ctx.endsOn.getTime()) continue;
      const graceMs = (canonical.reminderGraceMinutes ?? 60) * 60 * 1000;
      consider(anchor, new Date(anchor.getTime() + graceMs));
      continue;
    }
    // v1.15.10 — advance past slots the user has already resolved. The
    // engine's `nextOccurrenceAfter` is purely time-anchored, so for a
    // twice-daily med it surfaces today's 19:00 slot in the afternoon even
    // after the user logged that dose early — the card then sticks on a
    // resolved past/present slot ("träge"). Walk occurrences forward and pick
    // the first one no intake has resolved (taken / skipped / auto-missed), so
    // a med whose remaining slots today are all logged advances to tomorrow's
    // first open slot. Bounded so a fully-logged-ahead history can't spin.
    let after = new Date(now.getTime() - 1);
    let picked: Occurrence | null = null;
    for (let step = 0; step < 64; step++) {
      const occ = nextOccurrenceAfter(canonical, after, recurrenceCtx);
      if (!occ) break;
      if (!slotIsResolved(occ.at, allIntakes, canonical, recurrenceCtx)) {
        picked = occ;
        break;
      }
      // This slot is resolved — step strictly past it and keep looking.
      after = new Date(occ.at.getTime());
    }
    if (picked) consider(picked.at, picked.graceUntil);
  }

  const hasClosedCycles = expectedShort > 0;

  if (dueAt === null || graceUntil === null) {
    return {
      state: "none",
      nextDueAt: null,
      graceUntil: null,
      hasClosedCycles,
    };
  }

  // Narrow the union-mutated locals for the comparisons below.
  const due: Date = dueAt;
  const grace: Date = graceUntil;
  let state: CurrentCycleState;
  if (now.getTime() < due.getTime()) {
    state = "on_track";
  } else if (now.getTime() <= grace.getTime()) {
    state = "due";
  } else {
    state = "missed";
  }

  return { state, nextDueAt: due, graceUntil: grace, hasClosedCycles };
}
