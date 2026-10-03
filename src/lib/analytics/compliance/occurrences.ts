// Extracted from the former single-file `compliance.ts`. See `../compliance.ts`
// (the barrel) for the module map. Pure move — no logic changes.

import { occurrencesAcrossEras } from "@/lib/medications/scheduling/schedule-eras";
import type { Occurrence } from "@/lib/medications/scheduling/recurrence";
import {
  slotInsideCourses,
  type ComplianceIntakeInstant,
  type ComplianceMedicationContext,
  type ComplianceSchedule,
} from "./types";
import {
  expandComplianceOccurrences,
  intakeInstantsAtOrBefore,
  toCanonicalSchedule,
  toRecurrenceCtx,
} from "./adapters";

/**
 * v1.7.0 item 5 — count the expected dose slots a medication's schedules
 * emit inside `[dayStart, dayEnd)`, routed through the canonical engine.
 * Powers the per-day `due` / `expectedCount` fields on the per-med
 * compliance payload so iOS history renders a "missed" mark only on days
 * the schedule actually expected a dose (not off-weeks / non-matching
 * weekdays / PRN days).
 *
 * v1.13.x — pass `intakes` so a ROLLING schedule routes through the
 * retrospective grid (each logged dose is a `due` day, plus skipped-cycle
 * misses + a past-due forward slot) instead of the engine's single forward
 * slot. Omitting `intakes` keeps the forward-only behaviour for callers that
 * don't have the intake history at hand.
 */
export function expectedSlotCountForDay(
  schedules: ComplianceSchedule[],
  dayStart: Date,
  dayEnd: Date,
  ctx: ComplianceMedicationContext,
  intakes?: ComplianceIntakeInstant[],
): number {
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-daily", "courses");
  const now = new Date();
  const retro =
    intakes && schedules.some((s) => s.rollingIntervalDays != null)
      ? { intakeInstants: intakeInstantsAtOrBefore(intakes, now), now }
      : undefined;
  // v1.16.3 — era-aware: a past day counts the slots of the schedule that
  // was live THEN. With no revisions the single live era expands exactly
  // the per-schedule loop this used to run.
  return occurrencesAcrossEras(
    {
      from: dayStart,
      // occurrencesBetween is inclusive of both ends; subtract 1 ms so a
      // slot exactly at the next day's midnight doesn't double-count.
      to: new Date(dayEnd.getTime() - 1),
    },
    ctx.scheduleRevisions ?? [],
    schedules.map((s, i) => toCanonicalSchedule(s, `compliance-daily-${i}`)),
    (schedule, eraFrom, eraTo) =>
      expandComplianceOccurrences(
        schedule,
        recurrenceCtx,
        eraFrom,
        eraTo,
        retro,
      ),
    { oneShot: ctx.oneShot },
    // v1.40 (#1024) — a day between two courses expects nothing.
  ).filter((o) => slotInsideCourses(ctx, o.at)).length;
}

/**
 * v1.8.5 — the sibling of {@link expectedSlotCountForDay} that returns the
 * expected-dose occurrences *themselves* (ascending by instant) over an
 * arbitrary window, rather than just the per-day count. Same loop, same
 * canonical-engine delegation; we keep the slots so the dose-adherence
 * timeline can pair each expected slot to its intake.
 *
 * Used by {@link buildComplianceDisplay} to decide the card's render mode
 * (percent bars vs an uptime-style per-dose strip) and to build the strip.
 * `occurrencesBetween` is inclusive of both ends; the caller passes a
 * `[from, to]` window and we sort the union of every schedule's slots so
 * a multi-schedule medication interleaves its slots in time order.
 *
 * v1.8.6 QA — the window lower bound is clamped to `ctx.createdAt`. The
 * legacy weekday walker floors on `startsOn` but not on `createdAt`, so a
 * brand-new daily med queried over a 30-day window would otherwise emit
 * slots for every day before it existed (7/30 expected on a 2-day-old med).
 * Clamping here keeps the expected-dose denominator — and the window
 * selection that reads it — honest about the medication's real age. The
 * displayed rates clamp independently via `calculateCompliance`'s
 * `medicationCreatedAt` argument, so this only fixes the slot counts.
 */
export function expectedSlotsBetween(
  schedules: ComplianceSchedule[],
  from: Date,
  to: Date,
  ctx: ComplianceMedicationContext,
  intakes?: ComplianceIntakeInstant[],
): Occurrence[] {
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-slots", "courses");
  const effectiveFrom =
    ctx.createdAt.getTime() > from.getTime() ? ctx.createdAt : from;
  // v1.13.x — for a ROLLING schedule the expected grid is reconstructed from
  // the intake history (each logged dose is one satisfied expected slot) so
  // the window-selection denominator matches the displayed rate. The forward
  // next-due slot counts only when past-due relative to `to` (the window's
  // upper bound), so a not-yet-due open cycle never inflates the count.
  const retro =
    intakes && schedules.some((s) => s.rollingIntervalDays != null)
      ? { intakeInstants: intakeInstantsAtOrBefore(intakes, to), now: to }
      : undefined;
  if (effectiveFrom.getTime() > to.getTime()) return [];
  // v1.16.3 — era-aware: each archived era contributes the slots of ITS
  // schedules; the live rows cover only the range past the newest revision.
  return occurrencesAcrossEras(
    { from: effectiveFrom, to },
    ctx.scheduleRevisions ?? [],
    schedules.map((s, i) => toCanonicalSchedule(s, `compliance-slots-${i}`)),
    (schedule, eraFrom, eraTo) =>
      expandComplianceOccurrences(
        schedule,
        recurrenceCtx,
        eraFrom,
        eraTo,
        retro,
      ),
    { oneShot: ctx.oneShot },
    // v1.40 (#1024) — a day between two courses expects nothing.
  ).filter((o) => slotInsideCourses(ctx, o.at));
}
