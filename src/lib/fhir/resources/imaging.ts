/**
 * Imaging exams as FHIR R4 (#1672).
 *
 * One `DiagnosticReport` per exam, category `RAD` (HL7 v2-0074 Radiology),
 * code LOINC 18748-4 "Diagnostic imaging study" with the modality, body part
 * and side as text, `effectiveDateTime` the exam day, the facility as a
 * display-only performer and the person's own summary as `conclusion`. The
 * requesting doctor rides the narrative of the code text only when nothing
 * else names the exam. No `ImagingStudy`: there are no DICOM series here, only
 * the report and pictures the person filed, which stay in the vault.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { LOINC_SYSTEM } from "@/lib/fhir/loinc-map";
import { patientRef } from "@/lib/fhir/resources/common";
import type {
  FhirDiagnosticReport,
  FhirNarrative,
  FhirReference,
} from "@/lib/fhir/types";

const MODALITY_TEXT: Record<string, string> = {
  MRI: "MRI",
  CT: "CT",
  X_RAY: "X-ray",
  ULTRASOUND: "Ultrasound",
  MAMMOGRAPHY: "Mammography",
  OTHER: "Imaging",
};

const SIDE_TEXT: Record<string, string> = {
  LEFT: "left",
  RIGHT: "right",
  BOTH: "both sides",
};

export function imagingReportsFromReportData(
  data: Pick<DoctorReportData, "imagingExams">,
): FhirDiagnosticReport[] {
  return (data.imagingExams ?? []).map((exam, i) => {
    const text = [
      MODALITY_TEXT[exam.modality] ?? MODALITY_TEXT.OTHER,
      exam.bodyPart,
      exam.side ? SIDE_TEXT[exam.side] : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      resourceType: "DiagnosticReport",
      id: `imaging-${i + 1}`,
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v2-0074",
              code: "RAD",
              display: "Radiology",
            },
          ],
        },
      ],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: "18748-4",
            display: "Diagnostic imaging study",
          },
        ],
        text,
      },
      subject: patientRef,
      effectiveDateTime: exam.performedAt.slice(0, 10),
      ...(exam.facility ? { performer: [{ display: exam.facility }] } : {}),
      ...(exam.conclusion ? { conclusion: exam.conclusion } : {}),
    };
  });
}

export function imagingCompositionSection(
  entry: FhirReference[],
): Array<{ title: string; text: FhirNarrative; entry: FhirReference[] }> {
  if (entry.length === 0) return [];
  return [
    {
      title: "Imaging",
      text: {
        status: "generated",
        div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">Imaging exams as recorded by the patient. The conclusion is the patient's own summary, not the radiologist's report.</div>",
      },
      entry,
    },
  ];
}
