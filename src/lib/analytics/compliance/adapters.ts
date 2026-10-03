// Extracted from the former single-file `compliance.ts`. See `../compliance.ts`
// (the barrel) for the module map. Pure move — no logic changes.

import { normaliseDoseWindows } from "@/lib/medications/scheduling/worker-helpers";
import {
  expandRollingRetrospective,
  occurrencesBetween,
  type CanonicalSchedule,
  type Occurrence,
  type RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";
import {
  complianceMintWindow,
  type ComplianceIntakeInstant,
  type ComplianceMedicationContext,
  type ComplianceSchedule,
} from "./types";

/**
 * v1.13.x — the non-skipped `takenAt` instants at or before `now`, ascending.
 * These anchor the retrospective rolling expected-dose grid (each logged dose
 * is one satisfied expected slot). The full history is passed — not just the
 * compliance window — so the gap-walk between consecutive intakes (which
 * synthesizes skipped-cycle misses) and the forward next-due anchor stay
 * correct across the window boundary; `expandRollingRetrospective` clamps the
 * emitted slots to its own `[from, to]`.
 */
export function rollingIntakeInstants(
  events: { takenAt: Date | null; skipped: boolean }[],
  now: Date,
): Date[] {
  return events
    .filter(
      (e): e is { takenAt: Date; skipped: boolean } =>
        !e.skipped &&
        e.takenAt !== null &&
        e.takenAt.getTime() <= now.getTime(),
    )
    .map((e) => e.takenAt)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * v1.8.5 — adapt a compliance medication context to the canonical engine's
 * {@link RecurrenceContext}. The synthetic medication `id` only labels the
 * row for the engine's internal logging; the `idTag` keeps the two callers'
 * historical prefixes (`compliance-daily` vs `compliance-slots`) distinct.
 */
export function toRecurrenceCtx(
  ctx: ComplianceMedicationContext,
  idTag: string,
  /**
   * v1.40 (#1024) — `"courses"` expands over the span of every course (the
   * retrospective minters, which then drop the slots between courses);
   * the default is the medication's own window (the forward-looking cycle).
   */
  span: "current" | "courses" = "current",
): RecurrenceContext {
  const window =
    span === "courses"
      ? complianceMintWindow(ctx)
      : { startsOn: ctx.startsOn, endsOn: ctx.endsOn };
  return {
    medication: {
      id: idTag,
      startsOn: window.startsOn,
      endsOn: window.endsOn,
      oneShot: ctx.oneShot,
      createdAt: ctx.createdAt,
    },
    timeZone: ctx.timeZone,
    lastIntakeAt: ctx.lastIntakeAt,
  };
}

/**
 * v1.8.5 — adapt a {@link ComplianceSchedule} to the canonical engine's
 * {@link CanonicalSchedule}, defaulting the optional fields the compliance
 * payload may omit. `id` is engine-internal labelling only.
 */
export function toCanonicalSchedule(
  s: ComplianceSchedule,
  id: string,
): CanonicalSchedule {
  return {
    id,
    rrule: s.rrule ?? null,
    rollingIntervalDays: s.rollingIntervalDays ?? null,
    timesOfDay: s.timesOfDay ?? [],
    daysOfWeek: s.daysOfWeek ?? null,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    reminderGraceMinutes: s.reminderGraceMinutes ?? null,
    scheduleType: s.scheduleType ?? "SCHEDULED",
    cyclicOnWeeks: s.cyclicOnWeeks ?? null,
    cyclicOffWeeks: s.cyclicOffWeeks ?? null,
    doseWindows: normaliseDoseWindows(s.doseWindows),
  };
}

export function intakeInstantsAtOrBefore(
  intakes: ComplianceIntakeInstant[],
  now: Date,
): Date[] {
  return intakes
    .filter(
      (e): e is { takenAt: Date; skipped: boolean } =>
        !e.skipped &&
        e.takenAt !== null &&
        e.takenAt.getTime() <= now.getTime(),
    )
    .map((e) => e.takenAt)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * v1.13.x — expand one schedule's expected occurrences over `[from, to]`,
 * routing a ROLLING schedule through the retrospective builder when intake
 * history is supplied (`intakeInstants` + `now`) and the forward-only engine
 * path for every other shape. This is the single expansion the slot-count
 * helpers and the displayed-rate timeline both delegate to, so the heatmap
 * `due` flags, the window-selection denominator, and the percentage agree.
 */
export function expandComplianceOccurrences(
  canonical: CanonicalSchedule,
  recurrenceCtx: RecurrenceContext,
  from: Date,
  to: Date,
  retro: { intakeInstants: Date[]; now: Date } | undefined,
): Occurrence[] {
  if (retro && canonical.rollingIntervalDays !== null) {
    return expandRollingRetrospective(
      canonical,
      recurrenceCtx,
      from,
      to,
      retro.intakeInstants,
      retro.now,
    );
  }
  return occurrencesBetween(canonical, from, to, recurrenceCtx);
}
