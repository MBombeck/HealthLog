import type { MeasurementReminder } from "@/hooks/use-measurement-reminders";
import { translateOrNull } from "@/lib/i18n/translate-code";
import type { ReminderEditBody } from "@/lib/measurement-reminders/edit-body";
import { detectBrowserTimezone, userDayKey } from "@/lib/tz/format";

// The active-measurement set, grouped so the dropdown
// doesn't read as a flat 15-item list. Mirrors the Zod allow-list in
// `validations/measurement-reminders.ts`; the labels resolve through
// `measurementReminders.types.*`, the group headers through
// `measurementReminders.typeGroups.*`.
export const TYPE_GROUPS = [
  {
    group: "vitals",
    types: [
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "PULSE",
      "BLOOD_GLUCOSE",
      "OXYGEN_SATURATION",
      "BODY_TEMPERATURE",
    ],
  },
  {
    group: "bodyComposition",
    types: [
      "BODY_FAT",
      "FAT_MASS",
      "FAT_FREE_MASS",
      "MUSCLE_MASS",
      "LEAN_BODY_MASS",
      "BONE_MASS",
      "TOTAL_BODY_WATER",
      "VISCERAL_FAT",
      "BODY_MASS_INDEX",
      "WAIST_CIRCUMFERENCE",
    ],
  },
  // The mental-wellbeing screenings become plannable like any
  // other Vorsorge item. Auto-resolve rides the server-written *_SCORE row a
  // completed check-in produces (v1.27.9 adds WHO-5 + SCI).
  {
    group: "mentalWellbeing",
    types: ["PHQ9_SCORE", "GAD7_SCORE", "WHO5_SCORE", "SCI_SCORE"],
  },
] as const;

// Screening types get a dedicated primary action (the check-in
// page, not the numeric MeasurementForm) and a 4-week default cadence
// (both instruments cover the last two weeks).
export const MENTAL_SCREENING_DEFAULT_INTERVAL = "28";

// 28 joined in v1.27.6 as the screening default (every 4 weeks); 30 stays
// so existing monthly reminders keep resolving onto a preset.
export const INTERVAL_PRESETS = [7, 14, 28, 30, 90, 180, 365] as const;
// The sentinel the cadence picker writes when the user wants a
// free interval or an RFC-5545 RRULE instead of a fixed preset.
export const CADENCE_CUSTOM = "custom";
export const CADENCE_RRULE = "rrule";
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A COACH-minted reminder stores an i18n KEY in `label` (the
 * cadence preset's `labelKey`), not free prose. Resolve it through `t()`;
 * a user-created (VORSORGE) reminder carries free text and renders verbatim.
 */
export function resolveReminderLabel(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): string {
  if (reminder.origin === "COACH") {
    // A label the catalogue has no sentence for shows as written, so a future
    // catalog addition never surfaces a bare key.
    return translateOrNull(t, reminder.label) ?? reminder.label;
  }
  return reminder.label;
}

/** ISO instant → the `<input type="date">` value (YYYY-MM-DD), local. */
export function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return userDayKey(d, detectBrowserTimezone());
}

/**
 * `<input type="date">` value → the calendar date itself, or null. The server
 * reads a bare date as that day in the profile's zone, so a browser set to
 * another zone cannot move the first-due day.
 */
export function fromDateInputValue(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export interface FormState {
  label: string;
  kind: "type" | "freeText";
  measurementType: string;
  /** A preset number-as-string, or the CADENCE_CUSTOM / CADENCE_RRULE sentinel. */
  cadenceChoice: string;
  /** Free "every N days" value, used when cadenceChoice === CADENCE_CUSTOM. */
  customIntervalDays: number;
  /** Raw RRULE, used when cadenceChoice === CADENCE_RRULE. */
  rrule: string;
  /** First-due date (YYYY-MM-DD), optional. Maps to `anchorDate`. */
  anchorDate: string;
  notifyHour: number;
  location: string;
}

export const EMPTY_FORM: FormState = {
  label: "",
  kind: "type",
  measurementType: "BLOOD_PRESSURE_SYS",
  cadenceChoice: "7",
  customIntervalDays: 30,
  rrule: "FREQ=YEARLY",
  anchorDate: "",
  notifyHour: 9,
  location: "",
};

/** The form as a stored reminder opens it, cadence resolved onto the picker. */
export function formFromReminder(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): FormState {
  // A preset value if it matches one, otherwise the custom-interval or RRULE
  // branch.
  const interval = reminder.intervalDays;
  const cadenceChoice = reminder.rrule
    ? CADENCE_RRULE
    : interval != null &&
        (INTERVAL_PRESETS as readonly number[]).includes(interval)
      ? String(interval)
      : interval != null
        ? CADENCE_CUSTOM
        : "7";
  return {
    label: resolveReminderLabel(reminder, t),
    kind: reminder.measurementType ? "type" : "freeText",
    measurementType: reminder.measurementType ?? "BLOOD_PRESSURE_SYS",
    cadenceChoice,
    customIntervalDays:
      cadenceChoice === CADENCE_CUSTOM && interval != null ? interval : 30,
    rrule: reminder.rrule ?? "FREQ=YEARLY",
    anchorDate: toDateInputValue(reminder.anchorDate),
    notifyHour: reminder.notifyHour,
    location: reminder.location ?? "",
  };
}

/**
 * The picker state as the mutually exclusive cadence pair the schema expects
 * (exactly one of intervalDays / rrule).
 */
function resolveCadence(state: FormState): {
  intervalDays: number | null;
  rrule: string | null;
} {
  if (state.cadenceChoice === CADENCE_RRULE) {
    const trimmed = state.rrule.trim();
    return { intervalDays: null, rrule: trimmed || null };
  }
  if (state.cadenceChoice === CADENCE_CUSTOM) {
    return { intervalDays: state.customIntervalDays, rrule: null };
  }
  return { intervalDays: Number(state.cadenceChoice), rrule: null };
}

/** The form as the request body a create or an edit sends. */
export function toEditBody(state: FormState): ReminderEditBody {
  const { intervalDays, rrule } = resolveCadence(state);
  return {
    label: state.label.trim(),
    measurementType: state.kind === "type" ? state.measurementType : null,
    intervalDays,
    rrule,
    anchorDate: fromDateInputValue(state.anchorDate),
    notifyHour: state.notifyHour,
    location: state.location.trim() || null,
  };
}
