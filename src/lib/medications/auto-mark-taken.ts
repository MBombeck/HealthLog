/**
 * v1.42.2 — whether a dose reminder may be sent for a medication.
 *
 * THE one definition. The reminder worker and the admin reminder check gate
 * every send on it, and the medication read paths publish its result as
 * `remindersActive`, so a client that arms local reminders reads the server's
 * decision instead of re-deriving it from the raw flags.
 *
 * A medication reminds only when the person wants reminders
 * (`notificationsEnabled`), it is active (not paused or ended), its course
 * has not ended (`endsOn` lies before today on the person's clock: the
 * worker expands no slot past it), it has doses that fall due (intake
 * tracked, not as-needed), and its doses are not recorded automatically
 * (`autoMarkTaken`). A course that has not started yet still reminds once
 * it does. #1280 — a course ended with "End course" stops reminding at the
 * instant it was ended (`endedAt`), including the follow-up nags of a dose
 * that fell due before it. The person's own reminder preference stays stored untouched:
 * switching auto-mark-taken off restores whatever they had chosen.
 */
import { courseStatusAt } from "@/lib/medications/course-window";

export interface ReminderGateMedication {
  notificationsEnabled: boolean;
  autoMarkTaken: boolean;
  active: boolean;
  trackIntake: boolean;
  asNeeded: boolean;
  endsOn: Date | null;
  endedAt: Date | null;
}

export function sendsMedicationReminders(
  medication: ReminderGateMedication,
  at: { now: Date; timeZone: string },
): boolean {
  return (
    medication.notificationsEnabled &&
    !medication.autoMarkTaken &&
    medication.active &&
    medication.trackIntake &&
    !medication.asNeeded &&
    courseStatusAt(
      {
        startsOn: null,
        endsOn: medication.endsOn,
        endedAt: medication.endedAt,
      },
      at.now,
      at.timeZone,
    ) !== "ENDED"
  );
}
