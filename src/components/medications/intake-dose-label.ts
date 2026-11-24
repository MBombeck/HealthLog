/**
 * Which dose an intake is, in words, for every control and toast that
 * deletes, undoes or restores one: "the 09:00 dose, taken at 08:00". A row
 * that names only "the intake" lets a person remove the morning dose when
 * they meant the evening one, and a toast that says "Intake deleted" does
 * not tell them which one went.
 *
 * Times go through the reader's formatters, so the 12/24 h setting holds:
 * `formatTime` for an instant (`useFormatters().time`), `wallTime` for a
 * schedule's own `HH:mm` (`useFormatters().wallTime`).
 */

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface IntakeDose {
  /** The slot the dose belongs to, or null for an off-schedule take. */
  slotAt: string | Date | null;
  /**
   * The slot's own wall time (`HH:mm`) when the caller has it: it names the
   * slot as the schedule does, and wins over `slotAt`.
   */
  slotTime?: string | null;
  /** When the dose was taken; null for a skipped or missed dose. */
  takenAt: string | Date | null;
  skipped: boolean;
}

export interface IntakeDoseFormat {
  t: Translator;
  formatTime: (at: Date) => string;
  wallTime?: (hhmm: string) => string;
}

function slotLabel(dose: IntakeDose, fmt: IntakeDoseFormat): string | null {
  if (dose.slotTime && fmt.wallTime) return fmt.wallTime(dose.slotTime);
  if (dose.slotAt) return fmt.formatTime(new Date(dose.slotAt));
  return null;
}

/** The dose as a phrase: "the 09:00 dose, taken at 08:00". */
export function intakeDoseLabel(
  dose: IntakeDose,
  fmt: IntakeDoseFormat,
): string {
  const slot = slotLabel(dose, fmt);
  const taken =
    !dose.skipped && dose.takenAt
      ? fmt.formatTime(new Date(dose.takenAt))
      : null;
  if (slot && taken) {
    return fmt.t("medications.dose.which.slotTaken", { slot, taken });
  }
  if (slot && dose.skipped) {
    return fmt.t("medications.dose.which.slotSkipped", { slot });
  }
  if (slot) return fmt.t("medications.dose.which.slot", { slot });
  if (taken) return fmt.t("medications.dose.which.taken", { taken });
  return fmt.t("medications.dose.which.plain");
}

/** The toast of a deleted or undone dose: "Removed the 09:00 dose, …". */
export function intakeRemovedMessage(
  dose: IntakeDose,
  fmt: IntakeDoseFormat,
): string {
  return fmt.t("medications.dose.removed", {
    dose: intakeDoseLabel(dose, fmt),
  });
}

/** The toast of a dose its Undo recorded again. */
export function intakeRestoredMessage(
  dose: IntakeDose,
  fmt: IntakeDoseFormat,
): string {
  return fmt.t("medications.dose.restored", {
    dose: intakeDoseLabel(dose, fmt),
  });
}

/** The accessible name of a control that deletes the dose. */
export function intakeDeleteLabel(
  dose: IntakeDose,
  fmt: IntakeDoseFormat,
): string {
  return fmt.t("medications.dose.deleteLabel", {
    dose: intakeDoseLabel(dose, fmt),
  });
}
