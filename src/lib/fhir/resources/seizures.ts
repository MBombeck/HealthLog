/**
 * The seizure diary as FHIR R4 (#1368).
 *
 *  - One `Observation` per recorded seizure: `code` SNOMED 313307000
 *    "Epileptic seizure" (91175000 "Seizure" for a suspected or unclassified
 *    one), the seizure type in `valueCodeableConcept` (SNOMED, with the ILAE
 *    2025 name as text), `effectivePeriod` from onset and duration (or
 *    `effectiveDateTime` when the duration is unknown), `status` final or
 *    preliminary for a suspected event, and components for the sleep state,
 *    responsiveness, recall, post-ictal state, injuries, suspected triggers
 *    and the witness. A tally carries its count in an extension.
 *  - One `MedicationAdministration` per rescue dose, `reasonReference` → the
 *    seizure Observation, the effect in `note`.
 *  - One `Encounter` per seizure that led to an emergency department visit
 *    or an admission, referenced from the Observation.
 *  - One cluster `Observation` per episode under the record's rule, text code
 *    naming the rule, `hasMember` → the seizures.
 *  - Three summary Observations: LOINC 99312-1 (frequency category over the
 *    trailing year), 99313-9 (time since the last seizure) and 99311-3 (the
 *    2017 seizure-type categories present).
 *
 * Never asserted: a diagnosis (no Condition is created from the diary), a
 * status epilepticus (a duration over t1 is a note, not a code), a risk. The
 * record says what was observed.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { LOINC_SYSTEM } from "@/lib/fhir/loinc-map";
import { SNOMED_SYSTEM, patientRef } from "@/lib/fhir/resources/common";
import type {
  FhirCodeableConcept,
  FhirEncounter,
  FhirMedicationAdministration,
  FhirObservation,
  FhirNarrative,
  FhirObservationComponent,
  FhirReference,
} from "@/lib/fhir/types";
import { ucumQuantity } from "@/lib/fhir/ucum";
import {
  frequencyCategory,
  SEIZURE_FREQUENCY_ANSWERS,
  timeSinceLastAnswer,
} from "@/lib/seizures/derive";
import {
  ILAE_TYPE_INFO,
  loincSeizureTypeAnswer,
  type SeizureIlaeType,
} from "@/lib/seizures/ilae";

/** English ILAE 2025 names for `valueCodeableConcept.text`. */
const ILAE_2025_TEXT: Record<SeizureIlaeType, string> = {
  FOCAL_PRESERVED: "Focal preserved consciousness seizure",
  FOCAL_IMPAIRED: "Focal impaired consciousness seizure",
  FOCAL_UNDETERMINED: "Focal seizure",
  FOCAL_TO_BILATERAL_TC: "Focal to bilateral tonic-clonic seizure",
  GENERALIZED_UNDETERMINED: "Generalized seizure",
  GENERALIZED_TC: "Generalized tonic-clonic seizure",
  GEN_CLONIC: "Generalized clonic seizure",
  GEN_TONIC: "Generalized tonic seizure",
  GEN_MYOCLONIC: "Generalized myoclonic seizure",
  GEN_MYOCLONIC_ATONIC: "Generalized myoclonic-atonic seizure",
  GEN_ATONIC: "Generalized atonic seizure",
  GEN_NEGATIVE_MYOCLONIC: "Generalized negative myoclonic seizure",
  GEN_SPASMS: "Generalized epileptic spasms",
  ABSENCE_TYPICAL: "Typical absence seizure",
  ABSENCE_ATYPICAL: "Atypical absence seizure",
  ABSENCE_MYOCLONIC: "Myoclonic absence seizure",
  EYELID_MYOCLONIA: "Eyelid myoclonia with or without absence",
  UNKNOWN_UNDETERMINED: "Seizure, unknown whether focal or generalized",
  UNKNOWN_PRESERVED:
    "Seizure, unknown whether focal or generalized, preserved consciousness",
  UNKNOWN_IMPAIRED:
    "Seizure, unknown whether focal or generalized, impaired consciousness",
  UNKNOWN_BILATERAL_TC:
    "Bilateral tonic-clonic seizure, unknown whether focal or generalized",
  UNCLASSIFIED: "Unclassified seizure",
};

/** Extension carrying how many seizures a tally Observation stands for. */
export const SEIZURE_COUNT_EXTENSION_URL =
  "https://healthlog.dev/fhir/StructureDefinition/seizure-count";

const EPILEPTIC_SEIZURE = { code: "313307000", display: "Epileptic seizure" };
const SEIZURE_FINDING = { code: "91175000", display: "Seizure" };
const POSTICTAL_STATE = { code: "31758001", display: "Postictal state" };
const TODDS_PARESIS = { code: "66264000", display: "Todd's paresis" };

/** SNOMED CT routes of administration. */
const RESCUE_ROUTE_SNOMED: Record<string, { code: string; display: string }> = {
  BUCCAL: { code: "54471007", display: "Buccal route" },
  INTRANASAL: { code: "46713006", display: "Nasal route" },
  RECTAL: { code: "37161004", display: "Rectal route" },
  ORAL: { code: "26643006", display: "Oral route" },
  SUBLINGUAL: { code: "37839007", display: "Sublingual route" },
  IM: { code: "78421000", display: "Intramuscular route" },
  IV_BY_EMS: { code: "47625008", display: "Intravenous route" },
};

const text = (value: string): FhirCodeableConcept => ({ text: value });

function snomed(
  concept: { code: string; display: string },
  label?: string,
): FhirCodeableConcept {
  return {
    coding: [{ system: SNOMED_SYSTEM, ...concept }],
    text: label ?? concept.display,
  };
}

const lower = (v: string) => v.toLowerCase().replace(/_/g, " ");

function seizureComponents(
  e: NonNullable<DoctorReportData["seizureDiary"]>["events"][number],
): FhirObservationComponent[] {
  const out: FhirObservationComponent[] = [];
  if (e.sleepState !== "UNKNOWN") {
    out.push({
      code: text("Sleep state at onset"),
      valueCodeableConcept: text(lower(e.sleepState)),
    });
  }
  if (e.observableManifestations && e.observableManifestations !== "UNKNOWN") {
    out.push({
      code: text("Observable manifestations"),
      valueBoolean: e.observableManifestations === "YES",
    });
  }
  if (e.incontinence !== null) {
    out.push({ code: text("Incontinence"), valueBoolean: e.incontinence });
  }
  if (e.responsiveness) {
    out.push({
      code: text("Responsiveness"),
      valueCodeableConcept: text(lower(e.responsiveness)),
    });
  }
  if (e.recall) {
    out.push({
      code: text("Recall"),
      valueCodeableConcept: text(lower(e.recall)),
    });
  }
  for (const p of e.postictal) {
    out.push({
      code: snomed(POSTICTAL_STATE),
      valueCodeableConcept:
        p === "WEAKNESS_TODD" ? snomed(TODDS_PARESIS) : text(lower(p)),
    });
  }
  for (const injury of e.injuries) {
    if (injury === "NONE") continue;
    out.push({
      code: text("Injury"),
      valueCodeableConcept: text(lower(injury)),
    });
  }
  for (const trigger of e.triggers) {
    if (trigger === "NONE_IDENTIFIED") continue;
    out.push({
      code: text("Suspected trigger (patient-reported)"),
      valueCodeableConcept: text(lower(trigger)),
    });
  }
  if (e.witnessed !== null) {
    out.push({ code: text("Witnessed"), valueBoolean: e.witnessed });
  }
  if (e.loggedByDelegate) {
    out.push({
      code: text("Recorded by"),
      valueString: e.witnessRole
        ? `${lower(e.witnessRole)} (on the person's behalf)`
        : "someone with access, on the person's behalf",
    });
  }
  return out;
}

export interface SeizureFhirResources {
  observations: FhirObservation[];
  administrations: FhirMedicationAdministration[];
  encounters: FhirEncounter[];
}

/** Every seizure-diary resource for the report window, or none. */
export function seizureResourcesFromReportData(
  data: DoctorReportData,
): SeizureFhirResources {
  const section = data.seizureDiary;
  const empty = { observations: [], administrations: [], encounters: [] };
  if (!section || section.events.length === 0) return empty;

  const observations: FhirObservation[] = [];
  const administrations: FhirMedicationAdministration[] = [];
  const encounters: FhirEncounter[] = [];
  const obsIdByEvent = new Map<string, string>();
  const t1Text = (sec: number) => `${Math.round(sec / 60)} min`;

  section.events.forEach((e, i) => {
    const id = `seizure-${i + 1}`;
    obsIdByEvent.set(e.id, id);
    const suspected = e.suspected;
    const unclassified = e.ilaeType === null || e.ilaeType === "UNCLASSIFIED";
    const info = e.ilaeType ? ILAE_TYPE_INFO[e.ilaeType] : null;
    const start = e.onsetAt;
    const notes: string[] = [];
    if (e.onsetUnknown) notes.push("Onset time not known; date only.");
    if (e.estimated) notes.push("Duration estimated, not timed.");
    if (
      info?.t1Sec != null &&
      e.durationSec !== null &&
      e.durationSec >= info.t1Sec
    ) {
      notes.push(
        `Duration at or over the ILAE t1 for this seizure type (${t1Text(info.t1Sec)}, Trinka 2015).`,
      );
    }
    let encounterRef: string | null = null;
    if (e.emergency === "ED_VISIT" || e.emergency === "ADMITTED") {
      const encId = `seizure-encounter-${i + 1}`;
      encounterRef = `Encounter/${encId}`;
      encounters.push({
        resourceType: "Encounter",
        id: encId,
        status: "finished",
        class:
          e.emergency === "ADMITTED"
            ? {
                system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                code: "IMP",
                display: "inpatient encounter",
              }
            : {
                system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                code: "EMER",
                display: "emergency",
              },
        subject: patientRef,
        period: { start },
        reasonReference: [{ reference: `Observation/${id}` }],
      });
    } else if (e.emergency === "EMS_CALLED") {
      notes.push("Emergency services were called.");
    }

    observations.push({
      resourceType: "Observation",
      id,
      status: suspected ? "preliminary" : "final",
      category: [
        {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "exam",
              display: "Exam",
            },
          ],
        },
      ],
      code: snomed(
        suspected || unclassified ? SEIZURE_FINDING : EPILEPTIC_SEIZURE,
      ),
      subject: patientRef,
      ...(e.durationSec !== null && !e.onsetUnknown
        ? {
            effectivePeriod: {
              start,
              end: new Date(
                Date.parse(start) + e.durationSec * 1000,
              ).toISOString(),
            },
          }
        : { effectiveDateTime: e.onsetUnknown ? start.slice(0, 10) : start }),
      ...(e.ilaeType
        ? {
            valueCodeableConcept: {
              coding: [
                { system: SNOMED_SYSTEM, ...ILAE_TYPE_INFO[e.ilaeType].snomed },
              ],
              text: ILAE_2025_TEXT[e.ilaeType],
            },
          }
        : {}),
      ...(e.count > 1
        ? {
            extension: [
              { url: SEIZURE_COUNT_EXTENSION_URL, valueInteger: e.count },
            ],
          }
        : {}),
      ...(!e.loggedByDelegate ? { performer: [patientRef] } : {}),
      ...(encounterRef ? { encounter: { reference: encounterRef } } : {}),
      ...(() => {
        const components = seizureComponents(e);
        return components.length > 0 ? { component: components } : {};
      })(),
      ...(notes.length > 0 ? { note: notes.map((n) => ({ text: n })) } : {}),
    });

    e.rescueDoses.forEach((d, j) => {
      const route = d.route ? RESCUE_ROUTE_SNOMED[d.route] : undefined;
      administrations.push({
        resourceType: "MedicationAdministration",
        id: `seizure-rescue-${i + 1}-${j + 1}`,
        status: "completed",
        medicationCodeableConcept: text(d.medicationName),
        subject: patientRef,
        effectiveDateTime: d.givenAt,
        ...(d.doseAmount !== null
          ? {
              dosage: {
                dose: ucumQuantity(d.doseAmount, d.doseUnit ?? ""),
                ...(route ? { route: snomed(route) } : {}),
              },
            }
          : {}),
        reasonReference: [{ reference: `Observation/${id}` }],
        note: [{ text: `Effect: ${lower(d.effect)}.` }],
      });
    });
  });

  observations.push(...clusterObservations(section, obsIdByEvent));
  observations.push(...summaryObservations(data, section));

  return { observations, administrations, encounters };
}

/** The three LOINC summaries: frequency, time since the last, types present. */
function summaryObservations(
  data: DoctorReportData,
  section: NonNullable<DoctorReportData["seizureDiary"]>,
): FhirObservation[] {
  const out: FhirObservation[] = [];
  const windowEnd = data.period.end;
  const frequency =
    SEIZURE_FREQUENCY_ANSWERS[frequencyCategory(section.trailingYearPerDay)];
  out.push({
    resourceType: "Observation",
    id: "seizure-frequency",
    status: "final",
    code: {
      coding: [
        { system: LOINC_SYSTEM, code: "99312-1", display: "Seizure frequency" },
      ],
      text: "Seizure frequency (recorded, trailing 12 months)",
    },
    subject: patientRef,
    effectiveDateTime: windowEnd,
    valueCodeableConcept: {
      coding: [{ system: LOINC_SYSTEM, ...frequency }],
      text: frequency.display,
    },
    note: [
      {
        text: "Computed from a patient or carer recorded diary; recorded seizures, likely an undercount.",
      },
    ],
  });
  const since = timeSinceLastAnswer(section.summary.daysSinceLast);
  out.push({
    resourceType: "Observation",
    id: "seizure-time-since-last",
    status: "final",
    code: {
      coding: [
        {
          system: LOINC_SYSTEM,
          code: "99313-9",
          display: "Time since last seizure",
        },
      ],
    },
    subject: patientRef,
    effectiveDateTime: windowEnd,
    valueCodeableConcept: {
      coding: [{ system: LOINC_SYSTEM, ...since }],
      text: since.display,
    },
  });
  const typeAnswers = new Map<string, { code: string; display: string }>();
  for (const e of section.events) {
    if (e.suspected || !e.ilaeType) continue;
    const answer = loincSeizureTypeAnswer(e.ilaeType);
    if (answer) typeAnswers.set(answer.code, answer);
  }
  if (typeAnswers.size > 0) {
    out.push({
      resourceType: "Observation",
      id: "seizure-types",
      status: "final",
      code: {
        coding: [
          { system: LOINC_SYSTEM, code: "99311-3", display: "Seizure type" },
        ],
        text: "Seizure types recorded in the period (ILAE 2017 categories)",
      },
      subject: patientRef,
      effectivePeriod: { start: data.period.start, end: data.period.end },
      component: [...typeAnswers.values()].map((answer) => ({
        code: {
          coding: [
            { system: LOINC_SYSTEM, code: "99311-3", display: "Seizure type" },
          ],
        },
        valueCodeableConcept: {
          coding: [{ system: LOINC_SYSTEM, ...answer }],
          text: answer.display,
        },
      })),
    });
  }

  return out;
}

/** One Observation per cluster episode, its seizures as members. */
function clusterObservations(
  section: NonNullable<DoctorReportData["seizureDiary"]>,
  obsIdByEvent: ReadonlyMap<string, string>,
): FhirObservation[] {
  const out: FhirObservation[] = [];
  section.clusters.forEach((c, i) => {
    const members = c.eventIds
      .map((eid) => obsIdByEvent.get(eid))
      .filter((v): v is string => v !== undefined)
      .map((oid) => ({ reference: `Observation/${oid}` }));
    out.push({
      resourceType: "Observation",
      id: `seizure-cluster-${i + 1}`,
      status: "final",
      code: text(
        `Seizure cluster (rule: ${section.rule.count} or more in ${section.rule.windowHours} h)`,
      ),
      subject: patientRef,
      effectivePeriod: { start: c.startAt, end: c.endAt },
      valueInteger: c.seizureCount,
      ...(members.length > 0 ? { hasMember: members } : {}),
    });
  });

  return out;
}

/** Every seizure-diary resource of the window, in document order. */
export function seizureBundleResources(
  data: DoctorReportData,
): Array<FhirObservation | FhirMedicationAdministration | FhirEncounter> {
  const { observations, administrations, encounters } =
    seizureResourcesFromReportData(data);
  return [...observations, ...administrations, ...encounters];
}

/**
 * The document's "Seizure diary" section: every resource the diary emitted,
 * so an administration or an encounter reachable only by reference is still
 * reachable from the document. Empty when the diary emitted nothing.
 */
export function seizureCompositionSection(
  entry: FhirReference[],
): Array<{ title: string; text: FhirNarrative; entry: FhirReference[] }> {
  if (entry.length === 0) return [];
  return [
    {
      title: "Seizure diary",
      text: {
        status: "generated",
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Patient or carer recorded diary. Recorded seizures, likely an undercount, especially for seizures from sleep. Records observations; does not diagnose.</div>',
      },
      entry,
    },
  ];
}
