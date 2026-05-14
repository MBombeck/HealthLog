/**
 * v1.4.25 W6c — per-user Doctor-Report section toggles.
 *
 * Persisted as a Json blob on `User.doctorReportPrefsJson`. Null = the
 * documented defaults (every section ON except mood). The dialog reads
 * the row, lets the user flip checkboxes, and writes the chosen shape
 * back. The PDF generator + the report aggregator both consult the
 * shape: aggregator drops mood data entirely when `mood = false` so the
 * data never leaves the DB row (privacy-by-default), and the generator
 * skips each section whose flag is false at render time.
 *
 * The shape is intentionally additive — every new data type added to the
 * report grows the schema with a new optional flag and a new entry in
 * `DEFAULT_DOCTOR_REPORT_PREFS`. Forward-compat: an unknown / drifted
 * shape falls back to defaults rather than throwing.
 */
import { z } from "zod/v4";

/**
 * Section toggle schema. Every key is optional so a partial update from
 * the dialog (e.g., "the user only flipped mood") doesn't have to
 * re-state every other flag. The route layer fills missing keys from the
 * defaults before persisting so the column shape stays stable.
 */
export const doctorReportPrefsSchema = z
  .object({
    bp: z.boolean(),
    weight: z.boolean(),
    pulse: z.boolean(),
    bmi: z.boolean(),
    mood: z.boolean(),
    compliance: z.boolean(),
    sleep: z.boolean(),
  })
  .partial();

export type DoctorReportPrefsInput = z.infer<typeof doctorReportPrefsSchema>;

/**
 * Fully-resolved section toggles. Every key required so the consumers
 * (PDF renderer + aggregator) don't have to thread an "is this key
 * present?" check through their render paths.
 */
export interface DoctorReportPrefs {
  bp: boolean;
  weight: boolean;
  pulse: boolean;
  bmi: boolean;
  mood: boolean;
  compliance: boolean;
  sleep: boolean;
}

/**
 * Defaults applied when the user has never opened the dialog. Every
 * section is ON by default EXCEPT mood, which is opt-in per Marc's
 * privacy directive (2026-05-14): mental-health data should never appear
 * in a clinical PDF the user didn't explicitly check.
 */
export const DEFAULT_DOCTOR_REPORT_PREFS: DoctorReportPrefs = {
  bp: true,
  weight: true,
  pulse: true,
  bmi: true,
  mood: false, // privacy default per Marc
  compliance: true,
  sleep: true,
};

/**
 * Parse a row's `doctorReportPrefsJson` Json blob into a typed
 * `DoctorReportPrefs`, falling back to the documented defaults when the
 * row is null OR the persisted shape has drifted (a forward-compat field
 * rename, an admin-side hand-edit, etc.). Missing keys are filled from
 * the defaults so callers always get a fully-resolved object.
 */
export function parseDoctorReportPrefs(raw: unknown): DoctorReportPrefs {
  if (raw == null) return { ...DEFAULT_DOCTOR_REPORT_PREFS };
  const parsed = doctorReportPrefsSchema.safeParse(raw);
  if (!parsed.success) return { ...DEFAULT_DOCTOR_REPORT_PREFS };
  return {
    ...DEFAULT_DOCTOR_REPORT_PREFS,
    ...parsed.data,
  };
}

/**
 * Resolve a partial input (typically from a PUT body) into the full
 * canonical shape, layering the supplied keys over the current
 * persisted row (or defaults when null). Keeps the route layer free of
 * merge plumbing.
 */
export function resolveDoctorReportPrefs(
  current: unknown,
  incoming: DoctorReportPrefsInput,
): DoctorReportPrefs {
  const base = parseDoctorReportPrefs(current);
  return { ...base, ...incoming };
}
