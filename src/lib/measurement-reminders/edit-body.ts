/**
 * v1.39.2 — the body an edit of a Vorsorge reminder sends: only the fields
 * the person changed.
 *
 * The edit sheet used to send every field on each save. The first due date
 * went out as the browser's local midnight even when nobody touched it, which
 * the server read as a new first due date and rescheduled from, so renaming
 * an overdue check-up moved it to its next slot. The server now compares by
 * calendar day as well; this keeps the client from claiming changes it did
 * not make in the first place.
 */
export interface ReminderEditBody {
  label: string;
  measurementType: string | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: string | null;
  notifyHour: number;
  location: string | null;
}

export function changedReminderFields(
  initial: ReminderEditBody,
  next: ReminderEditBody,
): Partial<ReminderEditBody> {
  const body: Partial<ReminderEditBody> = {};
  if (next.label !== initial.label) body.label = next.label;
  if (next.measurementType !== initial.measurementType) {
    body.measurementType = next.measurementType;
  }
  // Mutually exclusive on the server: a change to either sends both.
  if (
    next.intervalDays !== initial.intervalDays ||
    next.rrule !== initial.rrule
  ) {
    body.intervalDays = next.intervalDays;
    body.rrule = next.rrule;
  }
  if (next.anchorDate !== initial.anchorDate) body.anchorDate = next.anchorDate;
  if (next.notifyHour !== initial.notifyHour) body.notifyHour = next.notifyHour;
  if (next.location !== initial.location) body.location = next.location;
  return body;
}
