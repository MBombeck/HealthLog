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
import { prisma } from "@/lib/db";
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
import { jsonDeeperThan, UPLOADED_JSON_MAX_DEPTH } from "../json-depth";
import { arr, firstInstant, obj, str, type Json } from "./fields";
import {
  importRecordResource,
  RECORD_LINE,
  RECORD_RESOURCE_TYPES,
  type RecordResourceType,
} from "./records";
import { BP_PANEL_CODES, loincCodes, VITAL_LOINC, vitalValue } from "./vitals";
import { ownValue } from "@/lib/own-key";

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
  tz: string,
): ImportedMeasurement[] | { reason: string } {
  const status = str(resource.status, 32)?.toLowerCase();
  if (status && !["final", "amended", "corrected"].includes(status)) {
    return { reason: "not_final" };
  }
  const at = firstInstant(
    tz,
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
      const code = loincCodes(c?.code).find((x) => ownValue(VITAL_LOINC, x));
      if (!c || !code) continue;
      const spec = ownValue(VITAL_LOINC, code)!;
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
  const code = codes.find((c) => ownValue(VITAL_LOINC, c));
  if (!code) return { reason: "unsupported_vital" };
  const spec = ownValue(VITAL_LOINC, code)!;
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
  if (bundle && jsonDeeperThan(bundle)) {
    throw new RecordFileImportError(
      "not_fhir_bundle",
      `the file nests deeper than ${UPLOADED_JSON_MAX_DEPTH} levels`,
    );
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
  const labs: Array<{ mapping: FhirLabMapping; urn: boolean }> = [];
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
          urn: issuer === "urn",
        });
      } else if (cats.includes("vital-signs")) {
        const mapped = mapVital(resource, issuer, now, input.tz);
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
        // A urn entry used to be keyed on its Bundle; the old key still counts.
        legacyIssuer: issuer === "urn" ? `bundle:${bundleId}` : undefined,
        type: recordType,
        resource,
        now,
        tz: input.tz,
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
  labs: Array<{ mapping: FhirLabMapping; urn: boolean }>,
): Promise<void> {
  const { tally } = input;
  assignPanels(labs.map((l) => l.mapping));
  const readings: MappedFhirLab[] = [];
  const urnReadings: MappedFhirLab[] = [];
  for (const { mapping, urn } of labs) {
    if (mapping.kind === "reading") {
      (urn ? urnReadings : readings).push(mapping.reading);
    } else if (mapping.kind === "skip") {
      tally.skip("Observation", mapping.reason);
    } else tally.failed("Observation", mapping.reason);
  }
  const deleted = await deletedUnderOldKey(input.userId, urnReadings);
  for (const reading of urnReadings) {
    if (deleted(reading)) tally.duplicate("lab");
    else readings.push(reading);
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

/**
 * A urn entry's lab reading used to be keyed on its Bundle, so the identity
 * of one the person deleted since is not the one it arrives under now. The
 * writer's content check reads the live record only; this one finds the
 * deleted imported row with the same name, instant and value, so the reading
 * stays deleted.
 */
async function deletedUnderOldKey(
  userId: string,
  readings: readonly MappedFhirLab[],
): Promise<(reading: MappedFhirLab) => boolean> {
  if (readings.length === 0) return () => false;
  const rows = await prisma.labResult.findMany({
    where: {
      userId,
      source: FHIR_FILE_SOURCE,
      deletedAt: { not: null },
      externalId: { startsWith: "fhir:" },
      takenAt: { in: [...new Set(readings.map((r) => r.takenAt))] },
      analyte: { in: [...new Set(readings.map((r) => r.analyte))] },
    },
    select: {
      analyte: true,
      takenAt: true,
      value: true,
      sourceValue: true,
      valueText: true,
    },
  });
  // `sourceValue` is set only when the value was moved into another unit.
  const held = new Set(
    rows.map((r) =>
      [
        r.analyte,
        r.takenAt.getTime(),
        r.sourceValue ?? r.value ?? r.valueText,
      ].join("|"),
    ),
  );
  return (r) =>
    held.has(
      [r.analyte, r.takenAt.getTime(), r.value ?? r.valueText].join("|"),
    );
}
