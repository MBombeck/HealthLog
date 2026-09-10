/**
 * v1.7.0 — HealthLog `MeasurementType` → FHIR R4 coding (LOINC + UCUM).
 *
 * Per the R-export spec table (§4.2). Types without a stable LOINC fall
 * back to a local `text`-only `CodeableConcept` with the UCUM unit, and
 * the absence of a `loinc` code documents that at the call site.
 *
 * BP is handled specially by the builder (panel 85354-9 with sys/dia
 * components 8480-6 / 8462-4), so the two BP component types are NOT in
 * this single-value map.
 */
import { deriveMeasurementLoinc } from "@/lib/signals/adapters/fhir";

export const LOINC_SYSTEM = "http://loinc.org";
export const UCUM_SYSTEM = "http://unitsofmeasure.org";
/**
 * Shared custom CodeSystem for HealthKit placeholder metrics that have no
 * published LOINC term. A non-LOINC code under `http://loinc.org` is a FHIR
 * conformance violation, so these route here instead. Byte-aligned with the
 * iOS exporter (confirmed 2026-06-01) — both clients emit the identical
 * `system` + raw `HKQuantityTypeIdentifier…` `code`.
 */
export const HEALTHKIT_CODESYSTEM =
  "https://healthlog.dev/fhir/CodeSystem/healthkit";

export type FhirObservationCategory =
  | "vital-signs"
  | "laboratory"
  | "activity"
  // v1.25 — patient-reported screener / questionnaire observations (PHQ-9 /
  // GAD-7 totals, pain NRS). The builder already emits a `survey` category for
  // the descriptive wellness composites; `categoryConcept` takes any string.
  | "survey";

export interface LoincMapping {
  /** LOINC code, or null when no stable LOINC applies (local text fallback). */
  loinc: string | null;
  display: string;
  /** UCUM unit string (also used as the `code`). */
  unit: string;
  category: FhirObservationCategory;
}

/**
 * Single-value measurement-type mapping. Keyed by `MeasurementType` enum
 * string. BP components are intentionally absent (the builder emits a BP
 * panel). Glucose is handled per-context by the builder using
 * `GLUCOSE_LOINC`.
 */
export const MEASUREMENT_LOINC: Record<string, LoincMapping> =
  deriveMeasurementLoinc();

/** BP panel + component LOINC codes. */
export const BP_PANEL_LOINC = "85354-9";
export const BP_SYS_LOINC = "8480-6";
export const BP_DIA_LOINC = "8462-4";
export const BP_UNIT = "mm[Hg]";

/**
 * Per-context glucose LOINC, byte-aligned to the iOS table:
 * - random / unspecified / bedtime → 2339-0 (Glucose in Blood)
 * - fasting / beforeMeal           → 1558-6 (Fasting glucose in Serum/Plasma)
 * - afterMeal (POSTPRANDIAL)        → 1521-4 (Glucose in Serum/Plasma 2h post meal)
 *
 * The server's `GlucoseContext` enum has no separate beforeMeal/afterMeal; its
 * POSTPRANDIAL value is the afterMeal case and maps to 1521-4.
 */
export const GLUCOSE_LOINC: Record<string, { loinc: string; display: string }> =
  {
    FASTING: {
      loinc: "1558-6",
      display: "Fasting glucose [Mass/volume] in Serum or Plasma",
    },
    POSTPRANDIAL: {
      loinc: "1521-4",
      display: "Glucose [Mass/volume] in Serum or Plasma --2 hours post meal",
    },
    RANDOM: { loinc: "2339-0", display: "Glucose [Mass/volume] in Blood" },
    BEDTIME: { loinc: "2339-0", display: "Glucose [Mass/volume] in Blood" },
    // #943 — the untagged bucket. Already named in the table above; without
    // the entry the exported bundle silently dropped every reading whose
    // source recorded no meal time.
    UNSPECIFIED: { loinc: "2339-0", display: "Glucose [Mass/volume] in Blood" },
  };

/* ── Clinical glucose-panel LOINCs (v1.18.0) ───────────────────────────
 * The CGM/spot-reading composite metrics the doctor report computes by the
 * one literature-locked engine. Each carries the published LOINC term where
 * one exists; the variability CV% has no published LOINC and is emitted as a
 * survey-category text-only concept by the builder (honest about what we have).
 */
/** Time in range 70–180 mg/dL [Battelino 2019]. */
export const GLUCOSE_TIR_LOINC = "97510-2";
/** Glucose Management Indicator (GMI) [Bergenstal 2018]. */
export const GLUCOSE_GMI_LOINC = "97506-0";
/** Mean glucose over the reporting period. */
export const GLUCOSE_MEAN_LOINC = "97507-8";
/** Estimated A1C (ADAG, derived from mean glucose). */
export const GLUCOSE_EA1C_LOINC = "41995-2";

/** Medication-adherence Observation LOINC. */
export const MEDICATION_ADHERENCE_LOINC = "71799-1";
/** Mood Observation LOINC (opt-in only). */
export const MOOD_LOINC = "76542-6";

/* ── Cycle / reproductive-health LOINCs (v1.15.0, opt-in only) ──────── */
/** Last menstrual period (LMP) start date. */
export const LMP_LOINC = "8665-2";
/** Menstrual cycle length [time]. */
export const CYCLE_LENGTH_LOINC = "64700-8";
/** Length of menses (period / bleeding duration). */
export const PERIOD_LENGTH_LOINC = "64698-4";
