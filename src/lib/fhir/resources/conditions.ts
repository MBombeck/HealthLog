/**
 * `Condition` + bounding `Encounter` per illness / condition episode.
 *
 * HealthLog records a patient-kept condition journal; it is NOT a diagnosing
 * device and asserts no specific ICD/SNOMED diagnosis. The user's own label
 * rides `code.text`; the coded `code` carries the BROAD SNOMED CT category for
 * the episode's `IllnessType`, with the generic "Disease" root as the honest
 * fallback for an unknown / future type.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { ILLNESS_TYPE_SNOMED } from "@/lib/fhir/illness-snomed";
import type {
  FhirBodyStructure,
  FhirCodeableConcept,
  FhirCondition,
  FhirEncounter,
} from "@/lib/fhir/types";
import { SNOMED_SYSTEM, patientRef } from "@/lib/fhir/resources/common";
import { ownValue } from "@/lib/own-key";

/** SNOMED CT "Disease (disorder)" — the generic, non-diagnostic root concept. */
const DISEASE_SNOMED = { code: "64572001", display: "Disease" } as const;

/**
 * The side of a body site, as active SNOMED CT laterality qualifier values:
 * 7771000 Left, 24028007 Right, 51440002 Right and left. These are the codes
 * of the HL7 mCODE Laterality Qualifier value set
 * (https://build.fhir.org/ig/HL7/fhir-mCODE-ig/ValueSet-mcode-laterality-qualifier-vs.html).
 * The R4 core `bodysite-laterality` value set lists 419161000 / 419465000 for
 * left / right, but the HL7 validator reports both as inactive in current
 * SNOMED CT, so they are not used. R4 binds `BodyStructure.locationQualifier`
 * with example strength, so any SNOMED CT qualifier is conformant there.
 * Keyed on the `Laterality` enum.
 */
const LATERALITY_SNOMED: Record<
  string,
  { code: string; display: string; text: string }
> = {
  LEFT: { code: "7771000", display: "Left", text: "left" },
  RIGHT: { code: "24028007", display: "Right", text: "right" },
  BOTH: { code: "51440002", display: "Right and left", text: "both sides" },
};

/**
 * Core extension `http://hl7.org/fhir/StructureDefinition/bodySite`
 * (https://hl7.org/fhir/extensions/StructureDefinition-bodySite.html): a
 * Reference(BodyStructure) on `Condition.bodySite`, unchanged in R4.
 */
const BODY_SITE_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/bodySite";

const BODY_STRUCTURE_ID = "bodysite-1";

/**
 * `Condition.bodySite` plus the contained `BodyStructure` that carries its
 * side, or nothing when no site was recorded.
 *
 * The site is the user's free text, so it rides `text` only; no SNOMED body
 * structure is guessed from it. R4 `Condition.bodySite` has no laterality
 * element, and a laterality concept is not a body site, so putting "Left" in
 * `bodySite.coding` would claim the condition sits on "left". The standard R4
 * route is the core `bodySite` extension pointing at a `BodyStructure` whose
 * `locationQualifier` holds the SNOMED CT side. The side is also written into
 * `bodySite.text`, because a receiver that ignores extensions must still read
 * "Knee (left)" rather than a bare "Knee".
 *
 * The side word is English on purpose. The builder takes no locale
 * (`FhirBuildOptions` carries none, unlike the PDF path), and every other
 * generated text in the Bundle is English: section titles, the Condition note,
 * the narratives. The site stays in the words the user wrote, so a German
 * record reads "Knie (left)", the same mix as a German label beside the
 * English "Self-recorded … condition journal entry" note.
 */
function bodySiteOf(
  bodySite: string | null | undefined,
  laterality: string | null | undefined,
): Pick<FhirCondition, "bodySite" | "contained"> {
  const site = bodySite?.trim();
  if (!site) return {};
  const side = laterality ? ownValue(LATERALITY_SNOMED, laterality) : undefined;
  if (!side) return { bodySite: [{ text: site }] };
  const structure: FhirBodyStructure = {
    resourceType: "BodyStructure",
    id: BODY_STRUCTURE_ID,
    location: { text: site },
    locationQualifier: [
      {
        coding: [
          { system: SNOMED_SYSTEM, code: side.code, display: side.display },
        ],
        text: side.text,
      },
    ],
    patient: patientRef,
  };
  return {
    contained: [structure],
    bodySite: [
      {
        extension: [
          {
            url: BODY_SITE_EXTENSION_URL,
            valueReference: { reference: `#${BODY_STRUCTURE_ID}` },
          },
        ],
        text: `${site} (${side.text})`,
      },
    ],
  };
}

/** R4 `Condition.clinicalStatus` concept for the given resolution state. */
function conditionClinicalStatus(resolved: boolean): FhirCodeableConcept {
  return {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
        code: resolved ? "resolved" : "active",
      },
    ],
  };
}

/**
 * v1.18.1 — emit one `Condition` per illness/condition episode plus a
 * bounding `Encounter`. Absent unless the illness module is enabled AND the
 * window held an episode (the aggregator only populates `illnessEpisodes`
 * then). Ids run `condition-1..N` / `encounter-1..N`; the Encounter references
 * its Condition so a clinician sees the time-boxed episode.
 */
export function conditionsFromReportData(data: DoctorReportData): {
  conditions: FhirCondition[];
  encounters: FhirEncounter[];
} {
  const episodes = data.illnessEpisodes;
  if (!episodes || episodes.length === 0) {
    return { conditions: [], encounters: [] };
  }
  const conditions: FhirCondition[] = [];
  const encounters: FhirEncounter[] = [];
  let seq = 0;
  for (const ep of episodes) {
    seq += 1;
    const conditionId = `condition-${seq}`;
    const resolved = ep.resolvedAt !== null;
    const site = bodySiteOf(ep.bodySite, ep.laterality);
    conditions.push({
      resourceType: "Condition",
      id: conditionId,
      ...(site.contained ? { contained: site.contained } : {}),
      clinicalStatus: conditionClinicalStatus(resolved),
      verificationStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/condition-ver-status",
            // Patient-reported journal entry → "unconfirmed", never a
            // clinician-confirmed diagnosis.
            code: "unconfirmed",
          },
        ],
      },
      category: [
        {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/condition-category",
              code: "problem-list-item",
            },
          ],
          // The journal's broad class as a human-readable category label.
          text: ep.type,
        },
      ],
      code: {
        // Broad SNOMED CT category for the journal type; the generic "Disease"
        // root is the honest fallback for an unknown / future type. NEVER a
        // specific diagnosis — the user's own label stays on `.text`.
        coding: [
          {
            system: SNOMED_SYSTEM,
            code: (ownValue(ILLNESS_TYPE_SNOMED, ep.type) ?? DISEASE_SNOMED)
              .code,
            display: (ownValue(ILLNESS_TYPE_SNOMED, ep.type) ?? DISEASE_SNOMED)
              .display,
          },
        ],
        text: ep.label,
      },
      ...(site.bodySite ? { bodySite: site.bodySite } : {}),
      subject: patientRef,
      onsetDateTime: ep.onsetAt,
      ...(ep.resolvedAt ? { abatementDateTime: ep.resolvedAt } : {}),
      note: [
        {
          text: `Self-recorded ${ep.lifecycle.toLowerCase().replace(/_/g, " ")} condition journal entry; patient-reported, not a clinical diagnosis.`,
        },
      ],
    });
    encounters.push({
      resourceType: "Encounter",
      id: `encounter-${seq}`,
      status: resolved ? "finished" : "in-progress",
      class: {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        code: "AMB",
        display: "ambulatory",
      },
      subject: patientRef,
      period: {
        start: ep.onsetAt,
        ...(ep.resolvedAt ? { end: ep.resolvedAt } : {}),
      },
      reasonReference: [{ reference: `Condition/${conditionId}` }],
    });
  }
  return { conditions, encounters };
}
