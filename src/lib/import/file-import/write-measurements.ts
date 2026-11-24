/**
 * Measurement writes for the record-file imports, under one identity each
 * (`(userId, type, IMPORT, externalId)`, the measurement table's unique key).
 *
 *   - A spot reading (one sample at one instant) is first-write-wins: a second
 *     run finds it and counts a duplicate.
 *   - A derived value (a day's steps, an hour's mean pulse) is overwritten
 *     when a later export of the same source has a different value for the
 *     same bucket, since a newer export holds more of that day. A total that
 *     only grows (`overwrite: "larger"`) is overwritten only by a larger one,
 *     so an older export uploaded after a newer one does not lower it. A row
 *     the person deleted stays deleted.
 *
 * Values outside the plausible range are refused per row and counted.
 */
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { insertNewMeasurementRows } from "@/lib/export/measurement-bulk-insert";
import { validateMeasurementRange } from "@/lib/measurements/value-ranges";
import { isStableExternalId } from "@/lib/validations/external-id";
import { getUnitForType } from "@/lib/validations/measurement";

import type { RecordFileImportTally } from "./tally";

export const IMPORT_SOURCE = "IMPORT";

export interface ImportedMeasurement {
  type: MeasurementType;
  value: number;
  measuredAt: Date;
  externalId: string;
  sleepStage?: SleepStage | null;
}

const CHUNK = 100;

export async function writeImportedMeasurements(
  userId: string,
  rows: readonly ImportedMeasurement[],
  tally: RecordFileImportTally,
  options: { overwrite?: boolean | "larger"; skipKey?: string } = {},
): Promise<void> {
  const valid: ImportedMeasurement[] = [];
  for (const row of rows) {
    // The identities are built here, from file content no request schema
    // sees; the floor refuses one that would rotate between runs.
    if (!isStableExternalId(row.externalId)) {
      tally.skip(options.skipKey ?? row.type, "unstable_identity");
      continue;
    }
    if (
      !Number.isFinite(row.value) ||
      validateMeasurementRange(row.type, row.value) !== null
    ) {
      tally.skip(options.skipKey ?? row.type, "out_of_range");
      continue;
    }
    valid.push(row);
  }
  for (let i = 0; i < valid.length; i += CHUNK) {
    await writeChunk(userId, valid.slice(i, i + CHUNK), tally, options);
  }
}

async function writeChunk(
  userId: string,
  chunk: readonly ImportedMeasurement[],
  tally: RecordFileImportTally,
  options: { overwrite?: boolean | "larger" },
): Promise<void> {
  const inserted = await insertNewMeasurementRows(
    prisma,
    chunk.map((row) => ({
      userId,
      type: row.type,
      value: row.value,
      unit: getUnitForType(row.type),
      source: IMPORT_SOURCE,
      measuredAt: row.measuredAt,
      externalId: row.externalId,
      externalSourceVersion: null,
      sleepStage: row.sleepStage ?? null,
      deviceType: null,
    })),
  );
  const landed = new Set(inserted.map((r) => `${r.type}|${r.externalId}`));
  const rest: ImportedMeasurement[] = [];
  for (const row of chunk) {
    if (landed.has(`${row.type}|${row.externalId}`)) {
      tally.imported(row.type);
      tally.widen(row.measuredAt);
    } else {
      rest.push(row);
    }
  }
  if (rest.length === 0) return;
  if (!options.overwrite) {
    for (const row of rest) tally.duplicate(row.type);
    return;
  }
  const existing = await prisma.measurement.findMany({
    where: {
      userId,
      source: IMPORT_SOURCE,
      externalId: { in: rest.map((r) => r.externalId) },
    },
    select: {
      id: true,
      type: true,
      externalId: true,
      value: true,
      deletedAt: true,
    },
  });
  const byKey = new Map(existing.map((e) => [`${e.type}|${e.externalId}`, e]));
  for (const row of rest) {
    const found = byKey.get(`${row.type}|${row.externalId}`);
    if (
      !found ||
      found.deletedAt !== null ||
      found.value === row.value ||
      (options.overwrite === "larger" && row.value < found.value)
    ) {
      tally.duplicate(row.type);
      continue;
    }
    await prisma.measurement.update({
      where: { id: found.id },
      data: {
        value: row.value,
        measuredAt: row.measuredAt,
        syncVersion: { increment: 1 },
      },
    });
    tally.imported(row.type);
    tally.widen(row.measuredAt);
  }
}
