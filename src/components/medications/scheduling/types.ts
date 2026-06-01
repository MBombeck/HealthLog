/**
 * v1.5.0 — shared types for the medication-scheduling wizard
 * components (`CadencePicker`, `TimesOfDayChips`, `CourseWindowRow`).
 *
 * The wizard layer composes these three primitives + a few non-
 * scheduling steps (name/dose, reminders, summary) and maps the
 * resulting `CadenceValue` + `timesOfDay[]` + `{ startsOn, endsOn }`
 * into the create-medication request body shape declared in
 * `src/lib/validations/medication.ts`:
 *
 *   - `oneShot` lives at the medication level
 *   - `rrule` + `rollingIntervalDays` live on the schedule
 *   - `timesOfDay` lives on the schedule
 *   - `startsOn` + `endsOn` live at the medication level
 *
 * The components themselves are layer-agnostic. They emit / receive
 * structured values; the wizard / form maps them to the wire format.
 */

/**
 * The eight cadence kinds the wizard exposes. Maps to the engine's
 * dispatch tiers in `src/lib/medications/scheduling/recurrence.ts`:
 *
 *   - `daily` / `weekdays` / `everyNWeeks` / `monthly` / `everyNMonths`
 *     / `yearly` → RRULE branch
 *   - `rolling` → `rollingIntervalDays` branch
 *   - `oneShot` → one-shot branch
 */
export type CadenceKind =
  | "daily"
  | "weekdays"
  | "everyNWeeks"
  | "monthly"
  | "everyNMonths"
  | "yearly"
  | "rolling"
  | "oneShot";

export interface CadenceValue {
  kind: CadenceKind;
  /**
   * RRULE string when the kind is calendar-anchored (daily / weekdays
   * / everyNWeeks / monthly / everyNMonths / yearly). NULL for rolling
   * and oneShot.
   */
  rrule: string | null;
  /** Rolling interval in days when the kind is rolling. NULL otherwise. */
  rollingIntervalDays: number | null;
  /** Marks the medication as a single-administration course. */
  oneShot: boolean;
}

/**
 * Internal sub-controls state. Kept on the picker as a single object
 * so the parent only deals with the encoded `CadenceValue` while the
 * picker remembers what the user typed if they toggle radios back +
 * forth. Exported for the unit tests that pin the encoder mapping.
 */
export interface CadenceSubControls {
  /** Selected weekdays (RFC 5545 BYDAY tokens). */
  weekdays: WeekdayToken[];
  /** Multi-week interval (1..52). */
  intervalWeeks: number;
  /** Day-of-month (1..31) for monthly + everyNMonths. */
  dayOfMonth: number;
  /** Multi-month interval (1..12) for everyNMonths. */
  intervalMonths: number;
  /** ISO YYYY-MM-DD for the yearly anchor (month + day extracted). */
  yearlyDate: string;
  /** Rolling cadence interval in days (1..365). */
  rollingDays: number;
}

/** RFC 5545 BYDAY tokens — the order the chip row renders. */
export const WEEKDAY_TOKENS = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
] as const;
export type WeekdayToken = (typeof WEEKDAY_TOKENS)[number];

/** Sensible defaults so a brand-new picker has valid sub-controls. */
export const DEFAULT_SUB_CONTROLS: CadenceSubControls = {
  weekdays: ["MO"],
  intervalWeeks: 2,
  dayOfMonth: 1,
  intervalMonths: 3,
  yearlyDate: "",
  rollingDays: 7,
};
