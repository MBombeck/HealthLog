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
 * Current exports write the FHIR resource type into `type` instead:
 *
 *   <ClinicalRecord type="Observation" … fhirVersion="4.0.1"
 *     resourceFilePath="/clinical-records/Observation-<id>.json"/>
 *
 * Both forms are read. A HealthKit identifier decides on its own (only the
 * lab-result type is handed on, so a vital-sign record is never opened). A
 * FHIR resource type hands on every `Observation`, DSTU2 (1.0.2) and R4
 * alike; the lab mapper then keeps the laboratory ones and counts the rest
 * (vital signs, surveys) as skipped. Without a `type`, the file name's
 * resource-type prefix stands in for it. A `DiagnosticReport` is not handed
 * on: panels come from an Observation's own members, and the mapper reads
 * nothing else. Every other resource (conditions, medications, immunisations,
 * documents, the patient) is left to the caller's skipped count.
 *
 * The attributes are capped here so a hostile export cannot make the parser
 * hold long strings.
 */

export const HK_LAB_RESULT_RECORD = "HKClinicalTypeIdentifierLabResultRecord";
const HK_CLINICAL_TYPE_PREFIX = "HKClinicalTypeIdentifier";
const FHIR_OBSERVATION = "Observation";

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

function withinCap(raw: string | undefined, max: number): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

/** The FHIR resource type a file name starts with: `Observation-<id>.json`. */
function resourceTypeFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const match = /^([A-Za-z]+)-[^/]*\.json$/.exec(base);
  return match ? match[1] : null;
}

function isLabCandidate(attrs: Record<string, string | undefined>): boolean {
  const type = attrs.type?.trim() ?? "";
  if (type.startsWith(HK_CLINICAL_TYPE_PREFIX)) {
    return type === HK_LAB_RESULT_RECORD;
  }
  if (type !== "") return type === FHIR_OBSERVATION;
  return resourceTypeFromPath(attrs.resourceFilePath) === FHIR_OBSERVATION;
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
  if (!onLab || !isLabCandidate(attrs)) return false;
  onLab({
    path: withinCap(attrs.resourceFilePath, CAPS.path),
    identifier: withinCap(attrs.identifier, CAPS.identifier),
    sourceURL: withinCap(attrs.sourceURL, CAPS.sourceURL),
    sourceName: withinCap(attrs.sourceName, CAPS.sourceName),
    fhirVersion: withinCap(attrs.fhirVersion, CAPS.fhirVersion),
  });
  return true;
}
