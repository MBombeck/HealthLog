/**
 * Lab-result Observations (v1.17.1; LOINC + UCUM v1.18.8).
 *
 * One `laboratory` Observation per recorded analyte. `analyte` + `unit` are
 * user-recorded free text (no closed LOINC enum). A curated analyte→LOINC map
 * (`resolveLabCoding`) adds a real LOINC `coding` ALONGSIDE the user's
 * `code.text` for the common biomarkers, and stamps the canonical UCUM `code`
 * on the value WHEN the recorded unit matches the mapped canonical symbol. An
 * analyte that does NOT resolve keeps the honest text-only `code` +
 * display-only `unit` (no fabricated terminology).
 *
 * The reference bounds map onto R4 `referenceRange`, and they are the SAME
 * bounds the app's own verdict uses: the window the reading's source report
 * printed when it carries one, the catalog band otherwise, already resolved
 * upstream in `loadLabResults`. When the source report stated its window in
 * words the bounds could not be read from ("negativ", "siehe Befund"), that
 * string rides on `referenceRange.text` so a receiver still gets what the lab
 * wrote rather than a silently empty element.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { LOINC_SYSTEM, UCUM_SYSTEM } from "@/lib/fhir/loinc-map";
import { resolveLabCoding } from "@/lib/fhir/lab-loinc";
import { qualitativeValueConcept } from "@/lib/fhir/lab-qualitative";
import {
  DIMENSIONLESS_UNIT,
  isDimensionlessUnit,
} from "@/lib/labs/dimensionless";

import type {
  FhirObservation,
  FhirObservationReferenceRange,
} from "@/lib/fhir/types";
import { categoryConcept, patientRef } from "@/lib/fhir/resources/common";

export function labObservations(
  data: DoctorReportData,
  nextId: () => string,
): FhirObservation[] {
  const observations: FhirObservation[] = [];

  for (const lab of data.labResults ?? []) {
    // `analyte` is the marker's own name (v1.43): readings of one biomarker
    // are one Observation whatever each report printed, so two spellings
    // merged into one marker never reach a receiver as two analytes.
    const coding = resolveLabCoding(lab.analyte, lab.unit);
    const text = lab.panel ? `${lab.analyte} (${lab.panel})` : lab.analyte;
    const code = coding
      ? {
          coding: [
            {
              system: LOINC_SYSTEM,
              code: coding.loinc,
              display: coding.display,
            },
          ],
          text,
        }
      : { text };

    // v1.18.9 — a qualitative result (`value === null`) emits a
    // `valueCodeableConcept` (SNOMED qualifier value when confidently known,
    // else text-only) and NO `valueQuantity` / `referenceRange` — bounds are
    // meaningless for it. A numeric result keeps the established
    // valueQuantity + LOINC/UCUM path.
    if (lab.value === null) {
      const valueText = lab.valueText?.trim() ?? "";
      // A row with neither a number nor a result term states nothing. An
      // Observation whose only value is an empty concept is worse than no
      // Observation: it asserts a result was recorded and then withholds it.
      if (valueText === "") continue;
      observations.push({
        resourceType: "Observation",
        id: nextId(),
        status: "final",
        category: [categoryConcept("laboratory")],
        code,
        subject: patientRef,
        effectiveDateTime: lab.takenAt,
        valueCodeableConcept: qualitativeValueConcept(valueText),
      });
      continue;
    }

    // A lab quantity: the recorded `unit` is always the display string, and
    // the canonical UCUM `code` is stamped only when the analyte map resolved
    // one for exactly that unit (no coerced symbol).
    // The `system` rides along WITH the code and never alone: naming UCUM as
    // the code system while withholding the code claims a coding the bundle
    // does not carry, and leaves a receiver unable to machine-compare the
    // value it is attached to.
    // A value without a unit is the UCUM unity by definition, so it carries
    // the code even for an analyte the map does not know.
    const ucum = isDimensionlessUnit(lab.unit)
      ? DIMENSIONLESS_UNIT
      : coding?.ucum;
    const quantity = (value: number) => ({
      value,
      unit: lab.unit,
      ...(ucum ? { system: UCUM_SYSTEM, code: ucum } : {}),
    });
    // The bounds are stated in the SAME unit as the value, so they carry the
    // SAME coding — a bare unit beside a coded value leaves a receiver unable
    // to compare the two.
    const sourceText =
      lab.referenceOrigin === "source" ? lab.sourceReferenceText : null;
    const hasBounds = lab.referenceLow !== null || lab.referenceHigh !== null;
    const referenceRange: FhirObservationReferenceRange[] | undefined =
      hasBounds || sourceText
        ? [
            {
              ...(lab.referenceLow !== null
                ? { low: quantity(lab.referenceLow) }
                : {}),
              ...(lab.referenceHigh !== null
                ? { high: quantity(lab.referenceHigh) }
                : {}),
              ...(sourceText ? { text: sourceText } : {}),
            },
          ]
        : undefined;

    observations.push({
      resourceType: "Observation",
      id: nextId(),
      status: "final",
      category: [categoryConcept("laboratory")],
      code,
      subject: patientRef,
      effectiveDateTime: lab.takenAt,
      valueQuantity: quantity(lab.value),
      ...(referenceRange ? { referenceRange } : {}),
    });
  }

  return observations;
}
