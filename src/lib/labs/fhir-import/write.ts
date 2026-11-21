/**
 * Write mapped FHIR lab readings (#1400), shared by the Apple Health export
 * job and `POST /api/labs/fhir-batch`.
 *
 * A reading becomes a `LabResult` the way a CSV row does
 * (`src/lib/import/labs-csv.ts`): the name resolves to the account's marker
 * through the shared index (with the LOINC code's catalog analyte as a hint),
 * a marker is minted for a new analyte, a reading in another unit is
 * converted when the conversion is known and kept beside what the report
 * said, and a unit that does not convert is refused.
 *
 * Two duplicate checks, in this order, both before a unit is refused:
 *   1. the identity (`externalId`) under `source = APPLE_HEALTH`, against
 *      every row including the deleted ones and against the import ledger
 *      that keeps a deleted reading's identity once its row is gone
 *      (`./import-keys.ts`): a result the person deleted stays deleted
 *      however often the export or the phone sends it again;
 *   2. the reading itself (marker or name, day, value) against the live
 *      record, so a result already typed, scanned or imported from a CSV is
 *      not written a second time.
 *
 * First write wins: an amended or corrected result arriving under an
 * identity already held is a duplicate, not an update.
 *
 * Writes go in chunks of `CHUNK` through `createManyAndReturn` with
 * `skipDuplicates`, so a concurrent writer of the same identity loses
 * quietly and is reported as a duplicate. A chunk that fails to write is
 * reported as `write_failed` and the next chunk still runs.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { matchAnalyteKey } from "@/lib/labs/analyte-match";
import {
  loadMarkerIndex,
  resolveInIndex,
  unitFitsMarker,
  type MarkerIndex,
} from "@/lib/labs/biomarker-resolve";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import { readingInMarkerUnit } from "@/lib/labs/reading-conversion";
import {
  labReadingDay,
  labReadingDaySearchRange,
} from "@/lib/labs/reading-day";
import { READING_KEY_SELECT, readingKeys } from "@/lib/labs/reading-keys";
import { encryptNoteToBytes } from "@/lib/labs/store";

import { heldLabImportKeys } from "./import-keys";
import {
  APPLE_HEALTH_LAB_SOURCE,
  type FhirLabFailureReason,
  type FhirLabWriteStatus,
  type MappedFhirLab,
} from "./types";

const CHUNK = 200;

type LabWriteClient = Pick<
  PrismaClient,
  "labResult" | "biomarker" | "biomarkerAlias" | "labResultImportKey"
>;

export interface FhirLabWriteResult {
  /** One per input reading, in input order. */
  statuses: FhirLabWriteStatus[];
  inserted: number;
  duplicate: number;
  failed: number;
  /** Markers minted because no existing marker took a reading. */
  markersCreated: number;
  /** The newest instant among the readings written, or null. */
  newestTakenAt: Date | null;
}

interface Pending {
  at: number;
  reading: MappedFhirLab;
  markerId: string | null;
  /** False when the marker's unit cannot take the reading's. */
  unitFits: boolean;
}

export async function writeFhirLabReadings(args: {
  userId: string;
  tz: string;
  readings: readonly MappedFhirLab[];
  prisma?: LabWriteClient;
  /**
   * `LabResult.source` of the rows, and the source their identities are
   * looked up under. Apple Health's Health Records by default; a FHIR Bundle
   * file import writes `IMPORT`.
   */
  source?: string;
}): Promise<FhirLabWriteResult> {
  const client = args.prisma ?? defaultPrisma;
  const source = args.source ?? APPLE_HEALTH_LAB_SOURCE;
  const { userId, tz, readings } = args;
  const statuses: FhirLabWriteStatus[] = new Array(readings.length);
  const result: FhirLabWriteResult = {
    statuses,
    inserted: 0,
    duplicate: 0,
    failed: 0,
    markersCreated: 0,
    newestTakenAt: null,
  };
  if (readings.length === 0) return result;

  const index: MarkerIndex = await loadMarkerIndex(client, userId);
  // A marker minted for a new analyte joins the index, so its growth is the
  // count of markers this write added to Labs.
  const markersBefore = index.markers.length;
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();

  const duplicate = (at: number) => {
    statuses[at] = { status: "duplicate" };
    result.duplicate += 1;
  };
  const failed = (at: number, reason: FhirLabFailureReason) => {
    statuses[at] = { status: "failed", reason };
    result.failed += 1;
  };

  for (let start = 0; start < readings.length; start += CHUNK) {
    const slice = readings.slice(start, start + CHUNK);

    // 1. Identity: in the batch, then against every stored row.
    const fresh: Array<{ at: number; reading: MappedFhirLab }> = [];
    for (let i = 0; i < slice.length; i += 1) {
      const at = start + i;
      const reading = slice[i];
      if (seenIds.has(reading.externalId)) {
        duplicate(at);
        continue;
      }
      seenIds.add(reading.externalId);
      fresh.push({ at, reading });
    }
    const freshIds = fresh.map((f) => f.reading.externalId);
    const held = new Set<string | null>(
      (
        await client.labResult.findMany({
          where: {
            userId,
            source,
            externalId: { in: freshIds },
          },
          select: { externalId: true },
        })
      ).map((row) => row.externalId),
    );
    for (const id of await heldLabImportKeys(
      client,
      userId,
      source,
      freshIds,
    )) {
      held.add(id);
    }

    // 2. The marker, and whether the unit fits it. A misfit is refused only
    //    after the live-record check below, so a reading already held under
    //    another spelling of its unit counts as a duplicate.
    const planned: Pending[] = [];
    for (const { at, reading } of fresh) {
      if (held.has(reading.externalId)) {
        duplicate(at);
        continue;
      }
      const hit = resolveInIndex(
        index,
        reading.analyte,
        reading.valueText === null ? reading.unit : null,
        { catalogKey: reading.catalogKey },
      );
      const unitFits =
        !hit ||
        reading.value === null ||
        unitFitsMarker(
          {
            unit: hit.marker.unit,
            analyteKey:
              matchAnalyteKey({
                name: hit.marker.name,
                unit: hit.marker.unit,
              }) ?? hit.marker.analyteKey,
          },
          reading.unit,
          reading.catalogKey,
        );
      planned.push({
        at,
        reading,
        markerId: hit?.marker.id ?? null,
        unitFits,
      });
    }

    // 3. The reading itself, against the live record.
    const existingKeys = await liveReadingKeys(client, userId, tz, planned);

    // 4. Build the rows, field by field.
    const rows: Prisma.LabResultCreateManyInput[] = [];
    const rowAt = new Map<string, Pending>();
    for (const plan of planned) {
      const { reading } = plan;
      const probe = {
        biomarkerId: plan.markerId,
        analyte: reading.analyte,
        takenAt: reading.takenAt,
        value: reading.value,
        valueText: reading.valueText,
        sourceValue: reading.value,
        sourceUnit: reading.unit,
      };
      const keys = [
        ...readingKeys(probe, tz),
        ...readingKeys({ ...probe, biomarkerId: null }, tz),
      ];
      // A reading the record already holds is a duplicate even when its unit
      // is spelled in a way the marker's does not match: nothing is missing,
      // so it is not reported as a failure (#1421).
      if (keys.some((k) => existingKeys.has(k) || seenKeys.has(k))) {
        duplicate(plan.at);
        continue;
      }
      if (!plan.unitFits) {
        failed(plan.at, "unit_mismatch");
        continue;
      }

      const built = await buildRow(client, userId, reading, index, source);
      if (!built.ok) {
        failed(plan.at, built.reason);
        continue;
      }
      rows.push(built.row);
      rowAt.set(reading.externalId, plan);
      for (const k of [
        ...keys,
        ...readingKeys({ ...probe, biomarkerId: built.markerId }, tz),
      ]) {
        seenKeys.add(k);
      }
    }

    if (rows.length === 0) continue;
    try {
      const written = await client.labResult.createManyAndReturn({
        data: rows,
        skipDuplicates: true,
        select: { externalId: true },
      });
      const landed = new Set(written.map((w) => w.externalId));
      for (const [externalId, plan] of rowAt) {
        if (landed.has(externalId)) {
          statuses[plan.at] = { status: "inserted" };
          result.inserted += 1;
          const t = plan.reading.takenAt;
          if (!result.newestTakenAt || t > result.newestTakenAt) {
            result.newestTakenAt = t;
          }
        } else {
          // A concurrent write of the same identity won.
          duplicate(plan.at);
        }
      }
    } catch {
      for (const plan of rowAt.values()) failed(plan.at, "write_failed");
    }
  }
  result.markersCreated = index.markers.length - markersBefore;
  return result;
}

/** Duplicate keys of the live readings a chunk could collide with. */
async function liveReadingKeys(
  client: LabWriteClient,
  userId: string,
  tz: string,
  planned: readonly Pending[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (planned.length === 0) return keys;
  const days = planned.map((p) => labReadingDay(p.reading.takenAt, tz)).sort();
  const ids = [
    ...new Set(
      planned.map((p) => p.markerId).filter((id): id is string => !!id),
    ),
  ];
  const names = [...new Set(planned.map((p) => p.reading.analyte))];
  const existing = await client.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      takenAt: {
        gte: labReadingDaySearchRange(days[0]).gte,
        lt: labReadingDaySearchRange(days[days.length - 1]).lt,
      },
      OR: [{ biomarkerId: { in: ids } }, { analyte: { in: names } }],
    },
    select: READING_KEY_SELECT,
  });
  for (const e of existing) {
    for (const k of readingKeys(e, tz)) keys.add(k);
    // A reading filed under a marker also answers to its printed name.
    if (e.biomarkerId) {
      for (const k of readingKeys({ ...e, biomarkerId: null }, tz)) keys.add(k);
    }
  }
  return keys;
}

/**
 * The row for one reading: its marker resolved or minted, the value moved
 * into the marker's unit when it states another. Built field by field.
 */
async function buildRow(
  client: LabWriteClient,
  userId: string,
  reading: MappedFhirLab,
  index: MarkerIndex,
  source: string,
): Promise<
  | { ok: true; row: Prisma.LabResultCreateManyInput; markerId: string }
  | { ok: false; reason: "unit_mismatch" | "marker_unit_unset" }
> {
  const marker = await resolveOrMintBiomarker(
    userId,
    {
      analyte: reading.analyte,
      unit: reading.unit ?? "",
      referenceLow: reading.sourceReferenceLow,
      referenceHigh: reading.sourceReferenceHigh,
      panel: reading.panel,
    },
    { index, catalogKey: reading.catalogKey },
  );

  // Like the CSV import: on a text result the window only seeds a new
  // marker; the reading itself records none.
  let storedValue = reading.value;
  let storedLow =
    reading.valueText === null ? reading.sourceReferenceLow : null;
  let storedHigh =
    reading.valueText === null ? reading.sourceReferenceHigh : null;
  let convertedFrom: { sourceValue: number; sourceUnit: string } | null = null;
  if (reading.value !== null) {
    const converted = await readingInMarkerUnit(client, {
      marker,
      value: reading.value,
      unit: reading.unit ?? undefined,
      sourceReferenceLow: storedLow,
      sourceReferenceHigh: storedHigh,
    });
    if (!converted.ok) {
      return {
        ok: false,
        reason:
          converted.reason === "marker_unit_unset"
            ? "marker_unit_unset"
            : "unit_mismatch",
      };
    }
    storedValue = converted.value;
    storedLow = converted.sourceReferenceLow;
    storedHigh = converted.sourceReferenceHigh;
    if (converted.converted) {
      convertedFrom = {
        sourceValue: converted.sourceValue,
        sourceUnit: converted.sourceUnit,
      };
    }
  }

  return {
    ok: true,
    markerId: marker.id,
    row: {
      userId,
      biomarkerId: marker.id,
      panel: reading.panel ?? marker.panel,
      analyte: marker.name,
      value: storedValue,
      valueText: reading.valueText,
      unit: marker.unit,
      sourceValue: convertedFrom?.sourceValue ?? null,
      sourceUnit: convertedFrom?.sourceUnit ?? null,
      referenceLow: marker.lowerBound,
      referenceHigh: marker.upperBound,
      sourceReferenceLow: storedLow,
      sourceReferenceHigh: storedHigh,
      sourceReferenceText: reading.sourceReferenceText,
      takenAt: reading.takenAt,
      source,
      externalId: reading.externalId,
      noteEncrypted: reading.note ? encryptNoteToBytes(reading.note) : null,
    },
  };
}
