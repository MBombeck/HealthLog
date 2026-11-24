/**
 * Import a FHIR R4 Bundle (JSON) from a patient portal export.
 *
 *   - Observations in the `laboratory` category go through the Health Records
 *     lab mapping (`src/lib/labs/fhir-import/`): the same mapper, panel
 *     naming, unit normalisation and writer as the Apple Health path, under
 *     the source IMPORT, deduplicated by the resource's identity.
 *   - Observations in the `vital-signs` category become measurements by a
 *     closed LOINC table (`./vitals.ts`), under the source IMPORT with an
 *     identity digested from the issuer and the resource id.
 *   - Conditions, Immunizations, MedicationStatements and Encounters become
 *     the record's own rows (`./records.ts`), deduplicated through the
 *     import ledger by resource id.
 *   - Every other resource type is counted as skipped by type.
 *
 * The issuer is the base of the entries' `fullUrl` (a server's resource ids
 * are unique only on that server), else the Bundle's own id. Bounds: the
 * file size cap at upload, at most {@link MAX_ENTRIES} entries, the shared
 * time budget checked per entry.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterLabReadingsWritten } from "@/lib/labs/fhir-import/after-write";
import {
  assignPanels,
  mapFhirLabRecord,
  type FhirLabMapping,
} from "@/lib/labs/fhir-import/map-observation";
import type { MappedFhirLab } from "@/lib/labs/fhir-import/types";
import { writeFhirLabReadings } from "@/lib/labs/fhir-import/write";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { importValue } from "@/lib/integrations/import-value";

import {
  FHIR_BUNDLE_MAX_UPLOAD_BYTES,
  RecordFileImportError,
} from "../file-import/kinds";
import type { RecordFileImportTally } from "../file-import/tally";
import {
  writeImportedMeasurements,
  type ImportedMeasurement,
} from "../file-import/write-measurements";
import { arr, firstInstant, obj, str, type Json } from "./fields";
import {
  importRecordResource,
  RECORD_LINE,
  RECORD_RESOURCE_TYPES,
  type RecordResourceType,
} from "./records";
import { BP_PANEL_CODES, loincCodes, VITAL_LOINC, vitalValue } from "./vitals";

export const MAX_ENTRIES = 50_000;
/** `LabResult.source` and `Measurement.source` of what this import writes. */
export const FHIR_FILE_SOURCE = "IMPORT";

function categories(resource: Json): string[] {
  const out: string[] = [];
  for (const category of arr(resource.category)) {
    for (const coding of arr(obj(category)?.coding)) {
      const code = str(obj(coding)?.code, 64);
      if (code) out.push(code.toLowerCase());
    }
  }
  return out;
}

/**
 * The namespace a resource's id is unique in: the server it came from (the
 * `fullUrl` without its type and id). A `urn:uuid:` or `urn:oid:` fullUrl
 * names no server, and its id is unique on its own, so it needs none: a
 * patient summary or a portal export writes these with a new `Bundle.id`
 * every time, and keying them on the Bundle would import every resource of
 * the next export of the same record again. Only a resource with neither
 * falls back to its Bundle.
 */
function issuerOf(fullUrl: unknown, bundleId: string): string {
  const url = str(fullUrl, 500);
  if (url && /^https?:\/\//i.test(url)) {
    return url.replace(/\/[A-Za-z]+\/[^/]+\/?$/u, "").toLowerCase();
  }
  if (url && /^urn:(uuid|oid):/i.test(url)) return "urn";
  return `bundle:${bundleId}`;
}

function vitalId(issuer: string, resource: Json, suffix: string): string {
  const id = str(resource.id, 128) ?? JSON.stringify(resource).slice(0, 2000);
  const digest = createHash("sha256")
    .update(`${issuer}\u0000Observation\u0000${id}`)
    .digest("hex")
    .slice(0, 40);
  return `fhirb:${digest}${suffix}`;
}

/** A vital-sign Observation as measurement rows, or the reason it has none. */
export function mapVital(
  resource: Json,
  issuer: string,
  now: Date,
): ImportedMeasurement[] | { reason: string } {
  const status = str(resource.status, 32)?.toLowerCase();
  if (status && !["final", "amended", "corrected"].includes(status)) {
    return { reason: "not_final" };
  }
  const at = firstInstant(
    resource.effectiveDateTime,
    obj(resource.effectivePeriod)?.start,
    resource.issued,
  );
  if (!at) return { reason: "no_date" };
  if (at > now) return { reason: "future_date" };
  const codes = loincCodes(resource.code);
  const rows: ImportedMeasurement[] = [];
  if (codes.some((c) => BP_PANEL_CODES.has(c))) {
    for (const component of arr(resource.component)) {
      const c = obj(component);
      const code = loincCodes(c?.code).find((x) => VITAL_LOINC[x]);
      if (!c || !code) continue;
      const spec = VITAL_LOINC[code]!;
      const value = vitalValue(spec, c.valueQuantity);
      if ("reason" in value) return { reason: value.reason };
      rows.push({
        type: spec.type,
        value: value.value,
        measuredAt: at,
        externalId: vitalId(issuer, resource, `:${code}`),
      });
    }
    return rows.length > 0 ? rows : { reason: "no_value" };
  }
  const code = codes.find((c) => VITAL_LOINC[c]);
  if (!code) return { reason: "unsupported_vital" };
  const spec = VITAL_LOINC[code]!;
  const value = vitalValue(spec, resource.valueQuantity);
  if ("reason" in value) return { reason: value.reason };
  return [
    {
      type: spec.type,
      value: importValue(value.value),
      measuredAt: at,
      externalId: vitalId(issuer, resource, ""),
    },
  ];
}

export async function importFhirBundleFile(input: {
  userId: string;
  path: string;
  tz: string;
  tally: RecordFileImportTally;
}): Promise<void> {
  const buffer = await readFile(input.path);
  if (buffer.length > FHIR_BUNDLE_MAX_UPLOAD_BYTES) {
    throw new RecordFileImportError("too_large", "the file is over the cap");
  }
  let bundle: Json | null;
  try {
    bundle = obj(JSON.parse(buffer.toString("utf8")));
  } catch {
    throw new RecordFileImportError("not_fhir_bundle", "the file is not JSON");
  }
  if (!bundle || bundle.resourceType !== "Bundle") {
    throw new RecordFileImportError(
      "not_fhir_bundle",
      "the file is not a FHIR Bundle",
    );
  }
  const entries = arr(bundle.entry);
  if (entries.length > MAX_ENTRIES) {
    throw new RecordFileImportError(
      "too_many_entries",
      `the Bundle has more than ${MAX_ENTRIES} entries`,
    );
  }
  await importEntries(input, entries, str(bundle.id, 128) ?? "unnamed");
}

async function importEntries(
  input: { userId: string; tz: string; tally: RecordFileImportTally },
  entries: unknown[],
  bundleId: string,
): Promise<void> {
  const { tally, userId } = input;
  const now = new Date();
  const labs: Array<{ mapping: FhirLabMapping }> = [];
  const vitals: ImportedMeasurement[] = [];
  let medications = 0;
  for (const raw of entries) {
    if (tally.outOfTime()) break;
    const entry = obj(raw);
    const resource = obj(entry?.resource);
    const type = str(resource?.resourceType, 64);
    if (!resource || !type) {
      tally.skip("entry", "no_resource");
      continue;
    }
    const issuer = issuerOf(entry?.fullUrl, bundleId);
    if (type === "Observation") {
      const cats = categories(resource);
      if (cats.includes("laboratory")) {
        labs.push({
          mapping: mapFhirLabRecord(
            { resource, fhirVersion: "4.0.1", sourceURL: issuer },
            now,
          ),
        });
      } else if (cats.includes("vital-signs")) {
        const mapped = mapVital(resource, issuer, now);
        if ("reason" in mapped) tally.skip("Observation", mapped.reason);
        else vitals.push(...mapped);
      } else {
        tally.skip("Observation", "unsupported_category");
      }
      continue;
    }
    if ((RECORD_RESOURCE_TYPES as readonly string[]).includes(type)) {
      const recordType = type as RecordResourceType;
      const outcome = await importRecordResource({
        userId,
        issuer,
        type: recordType,
        resource,
        now,
      });
      const line = RECORD_LINE[recordType];
      if (outcome.status === "imported") {
        tally.imported(line);
        if (recordType === "MedicationStatement") medications += 1;
      } else if (outcome.status === "duplicate") tally.duplicate(line);
      else tally.skip(type, outcome.reason);
      continue;
    }
    tally.skip(type, "unsupported_type");
  }
  if (medications > 0) invalidateUserMedications(userId, { evict: true });
  await writeImportedMeasurements(userId, vitals, tally, {
    skipKey: "Observation",
  });
  await writeLabs(input, labs);
}

async function writeLabs(
  input: { userId: string; tz: string; tally: RecordFileImportTally },
  labs: Array<{ mapping: FhirLabMapping }>,
): Promise<void> {
  const { tally } = input;
  assignPanels(labs.map((l) => l.mapping));
  const readings: MappedFhirLab[] = [];
  for (const { mapping } of labs) {
    if (mapping.kind === "reading") readings.push(mapping.reading);
    else if (mapping.kind === "skip") tally.skip("Observation", mapping.reason);
    else tally.failed("Observation", mapping.reason);
  }
  if (readings.length === 0) return;
  const written = await writeFhirLabReadings({
    userId: input.userId,
    tz: input.tz,
    readings,
    source: FHIR_FILE_SOURCE,
  });
  for (const status of written.statuses) {
    if (status.status === "inserted") tally.imported("lab");
    else if (status.status === "duplicate") tally.duplicate("lab");
    else tally.failed("Observation", status.reason);
  }
  afterLabReadingsWritten({
    userId: input.userId,
    inserted: written.inserted,
    newestTakenAt: written.newestTakenAt,
    source: "fhir_bundle",
  });
}
