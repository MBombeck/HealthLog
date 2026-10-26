/**
 * The incoming schedules of a medication edit, normalised once.
 *
 * The same values feed the nested create payload AND the revision
 * compare/snapshot, so the material-change gate sees exactly what will be
 * persisted. The invariants mirror the create: recurring default
 * `FREQ=DAILY` when nothing else is set, `timesOfDay` dual-written from
 * `windowStart` when absent, and the window pulled to the dose times when a
 * time falls outside it.
 */
import type { z } from "zod/v4";

import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { toRevisionPayloadEntry } from "@/lib/medications/scheduling/schedule-eras";
import { hhmmToMinutesOrNull } from "@/lib/medications/scheduling/hhmm";
import type { updateMedicationSchema } from "@/lib/validations/medication";

export type MedicationEdit = z.output<typeof updateMedicationSchema>;
type ScheduleInput = NonNullable<MedicationEdit["schedules"]>[number];

/** Parse "HH:mm" into minutes-of-day; NaN-safe (malformed → 0). */
function hhmmToMinutes(value: string): number {
  return hhmmToMinutesOrNull(value) ?? 0;
}

/**
 * Reconcile a schedule's `windowStart` / `windowEnd` with its effective
 * `timesOfDay`. The schedule editor can change only the dose times while the
 * client echoes the previous window back; a time outside the window then
 * breaks every consumer that assumes `timesOfDay ⊆ [windowStart, windowEnd]`
 * (the window-status pill, the reminder phases, the legacy compliance
 * walker). When ANY time falls outside the window — including the overnight
 * `windowEnd < windowStart` shape, checked with wrap-around membership —
 * the window is pulled to the min/max of the times so the persisted row is
 * self-consistent. A window that already covers every time is left
 * byte-identical (explicitly wider windows are a feature).
 */
function reconcileScheduleWindow(
  windowStart: string,
  windowEnd: string,
  timesOfDay: string[],
): { windowStart: string; windowEnd: string } {
  if (timesOfDay.length === 0) return { windowStart, windowEnd };
  const startMins = hhmmToMinutes(windowStart);
  const endMins = hhmmToMinutes(windowEnd);
  const overnight = endMins < startMins;
  const inWindow = (t: number): boolean =>
    overnight ? t >= startMins || t <= endMins : t >= startMins && t <= endMins;
  const sorted = [...timesOfDay].sort(
    (a, b) => hhmmToMinutes(a) - hhmmToMinutes(b),
  );
  const allInside = sorted.every((t) => inWindow(hhmmToMinutes(t)));
  if (allInside) return { windowStart, windowEnd };
  return { windowStart: sorted[0], windowEnd: sorted[sorted.length - 1] };
}

function normaliseSchedule(s: ScheduleInput, oneShot: boolean | undefined) {
  // Invariant 2 — default to FREQ=DAILY when nothing else is set.
  // PRN carries no cadence, so never default it.
  const hasLegacyDays = (s.daysOfWeek?.length ?? 0) > 0;
  const isPrn = s.scheduleType === "PRN";
  const defaultedRrule =
    oneShot !== true &&
    !isPrn &&
    s.rrule === undefined &&
    s.rollingIntervalDays === undefined &&
    !hasLegacyDays
      ? "FREQ=DAILY"
      : s.rrule;

  // Invariant 3 — dual-write timesOfDay from windowStart.
  const effectiveTimesOfDay =
    s.timesOfDay && s.timesOfDay.length > 0 ? s.timesOfDay : [s.windowStart];

  // Invariant 4 — window / times consistency. See
  // `reconcileScheduleWindow`: a times-only edit that echoes the
  // stale window back gets the window pulled to the min/max of
  // the new times.
  const window = reconcileScheduleWindow(
    s.windowStart,
    s.windowEnd,
    effectiveTimesOfDay,
  );

  const serializedDaysOfWeek = serializeScheduleRecurrence({
    daysOfWeek: s.daysOfWeek ?? [],
    intervalWeeks: s.intervalWeeks ?? 1,
  });

  return {
    createData: {
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      label: s.label ?? null,
      dose: s.dose ?? null,
      // #219 — per-schedule inventory units, field-by-field. A schedule
      // replace re-creates the rows, so absent leaves the column NULL
      // and the consume hook inherits the medication-level value.
      ...(s.unitsPerDose !== undefined && {
        unitsPerDose: s.unitsPerDose,
      }),
      daysOfWeek: serializedDaysOfWeek,
      // First-class times-of-day.
      timesOfDay: effectiveTimesOfDay,
      ...(s.reminderGraceMinutes !== undefined && {
        reminderGraceMinutes: s.reminderGraceMinutes,
      }),
      ...(defaultedRrule !== undefined && { rrule: defaultedRrule }),
      ...(s.rollingIntervalDays !== undefined && {
        rollingIntervalDays: s.rollingIntervalDays,
      }),
      // Schedule type + cyclic weeks, field-by-field.
      ...(s.scheduleType !== undefined && {
        scheduleType: s.scheduleType,
      }),
      ...(s.cyclicOnWeeks !== undefined && {
        cyclicOnWeeks: s.cyclicOnWeeks,
      }),
      ...(s.cyclicOffWeeks !== undefined && {
        cyclicOffWeeks: s.cyclicOffWeeks,
      }),
      // Per-dose configurable on-time windows. A `schedules`
      // replace re-creates the rows, so the column is re-written each
      // time; absent leaves it NULL (default ±1h derivation).
      ...(s.doseWindows !== undefined && {
        doseWindows: s.doseWindows,
      }),
    },
    // Mirror of the row the create above will persist (defaults applied),
    // shaped for the cadence compare.
    snapshot: toRevisionPayloadEntry({
      timesOfDay: effectiveTimesOfDay,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      daysOfWeek: serializedDaysOfWeek,
      rrule: defaultedRrule ?? null,
      rollingIntervalDays: s.rollingIntervalDays ?? null,
      scheduleType: s.scheduleType ?? "SCHEDULED",
      cyclicOnWeeks: s.cyclicOnWeeks ?? null,
      cyclicOffWeeks: s.cyclicOffWeeks ?? null,
      doseWindows: s.doseWindows ?? null,
      label: s.label ?? null,
      dose: s.dose ?? null,
      reminderGraceMinutes: s.reminderGraceMinutes ?? null,
    }),
  };
}

export type NormalisedSchedule = ReturnType<typeof normaliseSchedule>;

/** The incoming schedules, normalised; undefined when the edit sends none. */
export function normaliseSchedules(
  schedules: MedicationEdit["schedules"],
  oneShot: boolean | undefined,
): NormalisedSchedule[] | undefined {
  return schedules?.map((s) => normaliseSchedule(s, oneShot));
}
