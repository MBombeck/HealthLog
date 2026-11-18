/**
 * v1.11.0 — shared per-resource FHIR R4 emitters.
 *
 * The Observation / MedicationStatement / MedicationAdministration / Patient /
 * Coverage / Condition / Encounter / cycle / anamnesis builders (with their
 * LOINC/ATC/SNOMED/UCUM codings and the `survey` wellness split) are small pure
 * functions over the SAME `DoctorReportData` the document-bundle builder
 * consumes. This barrel is their one public face: `buildFhirDocumentBundle`
 * composes them into a `type: "document"` Bundle, and the FHIR REST routes wrap
 * them in a `type: "searchset"` Bundle. The coding logic has exactly one home,
 * so the document export and the REST face can never drift apart.
 *
 * No FHIR SDK, no `@types/fhir` — narrow hand-rolled interfaces only
 * (`../types`), matching the project's "hand-rolled over the documented wire"
 * convention. All text is escaped plain text; never user-supplied HTML
 * (no markdown library, no `dangerouslySetInnerHTML`).
 */
export {
  ATC_SYSTEM,
  SNOMED_SYSTEM,
  GERMAN_ATC_DEFAULT_LOCALES,
  PATIENT_RESOURCE_ID,
  type FhirBuildOptions,
  type FhirPatientIdentity,
} from "@/lib/fhir/resources/common";

export {
  administrativeGender,
  patientResource,
} from "@/lib/fhir/resources/patient";
export { coverageResource } from "@/lib/fhir/resources/coverage";
export { observationsFromReportData } from "@/lib/fhir/resources/observation";
export { cycleObservationsFromReportData } from "@/lib/fhir/resources/cycle";
export {
  anamnesisNarrativeFromReportData,
  anamnesisObservationsFromReportData,
} from "@/lib/fhir/resources/anamnesis";
export { conditionsFromReportData } from "@/lib/fhir/resources/conditions";
export {
  seizureBundleResources,
  seizureCompositionSection,
} from "@/lib/fhir/resources/seizures";
export {
  medicationStatementsFromReportData,
  medicationAdministrationsFromReportData,
} from "@/lib/fhir/resources/medications";
