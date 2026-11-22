/**
 * The wizard's per-step gate: what still holds a step, and whether it can be
 * left. Pure; split from `./wizard-payload.ts`, which re-exports both.
 */
import { parseUnitsPerDoseInput } from "@/lib/medications/units-per-dose";
import { isAcceptableLeafletUrl } from "@/lib/medications/leaflet-url";

import type { WizardPayload } from "./wizard-payload";

/** A well-formed 24 h `HH:mm` dose time. */
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * What still holds a step, as the i18n key of the sentence that says so under
 * a disabled Next (`medications.wizard.blocked.*`), or null when the step
 * can be left. The one statement of each step's gate: `validateStep` is this
 * returning null, so the hint and the button can never disagree.
 *
 * Matrix:
 *  - Step 1: name populated.
 *  - Step 2: nothing required; without a choice the medication is filed
 *    under "Other".
 *  - Step 3: doseAmount populated, tablets or units per dose readable.
 *  - Step 4: startsOn present + (endsOn null OR endsOn >= startsOn).
 *  - Step 5: mode picked.
 *  - Step 6: cadence-specific (weekdays >= 1; interval >= 1; monthly
 *    day 1..31; rolling 1..365).
 *  - Step 7: >= 1 valid HH:mm time, a typed per-time unit count readable.
 *  - Step 8: mirrors Step 4 (the reminders toggle has no failure mode), and
 *    a leaflet link, when one is typed, must be an `https:` address (#1430).
 */
export function stepBlocker(
  payload: WizardPayload,
  step: number,
): string | null {
  const course = (): string | null => {
    if (payload.startsOn === null) return "medications.wizard.blocked.start";
    if (payload.endsOn === null) return null;
    return payload.endsOn.getTime() >= payload.startsOn.getTime()
      ? null
      : "medications.wizard.blocked.endBeforeStart";
  };
  switch (step) {
    case 1:
      return payload.name.trim().length > 0
        ? null
        : "medications.wizard.blocked.name";
    case 2:
      return null;
    case 3:
      if (payload.doseAmount.trim().length === 0) {
        return "medications.wizard.blocked.amount";
      }
      return parseUnitsPerDoseInput(payload.unitsPerDose) !== null
        ? null
        : "medications.wizard.blocked.unitsPerDose";
    case 4:
      return course();
    case 5:
      return payload.mode !== null ? null : "medications.wizard.blocked.mode";
    case 6: {
      if (payload.mode !== "recurring") return null;
      const weekdays = "medications.wizard.blocked.weekdays";
      switch (payload.cadence.kind) {
        case "weekdays":
          return payload.subControls.weekdays.length >= 1 ? null : weekdays;
        case "everyNWeeks":
          if (payload.subControls.weekdays.length < 1) return weekdays;
          return payload.subControls.intervalWeeks >= 1
            ? null
            : "medications.wizard.blocked.interval";
        case "monthly":
          return payload.subControls.dayOfMonth >= 1 &&
            payload.subControls.dayOfMonth <= 31
            ? null
            : "medications.wizard.blocked.dayOfMonth";
        case "rolling":
          return payload.subControls.rollingDays >= 1 &&
            payload.subControls.rollingDays <= 365
            ? null
            : "medications.wizard.blocked.rollingDays";
        default:
          return null;
      }
    }
    case 7: {
      const times = payload.timesOfDay.filter((t) => TIME_RE.test(t));
      if (times.length < 1) return "medications.wizard.blocked.time";
      // Blank inherits the medication-level value; anything typed must read.
      const slotUnits = payload.scheduleUnitsPerDose.trim();
      return slotUnits === "" || parseUnitsPerDoseInput(slotUnits) !== null
        ? null
        : "medications.wizard.blocked.unitsPerDose";
    }
    case 8:
      return (
        course() ??
        (payload.leafletUrl.trim() === "" ||
        isAcceptableLeafletUrl(payload.leafletUrl.trim())
          ? null
          : "medications.wizard.blocked.leafletUrl")
      );
    default:
      return "medications.wizard.blocked.unknown";
  }
}

/** Whether the step's required inputs are populated (`stepBlocker` is null). */
export function validateStep(payload: WizardPayload, step: number): boolean {
  return stepBlocker(payload, step) === null;
}
