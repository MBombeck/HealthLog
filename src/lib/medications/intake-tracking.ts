/**
 * v1.39.1 (#1033) — per-medication intake tracking.
 *
 * `Medication.trackIntake = false` keeps a medication as a record: its dose,
 * dates and schedule rows stay stored and shown, but nothing is ever due. An
 * as-needed medication reaches "never due" structurally, by carrying no
 * schedule rows at all. A record-only medication keeps its rows, so every
 * reader that derives a due dose, a reminder, a projected slot or an
 * adherence figure from them has to opt out explicitly. The helpers below are
 * the one vocabulary for that, and
 * `src/__tests__/medication-intake-tracking-guard.test.ts` fails when a
 * schedule reader uses none of them and is not on its reviewed allowlist.
 */

/**
 * Prisma `where` fragment for a medication read: only medications whose
 * intake is tracked. Spread it next to `asNeeded: false` on every read that
 * feeds a due dose, a reminder or an adherence figure.
 */
export const TRACKED_INTAKE_WHERE = { trackIntake: true } as const;

/**
 * Prisma `where` fragment for an intake-event read that should only see
 * events of tracked medications (the today list, the outstanding-dose badge).
 */
export const TRACKED_INTAKE_EVENT_WHERE = {
  medication: { trackIntake: true },
} as const;

/**
 * True only for an explicit `trackIntake: false`. The column is NOT NULL
 * with a default of true, so on a full row the two readings agree; on a
 * partial projection that did not select the flag, the medication reads as
 * tracked, the behaviour every medication had before the switch existed.
 */
export function isRecordOnly(medication: { trackIntake?: boolean }): boolean {
  return medication.trackIntake === false;
}

/**
 * The schedule rows that are in force for due-dose purposes: the stored rows
 * when intake is tracked, none when it is not. Era-aware readers pass this as
 * the LIVE schedule, so the stretch since tracking was switched off expects
 * nothing while archived eras before it keep their own schedule.
 */
export function dueSchedules<T>(medication: {
  trackIntake: boolean;
  schedules: readonly T[];
}): T[] {
  return isRecordOnly(medication) ? [] : [...medication.schedules];
}

/**
 * Wire shape for a medication's schedules. A record-only medication is served
 * with `schedules: []`, the way an as-needed one is, so a client that arms
 * local reminders or derives due doses from `schedules` (the shipped iOS app
 * does both) stays silent without an update. The stored rows travel in the
 * additive `recordedSchedules` field, which is present only on a record-only
 * medication; a tracked medication carries them in `schedules` as before.
 */
export function scheduleWireFields<T>(
  trackIntake: boolean,
  schedules: T[],
): { schedules: T[]; recordedSchedules?: T[] } {
  return trackIntake === false
    ? { schedules: [], recordedSchedules: schedules }
    : { schedules };
}
