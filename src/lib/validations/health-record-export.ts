/**
 * v1.7.0 — health-record / doctor-handover export selection.
 *
 * Single strict Zod schema driving `POST /api/export/health-record`. The
 * flagship export route fails loudly on bad input (unlike the legacy
 * doctor-report route which tolerates drift) — `.strict()` rejects unknown
 * keys, and there is intentionally NO `userId` field (the user is always
 * narrowed from `requireAuth()`, never accepted from the body).
 *
 * The grouped `sections` shape is additive over the flat
 * `DoctorReportPrefs` used by the aggregator + PDF renderer. The
 * `toDoctorReportPrefs()` helper folds the grouped toggles down to the
 * flat shape the aggregator consumes, so PDF and FHIR describe identical
 * numbers (the source-of-truth property the two PDF endpoints share).
 */
import { z } from "zod/v4";
import { locales } from "@/lib/i18n/config";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";

/** Grouped vital toggles. */
const vitalsGroupSchema = z
  .object({
    weight: z.boolean(),
    bp: z.boolean(),
    pulse: z.boolean(),
    oxygenSaturation: z.boolean(),
    bodyFat: z.boolean(),
    bodyComposition: z.boolean(),
  })
  .partial();

const cardioFitnessGroupSchema = z
  .object({
    restingHeartRate: z.boolean(),
    hrv: z.boolean(),
    vo2max: z.boolean(),
  })
  .partial();

const activityGroupSchema = z
  .object({
    steps: z.boolean(),
    distance: z.boolean(),
    energy: z.boolean(),
    sleep: z.boolean(),
  })
  .partial();

const medicationsGroupSchema = z
  .object({
    list: z.boolean(),
    compliance: z.boolean(),
    glp1: z.boolean(),
    sideEffects: z.boolean(),
  })
  .partial();

/**
 * Grouped section toggles. Every group + key is optional so a partial
 * payload (the user flipped one checkbox) doesn't have to re-state the
 * whole tree. Missing keys resolve to the documented defaults.
 */
export const exportSectionsSchema = z
  .object({
    vitals: vitalsGroupSchema,
    cardioFitness: cardioFitnessGroupSchema,
    activity: activityGroupSchema,
    glucose: z.boolean(),
    medications: medicationsGroupSchema,
    mood: z.boolean(),
    bmi: z.boolean(),
  })
  .partial();

export type ExportSections = z.infer<typeof exportSectionsSchema>;

/**
 * Flagship export selection. `.strict()` so unknown keys (including any
 * attempt to smuggle a `userId`) 422 via `returnAllZodIssues`.
 */
export const exportSelectionSchema = z
  .object({
    format: z.enum(["pdf", "fhir", "package"]),
    range: z
      .object({
        startDate: z.iso.datetime({ offset: true }).optional(),
        endDate: z.iso.datetime({ offset: true }).optional(),
        days: z.number().int().min(1).max(365).optional(),
      })
      .strict()
      .optional(),
    sections: exportSectionsSchema.optional(),
    locale: z.enum(locales).optional(),
    practiceName: z.string().max(120).optional(),
    includeCharts: z.boolean().optional(),
    includeAiSummary: z.boolean().optional(),
  })
  .strict();

export type ExportSelection = z.infer<typeof exportSelectionSchema>;

/**
 * Fold the grouped selection down to the flat `DoctorReportPrefs` the
 * aggregator + PDF renderer consume. A group toggle that is `true` (or
 * absent, falling back to the section default) flips the matching flat
 * flag. Mood stays privacy-default-OFF: it only flips on when the caller
 * explicitly set `sections.mood = true`.
 */
export function toDoctorReportPrefs(
  sections: ExportSections | undefined,
): DoctorReportPrefs {
  const s = sections ?? {};
  const v = s.vitals ?? {};
  const a = s.activity ?? {};
  const m = s.medications ?? {};

  const fallback = DEFAULT_DOCTOR_REPORT_PREFS;
  return {
    weight: v.weight ?? fallback.weight,
    bp: v.bp ?? fallback.bp,
    pulse: v.pulse ?? fallback.pulse,
    bmi: s.bmi ?? fallback.bmi,
    // Mood is opt-in: only true when explicitly requested.
    mood: s.mood === true,
    compliance: m.compliance ?? m.list ?? fallback.compliance,
    sleep: a.sleep ?? fallback.sleep,
  };
}
