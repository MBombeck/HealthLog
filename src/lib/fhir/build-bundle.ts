/**
 * v1.7.0 — HL7 FHIR R4 document-Bundle builder for the health-record export.
 *
 * Pure function: takes the SAME `DoctorReportData` the PDF renderer consumes
 * (assembled by `collectDoctorReportData`) plus the decrypted patient
 * identity, and emits a `Bundle` of `type: "document"` — a leading
 * `Composition` "cover page", the `Patient`, then one `Observation` per
 * selected vital / glucose context / mood + one `MedicationStatement` per
 * active medication.
 *
 * Because it reuses the PDF aggregator, the FHIR export and the PDF describe
 * identical numbers by construction (the source-of-truth property the two
 * PDF endpoints already share).
 *
 * No FHIR SDK, no `@types/fhir` — narrow hand-rolled interfaces only
 * (`./types`), matching the project's "hand-rolled over the documented wire"
 * convention. The `Composition.text` narrative is escaped plain text, never
 * user-supplied HTML (no markdown library, no `dangerouslySetInnerHTML`).
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { resolveGlucoseUnit, convertGlucose } from "@/lib/glucose";
import {
  LOINC_SYSTEM,
  UCUM_SYSTEM,
  MEASUREMENT_LOINC,
  BP_PANEL_LOINC,
  BP_SYS_LOINC,
  BP_DIA_LOINC,
  BP_UNIT,
  GLUCOSE_LOINC,
  MEDICATION_ADHERENCE_LOINC,
  MOOD_LOINC,
  type LoincMapping,
} from "@/lib/fhir/loinc-map";
import type {
  FhirBundle,
  FhirBundleEntry,
  FhirCodeableConcept,
  FhirObservation,
  FhirMedicationStatement,
  FhirPatient,
  FhirComposition,
  FhirDiagnosticReport,
  FhirReference,
  FhirResource,
} from "@/lib/fhir/types";

/** Patient identity not carried in `DoctorReportData` (KVNR is encrypted). */
export interface FhirPatientIdentity {
  /** German KVNR (decrypted by the route). */
  insuranceNumber: string | null;
}

/** KVNR identifier namespace per the gematik SID. */
const KVNR_SYSTEM = "http://fhir.de/sid/gkv/kvid-10";

/** Escape the five XML-significant characters for the xhtml narrative. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function codeableFromMapping(m: LoincMapping): FhirCodeableConcept {
  if (m.loinc) {
    return {
      coding: [{ system: LOINC_SYSTEM, code: m.loinc, display: m.display }],
      text: m.display,
    };
  }
  // No stable LOINC — local text-only concept (documented fallback).
  return { text: m.display };
}

function categoryConcept(category: string): FhirCodeableConcept {
  return {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: category,
      },
    ],
  };
}

/** Latest `{ value, measuredAt }` for a type, or null when no rows. */
function latestReading(
  data: DoctorReportData,
  type: string,
): { value: number; measuredAt: string } | null {
  const series = data.measurements[type];
  if (!series || series.length === 0) return null;
  return series[series.length - 1];
}

/**
 * Build a FHIR R4 document Bundle from the aggregated report data.
 *
 * `now` is injectable for deterministic tests.
 */
export function buildFhirDocumentBundle(
  data: DoctorReportData,
  identity: FhirPatientIdentity,
  now: Date = new Date(),
): FhirBundle {
  const patientId = "patient-1";
  const patientRef: FhirReference = { reference: `Patient/${patientId}` };
  const entries: FhirBundleEntry[] = [];
  const observationRefs: FhirReference[] = [];
  const medicationRefs: FhirReference[] = [];

  // --- Patient -----------------------------------------------------------
  const patient: FhirPatient = {
    resourceType: "Patient",
    id: patientId,
  };
  const displayName = data.patient.fullName ?? data.patient.username ?? null;
  if (displayName) patient.name = [{ text: displayName }];
  if (data.patient.gender) {
    patient.gender = data.patient.gender === "MALE" ? "male" : "female";
  }
  if (data.patient.dateOfBirth) {
    patient.birthDate = data.patient.dateOfBirth.slice(0, 10);
  }
  if (identity.insuranceNumber) {
    patient.identifier = [
      { system: KVNR_SYSTEM, value: identity.insuranceNumber },
    ];
  }
  entries.push({ fullUrl: `urn:uuid:${patientId}`, resource: patient });

  let obsSeq = 0;
  const pushObservation = (obs: FhirObservation) => {
    entries.push({ fullUrl: `urn:uuid:${obs.id}`, resource: obs });
    observationRefs.push({ reference: `Observation/${obs.id}` });
  };

  // --- Vital-sign + activity Observations (one latest reading per type) --
  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);

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
    obsSeq += 1;
    pushObservation({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept(mapping.category)],
      code: codeableFromMapping(mapping),
      subject: patientRef,
      effectiveDateTime: reading.measuredAt,
      valueQuantity: {
        value,
        unit: mapping.unit,
        system: UCUM_SYSTEM,
        code: mapping.unit,
      },
    });
  }

  // --- Blood-pressure panel (sys + dia components) -----------------------
  const sys = latestReading(data, "BLOOD_PRESSURE_SYS");
  const dia = latestReading(data, "BLOOD_PRESSURE_DIA");
  if (sys && dia) {
    obsSeq += 1;
    pushObservation({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("vital-signs")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: BP_PANEL_LOINC,
            display: "Blood pressure panel",
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
              { system: LOINC_SYSTEM, code: BP_SYS_LOINC, display: "Systolic" },
            ],
          },
          valueQuantity: {
            value: sys.value,
            unit: BP_UNIT,
            system: UCUM_SYSTEM,
            code: BP_UNIT,
          },
        },
        {
          code: {
            coding: [
              { system: LOINC_SYSTEM, code: BP_DIA_LOINC, display: "Diastolic" },
            ],
          },
          valueQuantity: {
            value: dia.value,
            unit: BP_UNIT,
            system: UCUM_SYSTEM,
            code: BP_UNIT,
          },
        },
      ],
    });
  }

  // --- Computed BMI Observation (matches the PDF's BMI line) -------------
  if (data.bmi !== null && data.bmi !== undefined) {
    obsSeq += 1;
    pushObservation({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
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
      effectiveDateTime: data.period.end,
      valueQuantity: {
        value: data.bmi,
        unit: "kg/m2",
        system: UCUM_SYSTEM,
        code: "kg/m2",
      },
    });
  }

  // --- Glucose Observations (per context, user display unit) -------------
  for (const [ctx, stat] of Object.entries(data.glucoseStats)) {
    const map = GLUCOSE_LOINC[ctx];
    if (!map) continue;
    obsSeq += 1;
    pushObservation({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("laboratory")],
      code: {
        coding: [{ system: LOINC_SYSTEM, code: map.loinc, display: map.display }],
        text: map.display,
      },
      subject: patientRef,
      effectiveDateTime: data.period.end,
      valueQuantity: {
        value: convertGlucose(stat.latest, glucoseUnit),
        unit: glucoseUnit,
        system: UCUM_SYSTEM,
        code: glucoseUnit === "mmol/L" ? "mmol/L" : "mg/dL",
      },
    });
  }

  // --- Medication-adherence Observations (one per medication) ------------
  for (const [name, comp] of Object.entries(data.compliance)) {
    if (comp.total <= 0) continue;
    obsSeq += 1;
    const rate = Math.round((comp.taken / comp.total) * 1000) / 10;
    pushObservation({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("activity")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: MEDICATION_ADHERENCE_LOINC,
            display: "Medication adherence",
          },
        ],
        text: `Medication adherence — ${name}`,
      },
      subject: patientRef,
      effectiveDateTime: data.period.end,
      valueQuantity: { value: rate, unit: "%", system: UCUM_SYSTEM, code: "%" },
    });
  }

  // --- Mood Observation (opt-in only; absent when toggle off) ------------
  if (data.mood) {
    obsSeq += 1;
    pushObservation({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("vital-signs")],
      code: {
        coding: [{ system: LOINC_SYSTEM, code: MOOD_LOINC, display: "Mood" }],
        text: "Mood (average over period)",
      },
      subject: patientRef,
      effectiveDateTime: data.period.end,
      valueQuantity: {
        value: Math.round(data.mood.avg * 10) / 10,
        unit: "{score}",
        system: UCUM_SYSTEM,
        code: "{score}",
      },
    });
  }

  // --- MedicationStatement per active medication -------------------------
  let medSeq = 0;
  for (const med of data.medications) {
    medSeq += 1;
    const id = `med-${medSeq}`;
    const stmt: FhirMedicationStatement = {
      resourceType: "MedicationStatement",
      id,
      status: "active",
      medicationCodeableConcept: { text: med.name },
      subject: patientRef,
    };
    if (med.dose) stmt.dosage = [{ text: med.dose }];
    entries.push({ fullUrl: `urn:uuid:${id}`, resource: stmt });
    medicationRefs.push({ reference: `MedicationStatement/${id}` });
  }

  // --- Composition (leading "cover" resource) ----------------------------
  const narrativeText = [
    `Health record for ${escapeXml(displayName ?? "patient")}.`,
    `Reporting period ${data.period.start.slice(0, 10)} to ${data.period.end.slice(0, 10)}.`,
    `${observationRefs.length} observation(s), ${medicationRefs.length} medication(s).`,
  ].join(" ");

  const composition: FhirComposition = {
    resourceType: "Composition",
    id: "composition-1",
    status: "final",
    type: {
      coding: [
        {
          system: LOINC_SYSTEM,
          code: "11503-0",
          display: "Medical records",
        },
      ],
      text: "Health record",
    },
    subject: patientRef,
    date: now.toISOString(),
    author: [{ reference: "Device/healthlog", display: "HealthLog" }],
    title: "Health Record",
    section: [
      {
        // Vital-signs section carries the narrative + every Observation ref,
        // matching the iOS Bundle graph ("Vital signs" + "Medications").
        title: "Vital signs",
        text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(narrativeText)}</div>` },
        entry: [patientRef, ...observationRefs],
      },
      ...(medicationRefs.length > 0
        ? [{ title: "Medications", entry: medicationRefs }]
        : []),
    ],
  };

  // --- DiagnosticReport (vital-signs panel; routes all Observations) -----
  // Last entry in the Bundle, matching the iOS Bundle graph. `result[]`
  // references every emitted Observation.
  const diagnosticReport: FhirDiagnosticReport = {
    resourceType: "DiagnosticReport",
    id: "diagnostic-report-1",
    status: "final",
    code: {
      coding: [
        {
          system: LOINC_SYSTEM,
          code: "85353-1",
          display:
            "Vital signs, weight, height, head circumference, oxygen saturation and BMI panel",
        },
      ],
      text: "Vital signs panel",
    },
    subject: patientRef,
    effectivePeriod: { start: data.period.start, end: data.period.end },
    result: observationRefs,
  };

  // The Composition must be the FIRST entry in a document Bundle; the
  // DiagnosticReport is the LAST.
  const orderedEntries: FhirBundleEntry[] = [
    {
      fullUrl: `urn:uuid:${composition.id}`,
      resource: composition as FhirResource,
    },
    ...entries,
    {
      fullUrl: `urn:uuid:${diagnosticReport.id}`,
      resource: diagnosticReport as FhirResource,
    },
  ];

  return {
    resourceType: "Bundle",
    type: "document",
    timestamp: now.toISOString(),
    entry: orderedEntries,
  };
}
