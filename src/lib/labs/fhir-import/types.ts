/**
 * Shared shapes of the FHIR lab import (#1400): lab results from Apple
 * Health's Health Records, arriving either inside an `export.zip`
 * (`src/lib/apple-health/clinical-labs-import.ts`) or from the iOS app
 * (`POST /api/labs/fhir-batch`). Both paths map with `mapFhirLabRecord` and
 * write with `writeFhirLabReadings`, so a result reads the same however it
 * came in.
 *
 * Nothing about a resource's content leaves this module family except the
 * reading it maps to: reasons are closed enums, counts are numbers.
 */

/** `LabResult.source` of every reading this import writes. */
export const APPLE_HEALTH_LAB_SOURCE = "APPLE_HEALTH";

/** One clinical record as the export or HealthKit hands it over. */
export interface FhirLabRecordInput {
  /** The parsed FHIR resource. Untrusted: every field is checked. */
  resource: unknown;
  /** `HKFHIRResource.fhirVersion` / `fhirVersion` attribute, e.g. "4.0.1". */
  fhirVersion?: string | null;
  /** `HKFHIRResource.identifier` / `identifier` attribute. */
  identifier?: string | null;
  /** `HKFHIRResource.sourceURL` / `sourceURL` attribute. */
  sourceURL?: string | null;
  /** The institution as the Health app names it. */
  sourceName?: string | null;
  /**
   * The record reached the mapper for its FHIR resource type or file name,
   * not as a HealthKit lab-result record: an Observation without a category
   * is then skipped `not_lab` instead of taken.
   */
  requireLabCategory?: boolean;
}

/** A lab reading a FHIR Observation maps to, before any marker is chosen. */
export interface MappedFhirLab {
  externalId: string;
  analyte: string;
  /** The LOINC code the resource carries, when it carries one. */
  loinc: string | null;
  /** The catalog slug the LOINC code names, used as a matching hint. */
  catalogKey: string | null;
  value: number | null;
  valueText: string | null;
  /** Unit in the spelling the labs feature uses; null for a text result. */
  unit: string | null;
  takenAt: Date;
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
  panel: string | null;
  note: string | null;
}

export const FHIR_LAB_SKIP_REASONS = [
  "not_observation",
  "not_lab",
  "not_final",
  "withdrawn",
  "panel_header",
  "no_value",
  "unsupported_value",
  "no_date",
  "future_date",
  "invalid_date",
  "too_large",
] as const;
export type FhirLabSkipReason = (typeof FHIR_LAB_SKIP_REASONS)[number];

export const FHIR_LAB_FAILURE_REASONS = [
  "missing_unit",
  "unit_mismatch",
  "text_too_long",
  "write_failed",
] as const;
export type FhirLabFailureReason = (typeof FHIR_LAB_FAILURE_REASONS)[number];

/**
 * Why an archive's Health Records file was not read: a reference that names
 * no safe file, a file over a limit, an unreadable file or archive.
 */
export const FHIR_LAB_ARCHIVE_REASONS = [
  "over_limit",
  "bad_reference",
  "member_too_large",
  "member_unsupported",
  "malformed_json",
  "archive_unreadable",
  "missing_member",
] as const;

/** Every reason an import counts a result as skipped or failed. */
export const FHIR_LAB_IMPORT_REASONS = [
  ...FHIR_LAB_SKIP_REASONS,
  ...FHIR_LAB_FAILURE_REASONS,
  ...FHIR_LAB_ARCHIVE_REASONS,
] as const;
export type FhirLabImportReason = (typeof FHIR_LAB_IMPORT_REASONS)[number];

export function isFhirLabImportReason(
  value: string,
): value is FhirLabImportReason {
  return (FHIR_LAB_IMPORT_REASONS as readonly string[]).includes(value);
}

/** Bounded outcome counts, the only thing an import reports. */
export interface FhirLabCounts {
  /** Lab result records the source offered. */
  discovered: number;
  /** Readings written. */
  imported: number;
  /** Readings the record already held (by identity or by value). */
  duplicate: number;
  /** Records that are not a reading HealthLog keeps (a panel header, a
   *  preliminary result, a vital sign). */
  skipped: number;
  /** Readings refused (no unit, a unit the marker cannot take) or unreadable. */
  failed: number;
  /** Markers added to Labs because no existing marker took the reading. */
  markersCreated: number;
  /**
   * The skipped and failed results by reason (#1421), so the person can see
   * what the two counts are made of. Closed reasons only, never content.
   */
  reasons: Partial<Record<FhirLabImportReason, number>>;
}

export function emptyFhirLabCounts(): FhirLabCounts {
  return {
    discovered: 0,
    imported: 0,
    duplicate: 0,
    skipped: 0,
    failed: 0,
    markersCreated: 0,
    reasons: {},
  };
}

/** Per-input outcome of a write. */
export type FhirLabWriteStatus =
  | { status: "inserted" }
  | { status: "duplicate" }
  | { status: "failed"; reason: FhirLabFailureReason };
