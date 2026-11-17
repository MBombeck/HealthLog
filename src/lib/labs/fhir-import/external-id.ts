/**
 * The identity a FHIR lab result is stored under (`LabResult.externalId`).
 *
 * The same result reaches HealthLog from two directions: inside an Apple
 * Health export (`export.xml` names the issuing institution in `sourceURL`
 * and the record in `identifier`, the JSON file carries the resource) and
 * from the iOS app (`HKFHIRResource` carries the same `sourceURL`,
 * `identifier` and data). The identity is built from those, so both paths
 * land on one id and the second sees a duplicate.
 *
 * Only a digest is stored: the issuer's URL and the record identifier are
 * hashed together and cut to 40 hex characters, which is enough to keep two
 * results of one account apart and says nothing about either.
 *
 * A record with neither an identifier nor a resource id falls back to a
 * content identity: the issuer, the LOINC code, the name, the instant and the
 * value. Stable across re-imports of the same record; a corrected result
 * whose value changed reads as a new one.
 */
import { createHash } from "node:crypto";

const DIGEST_HEX = 40;

function digest(parts: readonly string[]): string {
  return createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, DIGEST_HEX);
}

/** The institution that issued a record, as one stable string. */
export function fhirLabIssuer(input: {
  sourceURL?: string | null;
  sourceName?: string | null;
}): string {
  const url = input.sourceURL?.trim().toLowerCase().replace(/\/+$/u, "");
  if (url) return url;
  const name = input.sourceName?.trim();
  if (name) return name;
  return "unknown";
}

export function fhirLabExternalId(input: {
  sourceURL?: string | null;
  sourceName?: string | null;
  /** The record identifier, else the resource's own `id`. */
  identifier?: string | null;
  resourceId?: string | null;
  /** For the content fallback only. */
  loinc?: string | null;
  analyte: string;
  takenAt: Date;
  value: number | null;
  valueText: string | null;
}): string {
  const issuer = fhirLabIssuer(input);
  const id = input.identifier?.trim() || input.resourceId?.trim();
  if (id) return `fhir:${digest([issuer, "Observation", id])}`;
  return `fhirc:${digest([
    issuer,
    input.loinc ?? "",
    input.analyte.trim().toLowerCase(),
    input.takenAt.toISOString(),
    input.value !== null ? String(input.value) : (input.valueText ?? ""),
  ])}`;
}
