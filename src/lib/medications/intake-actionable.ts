/**
 * v1.39.4 (#1040) — whether a medication offers "taken" / "skip" today.
 *
 * One rule, resolved on the server and published on the medication read
 * wire as `intakeActionable` (with the `courseStatus` it derives from), so
 * the web cards, the table, the take-all flow and the iOS app all answer
 * the same question the same way instead of each re-deriving it:
 *
 *   - the medication is active (not paused or archived),
 *   - its intake is tracked (`trackIntake`, see `intake-tracking.ts`), and
 *   - its course includes today on the user's clock (`courseStatusAt`:
 *     `startsOn <= today <= endsOn`, calendar days, both ends inclusive).
 *
 * The due-slot question is already the schedule engine's: it caps every
 * slot at `endsOn` and floors it at `startsOn`, so the reminder worker, the
 * dashboard doses card and the today list never mint a dose outside the
 * course. What was missing was the action row on the medication itself,
 * which only looked at `active` and so kept offering a dose for a course
 * that had ended. Within the course the row stays available between slots
 * on purpose: taking a dose early is a supported flow with its own
 * double-dose guard.
 *
 * Logging a past dose from the history is a different verb and is not
 * gated here; an ended course can still be completed after the fact.
 *
 * #1280 — `canEndCourse` rides along: "End course" is offered exactly while
 * the course is CURRENT, from the same resolution. A course ended with it is
 * ENDED from that instant (`endedAt`), so the action row and the End button
 * go away at once instead of at midnight.
 */
import {
  canEndCourse,
  courseStatusAt,
  type CourseStatus,
} from "@/lib/medications/course-window";
import { isRecordOnly } from "@/lib/medications/intake-tracking";

export interface IntakeActionability {
  courseStatus: CourseStatus;
  intakeActionable: boolean;
  canEndCourse: boolean;
}

export function resolveIntakeActionability(
  medication: {
    active: boolean;
    trackIntake: boolean;
    startsOn: Date | null;
    endsOn: Date | null;
    endedAt: Date | null;
  },
  now: Date,
  timeZone: string,
): IntakeActionability {
  const courseStatus = courseStatusAt(medication, now, timeZone);
  return {
    courseStatus,
    intakeActionable:
      medication.active &&
      !isRecordOnly(medication) &&
      courseStatus === "CURRENT",
    canEndCourse: canEndCourse(courseStatus),
  };
}
