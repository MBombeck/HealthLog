/**
 * Glucose Observations: the per-context reading and the clinical panel
 * (time-in-range, mean, GMI, estimated A1C, variability) the one
 * literature-locked engine computes for the report period.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  resolveGlucoseUnit,
  convertGlucose,
  type GlucoseUnit,
} from "@/lib/glucose";
import {
  LOINC_SYSTEM,
  GLUCOSE_LOINC,
  GLUCOSE_TIR_LOINC,
  GLUCOSE_GMI_LOINC,
  GLUCOSE_MEAN_LOINC,
} from "@/lib/fhir/loinc-map";
import { ucumQuantity } from "@/lib/fhir/ucum";
import type { FhirObservation } from "@/lib/fhir/types";
import {
  categoryConcept,
  patientRef,
  reportingPeriod,
} from "@/lib/fhir/resources/common";
import { ownValue } from "@/lib/own-key";

/**
 * The time-in-range band, stated in the unit the reader uses. The band itself
 * is fixed at 70–180 mg/dL [Battelino 2019]; only its presentation converts,
 * exactly as the sibling mean-glucose value does. Printing "70–180 mg/dL" to a
 * mmol/L reader hands them a number they cannot compare against their own.
 */
function timeInRangeDisplay(unit: GlucoseUnit): string {
  const low = convertGlucose(70, unit);
  const high = convertGlucose(180, unit);
  return `Glucose time in range (${low}–${high} ${unit})`;
}

/**
 * One Observation per recorded glucose context, valued in the user's display
 * unit. The value is the context's LATEST reading but the code is a context
 * summary, so it carries the reporting period rather than a reading instant.
 */
export function glucoseContextObservations(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  const observations: FhirObservation[] = [];
  for (const [ctx, stat] of Object.entries(data.glucoseStats)) {
    const map = ownValue(GLUCOSE_LOINC, ctx);
    if (!map) continue;
    observations.push({
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept("laboratory")],
      code: {
        coding: [
          { system: LOINC_SYSTEM, code: map.loinc, display: map.display },
        ],
        text: map.display,
      },
      subject: patientRef,
      effectivePeriod: reportingPeriod(data),
      valueQuantity: ucumQuantity(
        convertGlucose(stat.latest, glucoseUnit),
        glucoseUnit,
      ),
    });
  }
  return observations;
}

/**
 * The clinical glucose panel (v1.18.0). Emitted only when readings exist — the
 * aggregator zeroes the panel when the glucose module is off, so an absent
 * panel means the module is off OR there is no data. Each metric carries its
 * published LOINC where one exists; the coefficient of variation has none and
 * rides a `survey` text-only concept.
 */
export function glucoseClinicalObservations(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const clinical = data.glucoseClinical;
  if (!clinical || clinical.readingCount <= 0) return [];

  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  const period = reportingPeriod(data);
  const observations: FhirObservation[] = [];

  const push = (opts: {
    /** LOINC code and its LOINC display; absent for a text-only concept. */
    loinc?: { code: string; display: string };
    text: string;
    value: number;
    unit: string;
    survey?: boolean;
  }) => {
    observations.push({
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept(opts.survey ? "survey" : "laboratory")],
      code: opts.loinc
        ? {
            coding: [
              {
                system: LOINC_SYSTEM,
                code: opts.loinc.code,
                display: opts.loinc.display,
              },
            ],
            text: opts.text,
          }
        : { text: opts.text },
      subject: patientRef,
      effectivePeriod: period,
      valueQuantity: ucumQuantity(opts.value, opts.unit),
      ...(clinical.isSpotEstimate
        ? {
            note: [
              {
                text: "Spot-reading estimate from individual measurements, not a continuous-monitor profile.",
              },
            ],
          }
        : {}),
    });
  };

  if (clinical.distribution) {
    push({
      loinc: {
        code: GLUCOSE_TIR_LOINC,
        display:
          "Glucose measurements in range out of Total glucose measurements during reporting period",
      },
      text: timeInRangeDisplay(glucoseUnit),
      value: Math.round(clinical.distribution.tir * 1000) / 10,
      unit: "%",
    });
  }
  if (clinical.meanMgdl !== null) {
    // 97507-8 is the mean of interstitial glucose in mass/volume. Only a
    // continuous stream (not a spot estimate, by reading density) is
    // interstitial, so only that mean carries the code, and it goes out in
    // mg/dL: the canonical unit the mean is computed in, so no conversion is
    // involved. A spot-reading mean stays text-only in the display unit.
    if (clinical.isSpotEstimate) {
      push({
        text: "Mean glucose",
        value: convertGlucose(clinical.meanMgdl, glucoseUnit),
        unit: glucoseUnit,
      });
    } else {
      push({
        loinc: {
          code: GLUCOSE_MEAN_LOINC,
          display:
            "Average glucose [Mass/volume] in Interstitial fluid during Reporting Period",
        },
        text: "Mean glucose",
        value: convertGlucose(clinical.meanMgdl, "mg/dL"),
        unit: "mg/dL",
      });
    }
  }
  if (clinical.gmi !== null) {
    push({
      loinc: {
        code: GLUCOSE_GMI_LOINC,
        display: "Glucose management indicator",
      },
      text: "Glucose Management Indicator (GMI)",
      value: Math.round(clinical.gmi * 10) / 10,
      unit: "%",
    });
  }
  if (clinical.estimatedA1c !== null) {
    push({
      // Text-only: no LOINC term exists for an A1C estimated from mean
      // glucose (see `loinc-map.ts`).
      text: "Estimated A1C",
      value: Math.round(clinical.estimatedA1c * 10) / 10,
      unit: "%",
    });
  }
  if (clinical.variability !== null) {
    push({
      text: "Glucose variability (coefficient of variation)",
      value: Math.round(clinical.variability.cv * 10) / 10,
      unit: "%",
      survey: true,
    });
  }

  return observations;
}
