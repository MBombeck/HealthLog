/**
 * Narrow hand-rolled HL7 FHIR R4 type surface.
 *
 * Only the fields HealthLog emits — deliberately NOT the full `@types/fhir`
 * (multi-MB) or a FHIR SDK, mirroring the project's "hand-rolled fetch over
 * the documented wire, no vendor SDKs" convention for AI providers.
 *
 * Reference: https://hl7.org/fhir/R4/
 */

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirReference {
  reference: string;
  display?: string;
}

export interface FhirIdentifier {
  system?: string;
  value: string;
}

export interface FhirHumanName {
  text?: string;
  family?: string;
  given?: string[];
}

export interface FhirQuantity {
  value: number;
  unit?: string;
  system?: string; // UCUM: http://unitsofmeasure.org
  code?: string;
}

export interface FhirNarrative {
  status: "generated" | "extensions" | "additional" | "empty";
  div: string; // escaped xhtml
}

export interface FhirObservationComponent {
  code: FhirCodeableConcept;
  valueQuantity?: FhirQuantity;
  valueInteger?: number;
  valueString?: string;
}

export interface FhirPatient {
  resourceType: "Patient";
  id: string;
  identifier?: FhirIdentifier[];
  name?: FhirHumanName[];
  gender?: "male" | "female" | "other" | "unknown";
  birthDate?: string; // YYYY-MM-DD
}

export interface FhirObservation {
  resourceType: "Observation";
  id: string;
  status: "final";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectiveDateTime?: string;
  valueQuantity?: FhirQuantity;
  valueInteger?: number;
  valueString?: string;
  component?: FhirObservationComponent[];
}

export interface FhirDosage {
  text?: string;
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirMedicationStatement {
  resourceType: "MedicationStatement";
  id: string;
  status: "active" | "completed" | "stopped" | "unknown";
  medicationCodeableConcept: FhirCodeableConcept;
  subject: FhirReference;
  effectivePeriod?: FhirPeriod;
  dosage?: FhirDosage[];
}

export interface FhirDiagnosticReport {
  resourceType: "DiagnosticReport";
  id: string;
  status: "final";
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectivePeriod?: FhirPeriod;
  result?: FhirReference[];
}

export interface FhirCompositionSection {
  title: string;
  code?: FhirCodeableConcept;
  text?: FhirNarrative;
  entry?: FhirReference[];
}

export interface FhirComposition {
  resourceType: "Composition";
  id: string;
  status: "final";
  type: FhirCodeableConcept;
  subject: FhirReference;
  date: string;
  author: FhirReference[];
  title: string;
  section?: FhirCompositionSection[];
}

export type FhirResource =
  | FhirComposition
  | FhirPatient
  | FhirObservation
  | FhirMedicationStatement
  | FhirDiagnosticReport;

export interface FhirBundleEntry {
  fullUrl?: string;
  resource: FhirResource;
}

export interface FhirBundle {
  resourceType: "Bundle";
  type: "document";
  timestamp: string;
  entry: FhirBundleEntry[];
}
