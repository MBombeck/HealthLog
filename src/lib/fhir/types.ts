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
  /**
   * Element extensions. Only `Condition.bodySite` carries one today (the core
   * `bodySite` extension pointing at a contained `BodyStructure`).
   */
  extension?: FhirExtension[];
  coding?: FhirCoding[];
  text?: string;
}

/** R4 `Extension`, narrowed to the one value type HealthLog emits. */
export interface FhirExtension {
  url: string;
  valueReference: FhirReference;
}

export interface FhirReference {
  reference: string;
  display?: string;
}

/**
 * R4 `Identifier`. `system` is REQUIRED here even though the spec marks it
 * `0..1`: a bare value with no namespace is not resolvable by a receiver, and
 * every identifier HealthLog emits (KVNR, IKNR, bundle id) has a real
 * namespace. Requiring it is what stops a namespace-less identifier from
 * type-checking.
 */
export interface FhirIdentifier {
  system: string;
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

/** R4 `Annotation` — a free-text note attached to a resource. */
export interface FhirAnnotation {
  text: string;
}

export interface FhirObservation {
  resourceType: "Observation";
  id: string;
  status: "final";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectiveDateTime?: string;
  /**
   * R4 `Observation.effective[x]` as a period. Carries the reporting window
   * for an aggregate that describes a SPAN rather than an instant (a mean, a
   * time-in-range share, an adherence rate, a period average). Pinning such a
   * value to a single `effectiveDateTime` asserts an instant reading that was
   * never taken.
   */
  effectivePeriod?: FhirPeriod;
  valueQuantity?: FhirQuantity;
  valueInteger?: number;
  valueString?: string;
  /** v1.15.0 — date-typed value (e.g. the LMP start date). */
  valueDateTime?: string;
  valueCodeableConcept?: FhirCodeableConcept;
  /**
   * R4 `Observation.dataAbsentReason`. Used when a selected fact has no
   * readable value so omission cannot be mistaken for deselection.
   */
  dataAbsentReason?: FhirCodeableConcept;
  component?: FhirObservationComponent[];
  /** v1.10.0 — descriptive note (e.g. the wellness-score disclaimer). */
  note?: FhirAnnotation[];
  /**
   * v1.17.1 — R4 `Observation.referenceRange`. Carries the lab's reported
   * normal bounds for a structured lab result; either bound may be absent
   * (a lab may report only an upper or lower limit).
   */
  referenceRange?: FhirObservationReferenceRange[];
}

/** R4 `Observation.referenceRange` element. */
export interface FhirObservationReferenceRange {
  low?: FhirQuantity;
  high?: FhirQuantity;
  /**
   * R4 `referenceRange.text`. Carries the window the source report printed,
   * verbatim, when the reading has one. A receiver that cannot use the bounds
   * (because the report stated a qualitative window like "negativ", or a
   * one-sided one) still reads what the lab wrote.
   */
  text?: string;
}

export interface FhirDosage {
  text?: string;
  /**
   * v1.9.0 — structured dose `Quantity`. On a `MedicationAdministration`
   * a `dosage` SHALL carry at least one of `dose` or `rate` (R4
   * invariant), so the builder only emits a `dosage` block when a `dose`
   * is available; a text-only dose stays on the `MedicationStatement`.
   */
  dose?: FhirQuantity;
  /** Route of administration: an additive SNOMED `coding` plus the `.text` anchor. */
  route?: FhirCodeableConcept;
  /** Administration body-site (e.g. injection site): additive SNOMED `coding` plus `.text`. */
  site?: FhirCodeableConcept;
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirMedicationStatement {
  resourceType: "MedicationStatement";
  id: string;
  status: "active" | "completed" | "intended" | "stopped" | "unknown";
  medicationCodeableConcept: FhirCodeableConcept;
  subject: FhirReference;
  effectivePeriod?: FhirPeriod;
  dosage?: FhirDosage[];
}

export interface FhirMedicationAdministration {
  resourceType: "MedicationAdministration";
  id: string;
  /**
   * v1.9.0 — only `completed` (a taken dose) or `not-done` (an explicit
   * skip) are emitted; the exporter never asserts an administration for a
   * pending / missed slot or a soft-deleted tombstone.
   */
  status: "completed" | "not-done";
  /** Self-describing concept — the same ATC/RxNorm + text the statement carries. */
  medicationCodeableConcept: FhirCodeableConcept;
  subject: FhirReference;
  /**
   * `takenAt` for a `completed` administration, `scheduledFor` (the
   * intended instant) for a `not-done` skip.
   */
  effectiveDateTime: string;
  /** Single dosage (R4 `0..1`). Present only when a structured `dose` exists. */
  dosage?: FhirDosage;
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

export interface FhirOrganization {
  resourceType: "Organization";
  id: string;
  identifier?: FhirIdentifier[];
  name?: string;
}

export interface FhirCoverage {
  resourceType: "Coverage";
  id: string;
  status: "active" | "cancelled" | "draft" | "entered-in-error";
  /** Inline payor Organization, referenced from `payor` via a local `#`-ref. */
  contained?: FhirOrganization[];
  /** The covered party — Reference(Patient). */
  beneficiary: FhirReference;
  /** German KVNR (the subscriber's member id), when present. */
  subscriberId?: string;
  /**
   * Insurer(s) — Reference to the contained Organization. R4 marks this `1..*`;
   * required here so a payor-less Coverage cannot be constructed. A record that
   * knows only a member id emits no Coverage at all (the member id rides
   * `Patient.identifier`).
   */
  payor: FhirReference[];
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
  /**
   * v1.9.0 — top-level document narrative. Section narrative is already
   * present; a strict US-Core-style validator additionally expects a
   * `Composition.text`. Reuses the same escaped plain-text summary.
   */
  text?: FhirNarrative;
  section?: FhirCompositionSection[];
}

/**
 * v1.18.1 P4 — R4 `Condition`. Carries the illness/condition episode the
 * journal records: a `code` (SNOMED 64572001 "Disease" as the safe non-
 * diagnostic root + a `.text` label), the clinical + verification status, an
 * onset, and (when resolved) an `abatementDateTime`. HealthLog does NOT assert
 * a specific ICD/SNOMED diagnosis code — the journal is patient-recorded and
 * not a diagnosing device — so the coding stays the generic root and the
 * user's label rides `code.text`.
 */
export interface FhirCondition {
  resourceType: "Condition";
  id: string;
  /**
   * v1.39.3 — the `BodyStructure` that carries the side of the body site,
   * referenced from `bodySite[].extension` by a local `#`-ref.
   */
  contained?: FhirBodyStructure[];
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  /** v1.39.3 — where on the body, as the user wrote it (`text` only). */
  bodySite?: FhirCodeableConcept[];
  subject: FhirReference;
  onsetDateTime?: string;
  abatementDateTime?: string;
  recordedDate?: string;
  note?: FhirAnnotation[];
}

/**
 * v1.39.3 — R4 `BodyStructure`, emitted only as a resource contained in a
 * `Condition`. `location` repeats the free-text site; `locationQualifier`
 * carries the side as a SNOMED CT laterality concept. `patient` is `1..1` in
 * R4.
 */
export interface FhirBodyStructure {
  resourceType: "BodyStructure";
  id: string;
  location?: FhirCodeableConcept;
  locationQualifier?: FhirCodeableConcept[];
  patient: FhirReference;
}

/**
 * v1.18.1 P4 — R4 `Encounter`. Emitted alongside a resolved episode to bound
 * the period of care (onset → resolution) so a clinician sees the episode as a
 * time-boxed event. `status` is `finished` for a resolved episode and
 * `in-progress` for an ongoing one; `class` is the ambulatory code.
 */
export interface FhirEncounter {
  resourceType: "Encounter";
  id: string;
  status: "in-progress" | "finished";
  class: FhirCoding;
  subject: FhirReference;
  period?: FhirPeriod;
  reasonReference?: FhirReference[];
}

/**
 * v1.25 (W-RECORDS) — R4 `AllergyIntolerance`. A self-recorded allergy /
 * intolerance. `clinicalStatus`/`verificationStatus` carry "what the user
 * asserts" (verification is always `unconfirmed` — patient-reported, not a
 * clinician-confirmed diagnosis). The substance rides `code.text` (no
 * machine-guessed SNOMED/RxNorm code); the broad category rides `category[]`.
 */
export interface FhirAllergyIntolerance {
  resourceType: "AllergyIntolerance";
  id: string;
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  type?: "allergy" | "intolerance";
  category?: ("food" | "medication" | "environment" | "biologic")[];
  criticality?: "low" | "high" | "unable-to-assess";
  code: FhirCodeableConcept;
  patient: FhirReference;
  onsetDateTime?: string;
  reaction?: {
    manifestation: FhirCodeableConcept[];
    severity?: "mild" | "moderate" | "severe";
  }[];
  note?: FhirAnnotation[];
}

/**
 * v1.25 (W-RECORDS) — R4 `FamilyMemberHistory`. One relative's condition as
 * recorded by the user. `relationship` carries the SNOMED family-member
 * concept; the condition rides `condition[].code.text` (no machine-guessed
 * code). `status: "completed"` marks the record as captured. Patient-reported.
 */
export interface FhirFamilyMemberHistory {
  resourceType: "FamilyMemberHistory";
  id: string;
  status: "partial" | "completed" | "entered-in-error" | "health-unknown";
  patient: FhirReference;
  relationship: FhirCodeableConcept;
  condition?: {
    code: FhirCodeableConcept;
    onsetAge?: FhirQuantity;
  }[];
  note?: FhirAnnotation[];
}

/**
 * R4 `Device` — the software that authored the document. A `Composition.author`
 * pointing at a Device that is not in the bundle is a dangling reference, so
 * the document carries the Device it names. No serial number, no identifier,
 * no owner: the only honest facts are the software name, its maker and the
 * running version.
 */
export interface FhirDevice {
  resourceType: "Device";
  id: string;
  manufacturer?: string;
  deviceName?: { name: string; type: "manufacturer-name" }[];
  version?: { value: string }[];
}

export type FhirResource =
  | FhirComposition
  | FhirDevice
  | FhirPatient
  | FhirCoverage
  | FhirObservation
  | FhirMedicationStatement
  | FhirMedicationAdministration
  | FhirCondition
  | FhirEncounter
  | FhirAllergyIntolerance
  | FhirFamilyMemberHistory
  | FhirDiagnosticReport;

export interface FhirBundleEntry {
  /**
   * Absolute URL identifying the entry. Required: `bdl-7` makes it the only
   * thing an intra-bundle reference can resolve against, and an entry without
   * one is unreachable from the Composition that names it.
   */
  fullUrl: string;
  resource: FhirResource;
  /** v1.11.0 — `searchset` per-entry search metadata (`mode: "match"`). */
  search?: { mode: "match" | "include" | "outcome" };
}

export interface FhirBundle {
  resourceType: "Bundle";
  type: "document";
  /**
   * `bdl-9` — a document Bundle SHALL carry a persistent identifier with a
   * system and a value. Minted fresh per build: two exports of the same
   * record are two documents.
   */
  identifier: FhirIdentifier;
  timestamp: string;
  entry: FhirBundleEntry[];
}

/** v1.11.0 — `Bundle.link` relation (self / next paging). */
export interface FhirBundleLink {
  relation: "self" | "next";
  url: string;
}

/**
 * v1.11.0 — a `searchset` Bundle, the wire shape the FHIR REST search routes
 * return. `total` is the unpaged match count; `link` carries the self + next
 * relations for offset paging; each `entry.search.mode` is `"match"`.
 */
export interface FhirSearchsetBundle {
  resourceType: "Bundle";
  type: "searchset";
  timestamp: string;
  total: number;
  link?: FhirBundleLink[];
  entry: FhirBundleEntry[];
}

/** v1.11.0 — `OperationOutcome.issue` element. */
export interface FhirOperationOutcomeIssue {
  severity: "fatal" | "error" | "warning" | "information";
  code: string;
  diagnostics?: string;
}

/** v1.11.0 — `OperationOutcome`, the FHIR error envelope. */
export interface FhirOperationOutcome {
  resourceType: "OperationOutcome";
  issue: FhirOperationOutcomeIssue[];
}
