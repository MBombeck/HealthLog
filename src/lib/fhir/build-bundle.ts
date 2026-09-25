/**
 * v1.7.0 — HL7 FHIR R4 document-Bundle builder for the health-record export.
 *
 * Pure function: takes the SAME `DoctorReportData` the PDF renderer consumes
 * (assembled by `collectDoctorReportData`) plus the decrypted patient
 * identity, and emits a `Bundle` of `type: "document"` — a leading
 * `Composition` "cover page", the `Device` that authored it, the `Patient`,
 * then one `Observation` per selected vital / glucose context / lab / mood,
 * one `MedicationStatement` per active medication, and the structured records.
 *
 * Because it reuses the PDF aggregator, the FHIR export and the PDF describe
 * identical numbers by construction (the source-of-truth property the two
 * PDF endpoints already share).
 *
 * The per-resource emitters live in `./resources`, shared with the FHIR REST
 * routes; this builder composes them into the document Bundle, mints the entry
 * identities, and rewrites every internal reference onto them.
 *
 * No FHIR SDK, no `@types/fhir` — narrow hand-rolled interfaces only
 * (`./types`), matching the project's "hand-rolled over the documented wire"
 * convention. The `Composition.text` narrative is escaped plain text, never
 * user-supplied HTML (no markdown library, no `dangerouslySetInnerHTML`).
 */
import { randomUUID } from "node:crypto";

import type { DoctorReportData } from "@/lib/doctor-report-data";
import type { AllergyDTO, FamilyHistoryEntryDTO } from "@/lib/records/dto";
import {
  allergyIntoleranceResources,
  familyMemberHistoryResources,
} from "@/lib/fhir/records";
import { LOINC_SYSTEM } from "@/lib/fhir/loinc-map";
import {
  type FhirBuildOptions,
  type FhirPatientIdentity,
  PATIENT_RESOURCE_ID,
  patientResource,
  coverageResource,
  observationsFromReportData,
  cycleObservationsFromReportData,
  anamnesisNarrativeFromReportData,
  anamnesisObservationsFromReportData,
  conditionsFromReportData,
  medicationStatementsFromReportData,
  medicationAdministrationsFromReportData,
} from "@/lib/fhir/resources";
import type {
  FhirBundle,
  FhirBundleEntry,
  FhirComposition,
  FhirDevice,
  FhirDiagnosticReport,
  FhirObservation,
  FhirReference,
  FhirResource,
} from "@/lib/fhir/types";

// Re-export the shared coding constants + option types so existing importers
// (capabilities + health-record routes) keep their `@/lib/fhir/build-bundle`
// import path. The single source of truth lives in `./resources`.
export {
  ATC_SYSTEM,
  SNOMED_SYSTEM,
  GERMAN_ATC_DEFAULT_LOCALES,
} from "@/lib/fhir/resources";
export type { FhirBuildOptions, FhirPatientIdentity };

/** Namespace for the document's own identifier (`bdl-9`). */
const BUNDLE_IDENTIFIER_SYSTEM = "https://healthlog.dev/fhir/bundle-id";

/** Resource id of the authoring `Device` the Composition names. */
const AUTHOR_DEVICE_ID = "healthlog";

/** Escape the five XML-significant characters for the xhtml narrative. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * v1.25 (W-RECORDS) — the structured records folded into the document bundle.
 * Passed separately from `DoctorReportData` (they are always-available
 * reference records, not part of the time-windowed report aggregation).
 * Empty arrays emit nothing.
 */
export interface FhirRecordInputs {
  allergies?: AllergyDTO[];
  familyHistory?: FamilyHistoryEntryDTO[];
}

/**
 * The running build's version, for the authoring Device. Same resolution order
 * as `/api/version`: the image build arg wins so the exported document names
 * the release that produced it, with the package version as the local-dev
 * fallback.
 */
function runningVersion(): string {
  return (
    process.env.NEXT_PUBLIC_APP_VERSION?.trim() ||
    process.env.npm_package_version?.trim() ||
    "unknown"
  );
}

/**
 * Return a copy of `value` in which every relative reference
 * (`Observation/obs-1`) names the entry identity that actually carries the
 * resource.
 *
 * `bdl-7` resolves an intra-document reference against `Bundle.entry.fullUrl`,
 * and the fullUrls are URNs — so a relative reference resolves against the
 * base of the RETRIEVING server, i.e. somewhere else entirely, or nowhere. One
 * total walk over the assembled resources is what makes that impossible to get
 * partially right: an emitter that grows a new reference is covered the day it
 * lands, without a second place to remember.
 *
 * Copies rather than mutates: the emitters share module-level reference
 * constants (one `{ reference: "Patient/patient-1" }` object is the `subject`
 * of every resource in the tree), and rewriting in place would rewrite them
 * for every later build in the process.
 *
 * Contained `#`-refs (the Coverage payor Organization) are left alone — they
 * already resolve inside their own resource.
 */
function withResolvedReferences<T>(
  value: T,
  urnByReference: ReadonlyMap<string, string>,
): T {
  if (Array.isArray(value)) {
    return value.map((item) =>
      withResolvedReferences(item, urnByReference),
    ) as unknown as T;
  }
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      key === "reference" && typeof child === "string"
        ? (urnByReference.get(child) ?? child)
        : withResolvedReferences(child, urnByReference);
  }
  return out as T;
}

/** True for an Observation the vital-signs panel may legitimately claim. */
function isVitalSignsObservation(observation: FhirObservation): boolean {
  return (observation.category ?? []).some((concept) =>
    (concept.coding ?? []).some((coding) => coding.code === "vital-signs"),
  );
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
  options: FhirBuildOptions = {},
  records: FhirRecordInputs = {},
): FhirBundle {
  const patientRef: FhirReference = {
    reference: `Patient/${PATIENT_RESOURCE_ID}`,
  };
  const deviceRef: FhirReference = {
    reference: `Device/${AUTHOR_DEVICE_ID}`,
    display: "HealthLog",
  };
  const entries: FhirBundleEntry[] = [];
  const observationRefs: FhirReference[] = [];
  const vitalSignsObservationRefs: FhirReference[] = [];
  const cycleObservationRefs: FhirReference[] = [];
  const anamnesisObservationRefs: FhirReference[] = [];
  const medicationRefs: FhirReference[] = [];
  const administrationRefs: FhirReference[] = [];
  const conditionRefs: FhirReference[] = [];
  const encounterRefs: FhirReference[] = [];
  const allergyRefs: FhirReference[] = [];
  const familyHistoryRefs: FhirReference[] = [];
  const coverageRefs: FhirReference[] = [];

  /**
   * Mint the entry identity. `fullUrl` is a fresh RFC-4122 UUID per entry —
   * `resource.id` stays the human-readable `obs-3` a maintainer can follow
   * through a diff, while the identity a receiver resolves against is unique
   * across every document ever exported.
   */
  const push = (resource: FhirResource): void => {
    entries.push({ fullUrl: `urn:uuid:${randomUUID()}`, resource });
  };

  // --- Device (the Composition's author) ---------------------------------
  const device: FhirDevice = {
    resourceType: "Device",
    id: AUTHOR_DEVICE_ID,
    manufacturer: "HealthLog",
    deviceName: [{ name: "HealthLog", type: "manufacturer-name" }],
    version: [{ value: runningVersion() }],
  };
  push(device);

  // --- Patient -----------------------------------------------------------
  push(patientResource(data, identity));

  // --- Coverage (insurer; sits right after the Patient) ------------------
  const coverage = coverageResource(data, identity);
  if (coverage) {
    push(coverage);
    coverageRefs.push({ reference: `Coverage/${coverage.id}` });
  }

  // --- Observations (vital / activity / lab / survey, in canonical order)-
  for (const obs of observationsFromReportData(data)) {
    push(obs);
    const ref: FhirReference = { reference: `Observation/${obs.id}` };
    observationRefs.push(ref);
    if (isVitalSignsObservation(obs)) vitalSignsObservationRefs.push(ref);
  }

  // --- Cycle / reproductive-health Observations (opt-in only) -----------
  // v1.15.0 — grouped into their own "Menstrual cycle" Composition section
  // so a reproductive-health finding is never mixed into the vital-signs
  // panel. Absent unless the user toggled the cycle section AND has data.
  for (const obs of cycleObservationsFromReportData(data)) {
    push(obs);
    cycleObservationRefs.push({ reference: `Observation/${obs.id}` });
  }

  // --- Selected current anamnesis facts (opt-in only) --------------------
  // The collector returns `null` when ANAMNESIS was not selected. When it was
  // selected, all three facts emit even if their value is absent or unreadable
  // so omission cannot be mistaken for consent-based exclusion.
  for (const obs of anamnesisObservationsFromReportData(data)) {
    push(obs);
    anamnesisObservationRefs.push({
      reference: `Observation/${obs.id}`,
    });
  }
  const anamnesisNarrative = anamnesisNarrativeFromReportData(data);

  // --- MedicationStatement per active medication -------------------------
  for (const stmt of medicationStatementsFromReportData(data, options)) {
    push(stmt);
    medicationRefs.push({ reference: `MedicationStatement/${stmt.id}` });
  }

  // --- MedicationAdministration per acted intake -------------------------
  for (const admin of medicationAdministrationsFromReportData(data, options)) {
    push(admin);
    administrationRefs.push({
      reference: `MedicationAdministration/${admin.id}`,
    });
  }

  // --- Condition + Encounter per illness/condition episode (opt-in) ------
  // v1.18.1 — present only when the illness module is enabled AND the window
  // No visits section, and the absence is a decision written at the
  // `Encounter` model in `prisma/schema.prisma`: FHIR splits the future from
  // the past across `Appointment` and `Encounter`, which is a serialisation
  // question this release does not answer. `FHIR_REST_RESOURCE_TYPES` stays
  // untouched for the same reason — a capability statement naming a type with
  // no route module lies. The PDF carries the visits; the Bundle does not, and
  // a reader who notices the gap should find this comment rather than a bug.
  //
  // No vaccinations either, on the same terms (v1.37.20, A6-21). FHIR has
  // `Immunization` and the model would map cleanly, but a resource type in
  // the Bundle without its REST route module and capability entry is the
  // exact half-shipped state the visits paragraph refuses; emitting it is a
  // deliberate follow-up, not an oversight. The Impfpass PDF and the backup
  // both carry the doses; the Bundle does not, and this comment is where a
  // reader who notices should land.
  //
  // The surgical history (v1.39.1) rides the same decision. A procedure is a
  // visit of kind PROCEDURE, and FHIR's `Procedure` resource would map it
  // cleanly (`code.text` from the reason, `bodySite.text` from the site), but
  // emitting one without its REST route and capability entry is the same
  // half-shipped state. The PDF and the clinician view carry the section; the
  // Bundle does not.
  //
  // held an episode (the aggregator gates `data.illnessEpisodes`). Each
  // episode emits a patient-reported Condition (generic SNOMED root, label on
  // `code.text`) plus a bounding Encounter that references it.
  const { conditions, encounters } = conditionsFromReportData(data);
  for (const condition of conditions) {
    push(condition);
    conditionRefs.push({ reference: `Condition/${condition.id}` });
  }
  for (const encounter of encounters) {
    push(encounter);
    encounterRefs.push({ reference: `Encounter/${encounter.id}` });
  }

  // --- AllergyIntolerance per recorded allergy (v1.25) -------------------
  // Always-available structured records (not time-windowed). Patient-reported
  // (verificationStatus unconfirmed); the substance rides `code.text`.
  for (const allergy of allergyIntoleranceResources(records.allergies ?? [])) {
    push(allergy);
    allergyRefs.push({ reference: `AllergyIntolerance/${allergy.id}` });
  }

  // --- FamilyMemberHistory per recorded entry (v1.25) -------------------
  for (const fmh of familyMemberHistoryResources(records.familyHistory ?? [])) {
    push(fmh);
    familyHistoryRefs.push({ reference: `FamilyMemberHistory/${fmh.id}` });
  }

  // --- Composition (leading "cover" resource) ----------------------------
  // v1.9.0 — when the aggregator capped the administration set, disclose
  // it in the narrative so the export is honest: it carries the
  // most-recent N of M acted intakes, the oldest having been omitted.
  const displayName = data.patient.fullName ?? data.patient.username ?? null;
  const truncation = data.medicationAdministrationsTruncation;
  const narrativeText = [
    `Health record for ${escapeXml(displayName ?? "patient")}.`,
    `Reporting period ${data.period.start.slice(0, 10)} to ${data.period.end.slice(0, 10)}.`,
    `${observationRefs.length} observation(s), ${medicationRefs.length} medication(s), ${administrationRefs.length} administration(s).`,
    ...(truncation
      ? [
          `Medication administrations truncated: showing the most recent ${truncation.included} of ${truncation.total} recorded; older entries omitted.`,
        ]
      : []),
  ].join(" ");

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
    // A vital-signs panel reports vital signs. Routing labs, adherence rates
    // and survey scores through it would let a receiver read a questionnaire
    // total as a vital sign because the panel code said so.
    result: vitalSignsObservationRefs,
  };
  const diagnosticReportRef: FhirReference = {
    reference: `DiagnosticReport/${diagnosticReport.id}`,
  };

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
    author: [deviceRef],
    title: "Health Record",
    // v1.9.0 — top-level document narrative. Section narrative is already
    // present; a strict US-Core-style validator additionally expects a
    // `Composition.text`. Reuses the same escaped plain-text summary.
    text: {
      status: "generated",
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(narrativeText)}</div>`,
    },
    section: [
      {
        // Vital-signs section carries the narrative + every Observation ref.
        // NOT the Patient: `Composition.subject` above already names the
        // person the whole document is about, and a subject listed as a
        // section entry reads as a finding.
        title: "Vital signs",
        text: {
          status: "generated",
          div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(narrativeText)}</div>`,
        },
        entry: [...observationRefs, diagnosticReportRef],
      },
      // Medications section carries both the active-medication
      // statements and the per-dose administration records (v1.9.0).
      ...(medicationRefs.length > 0 || administrationRefs.length > 0
        ? [
            {
              title: "Medications",
              entry: [...medicationRefs, ...administrationRefs],
            },
          ]
        : []),
      // v1.15.0 — opt-in reproductive-health section. Only present when the
      // cycle toggle surfaced cycle Observations.
      ...(cycleObservationRefs.length > 0
        ? [
            {
              title: "Menstrual cycle",
              entry: cycleObservationRefs,
            },
          ]
        : []),
      ...(anamnesisNarrative !== null
        ? [
            {
              title: "Anamnesis",
              code: {
                coding: [
                  {
                    system: LOINC_SYSTEM,
                    code: "11329-0",
                    display: "History general Narrative - Reported",
                  },
                ],
                text: "General history",
              },
              text: {
                status: "generated" as const,
                div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(anamnesisNarrative)}</div>`,
              },
              entry: anamnesisObservationRefs,
            },
          ]
        : []),
      // v1.18.1 — opt-in illness/condition section. Lists the Condition
      // resources AND the Encounters that bound them: an Encounter reachable
      // only from a Condition's `reasonReference` is not reachable from the
      // document at all.
      ...(conditionRefs.length > 0
        ? [
            {
              title: "Conditions",
              entry: [...conditionRefs, ...encounterRefs],
            },
          ]
        : []),
      // v1.25 — structured allergy records (AllergyIntolerance). Present only
      // when the account recorded at least one allergy.
      ...(allergyRefs.length > 0
        ? [
            {
              title: "Allergies",
              entry: allergyRefs,
            },
          ]
        : []),
      // v1.25 — structured family-history records (FamilyMemberHistory).
      ...(familyHistoryRefs.length > 0
        ? [
            {
              title: "Family history",
              entry: familyHistoryRefs,
            },
          ]
        : []),
      // The insurance relationship. A Coverage no section reaches is a
      // resource the document carries and never mentions.
      ...(coverageRefs.length > 0
        ? [
            {
              title: "Insurance",
              entry: coverageRefs,
            },
          ]
        : []),
    ],
  };

  // The Composition must be the FIRST entry in a document Bundle; the
  // DiagnosticReport is the LAST.
  const orderedEntries: FhirBundleEntry[] = [
    { fullUrl: `urn:uuid:${randomUUID()}`, resource: composition },
    ...entries,
    { fullUrl: `urn:uuid:${randomUUID()}`, resource: diagnosticReport },
  ];

  // Every entry identity is known only now, so the reference rewrite runs once
  // over the finished set.
  const urnByReference = new Map<string, string>(
    orderedEntries.map((entry) => [
      `${entry.resource.resourceType}/${entry.resource.id}`,
      entry.fullUrl,
    ]),
  );
  const resolvedEntries: FhirBundleEntry[] = orderedEntries.map((entry) => ({
    fullUrl: entry.fullUrl,
    resource: withResolvedReferences(entry.resource, urnByReference),
  }));

  return {
    resourceType: "Bundle",
    type: "document",
    identifier: {
      system: BUNDLE_IDENTIFIER_SYSTEM,
      value: randomUUID(),
    },
    timestamp: now.toISOString(),
    entry: resolvedEntries,
  };
}
