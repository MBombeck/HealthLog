/**
 * The measurements domain's export half: the select every carried column is
 * named in, the two wire shapes, and the paged read. The restore half lives
 * in `measurements-restore.ts`.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { readNote } from "@/lib/crypto/note-cipher";
import { collect, deferredRows } from "@/lib/export/deferred-rows";
import type {
  BackupExportContext,
  BackupExportPart,
} from "@/lib/export/export-context";
import { iterateMeasurementPages } from "@/lib/export/paged-measurements";

/**
 * Every restorable `Measurement` scalar. `userId` is deliberately absent — the
 * backup is user-scoped, so the owner is implicit in the query and restored
 * from the target account rather than the payload.
 *
 * Named rather than inlined so `measurement-backup-completeness.test.ts` can
 * compare it field-by-field against the model in `prisma/schema.prisma`. A
 * column added to the model and forgotten here is how the aggregation
 * provenance went missing from disaster-recovery backups for several releases.
 */
const MEASUREMENT_BACKUP_SELECT = {
  id: true,
  type: true,
  value: true,
  valueMin: true,
  valueMax: true,
  unit: true,
  measuredAt: true,
  source: true,
  notes: true,
  notesEncrypted: true,
  externalId: true,
  externalSourceVersion: true,
  aggregationProvenance: true,
  glucoseContext: true,
  sleepStage: true,
  rhythmClassification: true,
  deviceType: true,
  ingestTokenId: true,
  syncVersion: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MeasurementSelect;

type BackupMeasurementRow = Prisma.MeasurementGetPayload<{
  select: typeof MEASUREMENT_BACKUP_SELECT;
}>;

/**
 * One measurement, in whichever of the two wire shapes the caller asked for.
 *
 * Named rather than inlined so the paged reader below and the materialising
 * reader beside it cannot drift: both call this, so a column that reaches one
 * shape reaches the other by construction. `measurement-backup-completeness.
 * test.ts` proves a selected column reaches a payload by matching
 * `<key>: measurement.`, which is why the parameter keeps that spelling.
 */
function serialiseMeasurement(
  measurement: BackupMeasurementRow,
  disasterRecovery: boolean,
) {
  return disasterRecovery
    ? {
        id: measurement.id,
        type: measurement.type,
        value: measurement.value,
        valueMin: measurement.valueMin,
        valueMax: measurement.valueMax,
        unit: measurement.unit,
        measuredAt: measurement.measuredAt.toISOString(),
        source: measurement.source,
        notes: measurement.notes,
        notesEncrypted: measurement.notesEncrypted
          ? Buffer.from(measurement.notesEncrypted).toString("base64")
          : null,
        externalId: measurement.externalId,
        externalSourceVersion: measurement.externalSourceVersion,
        aggregationProvenance: measurement.aggregationProvenance,
        glucoseContext: measurement.glucoseContext,
        sleepStage: measurement.sleepStage,
        rhythmClassification: measurement.rhythmClassification,
        deviceType: measurement.deviceType,
        ingestTokenId: measurement.ingestTokenId,
        syncVersion: measurement.syncVersion,
        deletedAt: measurement.deletedAt?.toISOString() ?? null,
        createdAt: measurement.createdAt.toISOString(),
        updatedAt: measurement.updatedAt.toISOString(),
      }
    : // The portable file is the human-readable subset: no tombstones, no
      // ciphertext and none of the sync bookkeeping (the source's ids, its
      // version, the aggregate's provenance). What the reading itself says
      // stays: a glucose value without its fasting context, a sleep row
      // without its stage or a range without its bounds reads as a
      // different measurement once it is imported or restored elsewhere.
      {
        id: measurement.id,
        type: measurement.type,
        value: measurement.value,
        valueMin: measurement.valueMin,
        valueMax: measurement.valueMax,
        unit: measurement.unit,
        measuredAt: measurement.measuredAt.toISOString(),
        source: measurement.source,
        notes: readNote(measurement.notesEncrypted, measurement.notes),
        glucoseContext: measurement.glucoseContext,
        sleepStage: measurement.sleepStage,
        rhythmClassification: measurement.rhythmClassification,
        deviceType: measurement.deviceType,
        deletedAt: measurement.deletedAt?.toISOString() ?? null,
      };
}

/**
 * Every backup measurement, one serialised row at a time.
 *
 * Keyset-paged through `iterateMeasurementPages`, so the caller decides
 * whether to keep the rows (the materialising payload does) or hand each
 * straight to a writer and forget it (the streaming writer does). Nothing here
 * holds more than one page.
 */
export async function* iterateBackupMeasurements(
  prisma: PrismaClient,
  userId: string,
  disasterRecovery: boolean,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const pages = iterateMeasurementPages(
    prisma,
    disasterRecovery ? { userId } : { userId, deletedAt: null },
    MEASUREMENT_BACKUP_SELECT,
  );
  for await (const page of pages) {
    for (const measurement of page) {
      yield serialiseMeasurement(measurement, disasterRecovery);
    }
  }
}

/** The measurements slice of the payload: the rows, or a marker for them. */
export async function buildMeasurementsBackupPart(
  ctx: BackupExportContext,
): Promise<BackupExportPart> {
  const { prisma, userId, disasterRecovery } = ctx;
  if (ctx.deferBulk) {
    return {
      section: {
        measurements: deferredRows(() =>
          iterateBackupMeasurements(prisma, userId, disasterRecovery),
        ),
      },
      counts: { measurements: 0 },
    };
  }
  const measurements = await collect(
    iterateBackupMeasurements(prisma, userId, disasterRecovery),
  );
  return {
    section: { measurements },
    counts: { measurements: measurements.length },
  };
}
