/**
 * A `<ClinicalRecord>` in `export.xml`, as a reference to the lab result it
 * describes (#1400).
 *
 * Apple writes one element per Health Records resource:
 *
 *   <ClinicalRecord type="HKClinicalTypeIdentifierLabResultRecord"
 *     identifier="…" sourceName="…" sourceURL="…" fhirVersion="4.0.1"
 *     receivedDate="…" resourceFilePath="/clinical-records/….json"/>
 *
 * The resource itself is the JSON file the path names. Only lab results are
 * handed on; every other clinical type (conditions, medications, vital signs,
 * immunisations) is left to the caller's skipped count. The attributes are
 * capped here so a hostile export cannot make the parser hold long strings.
 */

export const HK_LAB_RESULT_RECORD = "HKClinicalTypeIdentifierLabResultRecord";

export interface ClinicalLabReference {
  /** `resourceFilePath`, from the export root. Null when Apple wrote none. */
  path: string | null;
  identifier: string | null;
  sourceURL: string | null;
  sourceName: string | null;
  fhirVersion: string | null;
}

const CAPS = {
  path: 512,
  identifier: 256,
  sourceURL: 2048,
  sourceName: 200,
  fhirVersion: 16,
} as const;

function capped(raw: string | undefined, max: number): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Hand a lab-result record to `onLab` and return true; return false for any
 * other record, or when there is no callback, so the caller counts it as
 * skipped.
 */
export function routeClinicalRecord(
  attrs: Record<string, string | undefined>,
  onLab?: (ref: ClinicalLabReference) => void,
): boolean {
  if (!onLab || attrs.type !== HK_LAB_RESULT_RECORD) return false;
  onLab({
    path: capped(attrs.resourceFilePath, CAPS.path),
    identifier: capped(attrs.identifier, CAPS.identifier),
    sourceURL: capped(attrs.sourceURL, CAPS.sourceURL),
    sourceName: capped(attrs.sourceName, CAPS.sourceName),
    fhirVersion: capped(attrs.fhirVersion, CAPS.fhirVersion),
  });
  return true;
}
