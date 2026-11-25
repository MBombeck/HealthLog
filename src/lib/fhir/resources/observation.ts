/**
 * The Observation orchestrator: one array, one continuous `obs-N` sequence,
 * in the canonical order — one latest reading per measurement type, the
 * blood-pressure panel, the computed BMI, glucose per context, the clinical
 * glucose panel, labs, medication adherence, the opt-in mood average, then the
 * descriptive wellness composites under `survey`.
 *
 * The per-domain blocks (glucose, labs) live in their own modules and draw ids
 * from the SAME allocator, so a document builder's references stay stable and a
 * `searchset` caller can filter the array by `category` / `code` without
 * re-numbering.
 */
import {
  adherenceRatePercent,
  type DoctorReportData,
} from "@/lib/doctor-report-data";
import {
  LOINC_SYSTEM,
  MEASUREMENT_LOINC,
  BP_PANEL_LOINC,
  BP_SYS_LOINC,
  BP_DIA_LOINC,
  BP_UNIT,
  MEDICATION_ADHERENCE_LOINC,
} from "@/lib/fhir/loinc-map";
import { ucumQuantity } from "@/lib/fhir/ucum";
import type { FhirObservation } from "@/lib/fhir/types";
import {
  categoryConcept,
  codeableFromMapping,
  latestReading,
  observationIdSequence,
  patientRef,
  reportingPeriod,
} from "@/lib/fhir/resources/common";
import {
  glucoseClinicalObservations,
  glucoseContextObservations,
} from "@/lib/fhir/resources/glucose";
import { labObservations } from "@/lib/fhir/resources/labs";
import { ownValue } from "@/lib/own-key";
import { recoverySourceLabelEn } from "@/lib/scores/registry";

/** v1.10.0 — English display per persisted wellness-score type (FHIR
 *  text-only concept; the score has no published LOINC term). */
const WELLNESS_SCORE_DISPLAY: Record<string, string> = {
  RECOVERY_SCORE: "Recovery score",
  STRESS_SCORE: "Stress score",
  STRAIN_SCORE: "Strain score",
};

/** One latest reading per single-value measurement type. */
function measurementObservations(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const observations: FhirObservation[] = [];
  for (const [type, mapping] of Object.entries(MEASUREMENT_LOINC)) {
    // BMI is emitted once by the computed-BMI block below (matching the PDF's
    // BMI line); skip the stored BODY_MASS_INDEX series here to avoid a
    // duplicate Observation.
    if (type === "BODY_MASS_INDEX") continue;
    const reading = latestReading(data, type);
    if (!reading) continue;
    // SLEEP_DURATION is stored in MINUTES; the iOS-locked UCUM unit is `h`, so
    // emit the value in hours to keep value and unit consistent. The PDF reads
    // the raw series independently and is unaffected.
    const value =
      type === "SLEEP_DURATION"
        ? Math.round((reading.value / 60) * 100) / 100
        : reading.value;
    observations.push({
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept(mapping.category)],
      code: codeableFromMapping(mapping),
      subject: patientRef,
      effectiveDateTime: reading.measuredAt,
      // The registry's display unit is only stamped as a UCUM `code` when it
      // IS one — `dB[A]` reads as decibels to a person and as nothing to a
      // UCUM parser.
      valueQuantity: ucumQuantity(value, mapping.unit),
    });
  }
  return observations;
}

/** The blood-pressure panel, present only when both components have a reading. */
function bloodPressureObservation(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const sys = latestReading(data, "BLOOD_PRESSURE_SYS");
  const dia = latestReading(data, "BLOOD_PRESSURE_DIA");
  if (!sys || !dia) return [];
  return [
    {
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept("vital-signs")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: BP_PANEL_LOINC,
            display: "Blood pressure panel with all children optional",
          },
        ],
        text: "Blood pressure",
      },
      subject: patientRef,
      // Use the systolic reading's timestamp as the panel effective time.
      effectiveDateTime: sys.measuredAt,
      component: [
        {
          code: {
            coding: [
              {
                system: LOINC_SYSTEM,
                code: BP_SYS_LOINC,
                display: "Systolic blood pressure",
              },
            ],
          },
          valueQuantity: ucumQuantity(sys.value, BP_UNIT),
        },
        {
          code: {
            coding: [
              {
                system: LOINC_SYSTEM,
                code: BP_DIA_LOINC,
                display: "Diastolic blood pressure",
              },
            ],
          },
          valueQuantity: ucumQuantity(dia.value, BP_UNIT),
        },
      ],
    },
  ];
}

/** The computed BMI, matching the PDF's BMI line. */
function bmiObservation(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  if (data.bmi === null || data.bmi === undefined) return [];
  return [
    {
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept("vital-signs")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: "39156-5",
            display: "Body mass index (BMI) [Ratio]",
          },
        ],
        text: "Body mass index (BMI) [Ratio]",
      },
      subject: patientRef,
      effectivePeriod: reportingPeriod(data),
      valueQuantity: ucumQuantity(data.bmi, "kg/m2"),
    },
  ];
}

/** One adherence rate per medication with a scheduled dose in the window. */
function adherenceObservations(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const observations: FhirObservation[] = [];
  const period = reportingPeriod(data);
  for (const comp of Object.values(data.compliance)) {
    if (comp.total <= 0) continue;
    // Integer percent — the one canonical rounding the app card + PDF use, so
    // a clinician sees the same adherence figure on every surface. The helper
    // returns null exactly when nothing was expected, and a `?? 0` here would
    // put a clinical claim of 0 % adherence into an exported bundle in that
    // case. The `total <= 0` guard above already means it cannot happen; skip
    // rather than coalesce so it stays impossible if that guard ever moves.
    const rate = adherenceRatePercent(comp.taken, comp.total);
    if (rate === null) continue;
    observations.push({
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept("activity")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: MEDICATION_ADHERENCE_LOINC,
            display:
              "Adherence to prescribed medication instructions [Reported]",
          },
        ],
        text: `Medication adherence — ${comp.name}`,
      },
      subject: patientRef,
      effectivePeriod: period,
      valueQuantity: ucumQuantity(rate, "%"),
    });
  }
  return observations;
}

/**
 * The opt-in mood average; absent when the toggle is off.
 *
 * Text-only, under `survey`: LOINC has no term for a self-rated mood score
 * averaged over a period (76542-6, used before, does not exist in LOINC), and
 * a mood score is not a vital sign, so it must not ride the vital-signs panel.
 */
function moodObservation(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  if (!data.mood) return [];
  return [
    {
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept("survey")],
      code: { text: "Mood (average over period)" },
      subject: patientRef,
      effectivePeriod: reportingPeriod(data),
      valueQuantity: ucumQuantity(
        Math.round(data.mood.avg * 10) / 10,
        "{score}",
      ),
    },
  ];
}

/**
 * v1.10.0 — the server-derived nightly scores (recovery / stress / strain).
 * They have no published LOINC term and are NOT clinical findings, so each is
 * emitted under the `survey` category with a text-only concept and an explicit
 * "descriptive, not a clinical assessment" note — a physician's FHIR viewer
 * never mistakes a band for a diagnosis. Absent when the aggregator emitted no
 * scores.
 */
function wellnessObservations(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const observations: FhirObservation[] = [];
  for (const s of data.wellnessScores ?? []) {
    observations.push({
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept("survey")],
      // A recovery row carries one source; it is named by it, so a device's
      // recovery and HealthLog's readiness never read as one series.
      code: {
        text:
          s.type === "RECOVERY_SCORE" && s.source
            ? recoverySourceLabelEn(s.source)
            : (ownValue(WELLNESS_SCORE_DISPLAY, s.type) ?? "Wellness score"),
      },
      subject: patientRef,
      effectiveDateTime: s.latestAt,
      valueQuantity: ucumQuantity(s.latest, "{score}"),
      note: [
        {
          text:
            s.scaleMax && s.scaleMax !== 100
              ? `Device score on the vendor's 1-${s.scaleMax} scale; not a clinical assessment or diagnosis.`
              : "Descriptive wellness score (0–100) computed from tracked signals; not a clinical assessment or diagnosis.",
        },
      ],
    });
  }
  return observations;
}

/**
 * Emit every `Observation` from the aggregated report data, in the canonical
 * order.
 */
export function observationsFromReportData(
  data: DoctorReportData,
): FhirObservation[] {
  const nextId = observationIdSequence();
  return [
    ...measurementObservations(data, nextId),
    ...bloodPressureObservation(data, nextId),
    ...bmiObservation(data, nextId),
    ...glucoseContextObservations(data, nextId),
    ...glucoseClinicalObservations(data, nextId),
    ...labObservations(data, nextId),
    ...adherenceObservations(data, nextId),
    ...moodObservation(data, nextId),
    ...wellnessObservations(data, nextId),
  ];
}
