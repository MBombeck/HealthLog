/**
 * v1.25 — FHIR R4 emitters for the structured health records.
 *
 * Pure functions over the server-authoritative DTOs (`@/lib/records/dto`):
 *   - Allergy            → `AllergyIntolerance`
 *   - FamilyHistoryEntry → `FamilyMemberHistory`
 *
 * Vendor-blind + non-diagnostic, matching the illness `Condition` stance in
 * `./resources`: the user's own label rides `code.text` (NEVER a
 * machine-guessed SNOMED/RxNorm code); only the FHIR-defined value sets
 * (category, clinical/verification status, family-member RoleCode) carry
 * codings. Every resource is marked patient-reported (allergy
 * `verificationStatus: unconfirmed`; an explicit "not a clinical diagnosis"
 * note) so a clinician's viewer never reads it as an adjudicated finding.
 *
 * No FHIR SDK — narrow hand-rolled interfaces only (`./types`), matching the
 * project's "hand-rolled over the documented wire" convention. All text is
 * plain text; never user-supplied HTML.
 */
import type { AllergyDTO, FamilyHistoryEntryDTO } from "@/lib/records/dto";
import { PATIENT_RESOURCE_ID } from "@/lib/fhir/resources";
import type {
  FhirAllergyIntolerance,
  FhirFamilyMemberHistory,
  FhirReference,
} from "@/lib/fhir/types";
import { ownValue } from "@/lib/own-key";

const patientRef: FhirReference = {
  reference: `Patient/${PATIENT_RESOURCE_ID}`,
};

const ALLERGY_CLINICAL_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";
const ALLERGY_VERIFICATION_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification";

/** FHIR-fixed `AllergyIntolerance.clinicalStatus` per record status. */
const ALLERGY_CLINICAL: Record<string, { code: string; display: string }> = {
  ACTIVE: { code: "active", display: "Active" },
  INACTIVE: { code: "inactive", display: "Inactive" },
  RESOLVED: { code: "resolved", display: "Resolved" },
};

/** Record category → the fixed `AllergyIntolerance.category` value set. */
const ALLERGY_CATEGORY: Record<
  string,
  "food" | "medication" | "environment" | "biologic" | undefined
> = {
  FOOD: "food",
  MEDICATION: "medication",
  ENVIRONMENT: "environment",
  BIOLOGIC: "biologic",
  OTHER: undefined,
};

/** Record severity → the fixed `reaction.severity` value set. */
const ALLERGY_SEVERITY: Record<string, "mild" | "moderate" | "severe"> = {
  MILD: "mild",
  MODERATE: "moderate",
  SEVERE: "severe",
};

const ALLERGY_TYPE: Record<string, "allergy" | "intolerance"> = {
  ALLERGY: "allergy",
  INTOLERANCE: "intolerance",
};

/**
 * Emit one `AllergyIntolerance` per record. Ids run `allergy-1..N`. The
 * substance rides `code.text`; the broad category + clinical/verification
 * status carry their FHIR-fixed codings. `verificationStatus` is always
 * `unconfirmed` (patient-reported). The decrypted reaction free-text rides
 * `reaction[].manifestation.text` with the graded severity; an explicit note
 * marks the record as self-recorded.
 */
export function allergyIntoleranceResources(
  allergies: AllergyDTO[],
): FhirAllergyIntolerance[] {
  const out: FhirAllergyIntolerance[] = [];
  let seq = 0;
  for (const a of allergies) {
    seq += 1;
    const clinical =
      ownValue(ALLERGY_CLINICAL, a.status) ?? ALLERGY_CLINICAL.ACTIVE;
    const category = ownValue(ALLERGY_CATEGORY, a.category);
    const severity = a.severity
      ? ownValue(ALLERGY_SEVERITY, a.severity)
      : undefined;
    const resource: FhirAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      id: `allergy-${seq}`,
      clinicalStatus: {
        coding: [
          {
            system: ALLERGY_CLINICAL_SYSTEM,
            code: clinical.code,
            display: clinical.display,
          },
        ],
      },
      verificationStatus: {
        coding: [
          {
            system: ALLERGY_VERIFICATION_SYSTEM,
            // Patient-reported record → "unconfirmed", never clinician-confirmed.
            code: "unconfirmed",
            display: "Unconfirmed",
          },
        ],
      },
      type: ownValue(ALLERGY_TYPE, a.type) ?? "allergy",
      ...(category ? { category: [category] } : {}),
      ...(severity
        ? { criticality: severity === "severe" ? "high" : "low" }
        : {}),
      // The user's own substance label — never a machine-guessed code.
      code: { text: a.substance },
      patient: patientRef,
      ...(a.onsetAt ? { onsetDateTime: a.onsetAt } : {}),
      note: [
        {
          text: "Self-recorded allergy/intolerance; patient-reported, not a clinical diagnosis.",
        },
        ...(a.note ? [{ text: a.note }] : []),
      ],
    };
    if (a.reaction) {
      resource.reaction = [
        {
          manifestation: [{ text: a.reaction }],
          ...(severity ? { severity } : {}),
        },
      ];
    }
    out.push(resource);
  }
  return out;
}

const ROLE_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-RoleCode";

/**
 * Record relationship → HL7 v3 `RoleCode` family-member concept (the fixed
 * code system FHIR `FamilyMemberHistory.relationship` examples use). `OTHER`
 * falls back to the generic `FAMMEMB` (family member) concept — an honest
 * fallback, never a fabricated specific relation. `display` carries a stable
 * English label; the localized label lives on the client surface.
 */
const RELATIONSHIP_ROLE: Record<string, { code: string; display: string }> = {
  MOTHER: { code: "MTH", display: "Mother" },
  FATHER: { code: "FTH", display: "Father" },
  SISTER: { code: "SIS", display: "Sister" },
  BROTHER: { code: "BRO", display: "Brother" },
  DAUGHTER: { code: "DAUC", display: "Daughter" },
  SON: { code: "SONC", display: "Son" },
  GRANDMOTHER_MATERNAL: { code: "MGRMTH", display: "Maternal grandmother" },
  GRANDFATHER_MATERNAL: { code: "MGRFTH", display: "Maternal grandfather" },
  GRANDMOTHER_PATERNAL: { code: "PGRMTH", display: "Paternal grandmother" },
  GRANDFATHER_PATERNAL: { code: "PGRFTH", display: "Paternal grandfather" },
  AUNT: { code: "AUNT", display: "Aunt" },
  UNCLE: { code: "UNCLE", display: "Uncle" },
  COUSIN: { code: "COUSN", display: "Cousin" },
  HALF_SIBLING: { code: "HSIB", display: "Half-sibling" },
  OTHER: { code: "FAMMEMB", display: "Family member" },
};

/**
 * Emit one `FamilyMemberHistory` per entry (one condition each). Ids run
 * `famhist-1..N`. The relationship carries the v3 RoleCode coding + a readable
 * `.text`; the condition rides `condition[].code.text` (no machine-guessed
 * code) with an optional `onsetAge` in years (UCUM `a`). `status: "completed"`.
 */
export function familyMemberHistoryResources(
  entries: FamilyHistoryEntryDTO[],
): FhirFamilyMemberHistory[] {
  const out: FhirFamilyMemberHistory[] = [];
  let seq = 0;
  for (const e of entries) {
    seq += 1;
    const role =
      ownValue(RELATIONSHIP_ROLE, e.relationship) ?? RELATIONSHIP_ROLE.OTHER;
    out.push({
      resourceType: "FamilyMemberHistory",
      id: `famhist-${seq}`,
      status: "completed",
      patient: patientRef,
      relationship: {
        coding: [
          { system: ROLE_CODE_SYSTEM, code: role.code, display: role.display },
        ],
        text: role.display,
      },
      condition: [
        {
          // The user's own condition label — never a machine-guessed code.
          code: { text: e.condition },
          ...(e.ageAtOnset !== null
            ? {
                onsetAge: {
                  value: e.ageAtOnset,
                  unit: "a",
                  system: "http://unitsofmeasure.org",
                  code: "a",
                },
              }
            : {}),
        },
      ],
      note: [
        {
          text: "Self-recorded family history; patient-reported, not a clinical diagnosis.",
        },
        ...(e.note ? [{ text: e.note }] : []),
      ],
    });
  }
  return out;
}
