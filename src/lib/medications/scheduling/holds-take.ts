/**
 * Which recorded outcomes hold a slot against a new take.
 *
 * An outcome the server recorded on its own (the auto-miss and auto-skip
 * passes, an automatically recorded take) stands only until the person
 * answers the dose: a real take or skip replaces it. So only a real recorded
 * take makes a second take a repeat (`alreadyTaken`), and only a real take
 * or skip keeps the slot from being offered to the next take.
 */
interface RecordedOutcome {
  takenAt: Date | null;
  skipped: boolean;
  autoMissed: boolean;
  autoRecorded: boolean;
}

/** A take the person recorded (not one the server recorded for them). */
export function holdsTake(row: RecordedOutcome): boolean {
  return row.takenAt !== null && !row.skipped && !row.autoRecorded;
}

/** A take or skip the person recorded: the slot is answered. */
export function holdsAnswer(row: RecordedOutcome): boolean {
  return (
    holdsTake(row) || (row.skipped && !row.autoMissed && !row.autoRecorded)
  );
}
