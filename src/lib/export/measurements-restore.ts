/**
 * The restore half of the measurements domain. The export half, with the
 * select every column is carried by, lives in `measurements-backup.ts`.
 *
 * The restore reads the readings twice. The first read (`readStreamedBackup`,
 * before anything is deleted) checks each one and notes what the second read
 * has to know about the file as a whole: which `stats:` aggregates are live,
 * and which nights the retired heart-rate variability filing shares with an
 * RMSSD reading (`createMeasurementRestorePrepass`). The second read, inside
 * the transaction, writes them a batch at a time (`restoreMeasurements`), so
 * the restore never holds more than one batch.
 */
import type { Prisma } from "@/generated/prisma/client";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import { encryptNote } from "@/lib/crypto/note-cipher";
import {
  isLegacyRmssdRow,
  LEGACY_RMSSD_SOURCES,
} from "@/lib/export/legacy-rmssd";
import {
  insertMeasurementRows,
  type MeasurementInsertRow,
} from "@/lib/export/measurement-bulk-insert";
import {
  decodeEncryptedBytes,
  type MeasurementRestorePrepass,
  type RestoreContext,
} from "@/lib/export/restore-context";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";
import {
  FOLDED_TYPES,
  compactionTombstoneCoverId,
} from "@/lib/measurements/folded-window";
import type { BackupMeasurement } from "@/lib/validations/backup";

/** Both unique identities of a row, as it would be filed under `HRV_RMSSD`. */
function rmssdTwinKeysOf(row: BackupMeasurement): string[] {
  const keys = [
    `at|${row.source}|${new Date(row.measuredAt).toISOString()}|${row.sleepStage ?? ""}`,
  ];
  if (row.externalId) keys.push(`ext|${row.source}|${row.externalId}`);
  return keys;
}

const foldStatsKey = (source: string, type: string, externalId: string) =>
  `${source}|${type}|${externalId}`;

/**
 * The notes the measurement pass takes from the first read of the file.
 *
 * The live `stats:` ids of the folded types, so the measurement pass can tell
 * a compaction tombstone from a person's deletion without a third read of the
 * file. Keyed by source as well: Health Connect folds into the same `stats:`
 * ids as Apple Health, and an Apple Health hour must not make a Health
 * Connect deletion look folded.
 *
 * Migration 0420 refiled Fitbit and Google Health HRV as `HRV_RMSSD`: both
 * providers report a nightly RMSSD, which their mappers had written as the
 * SDNN series. A file written before that release still carries those rows
 * as `HEART_RATE_VARIABILITY`, and restoring it verbatim would undo the
 * migration for the account. The restore applies the migration's rule:
 *
 *   - a legacy row moves to RMSSD, unless a LIVE RMSSD row of its source
 *     holds the same night under either unique identity (external id, or
 *     measured-at and sleep stage). Then the twin holds the night and the
 *     legacy row is not written under either type: as RMSSD it would break
 *     the unique key, as SDNN it would put RMSSD back into the SDNN series;
 *   - a legacy row whose only twin is a tombstone wins: the tombstone is the
 *     row left out, since it shares the key and holds nothing;
 *   - a legacy tombstone with any RMSSD twin is left out.
 *
 * The keys are gathered on the first read.
 */
export function createMeasurementRestorePrepass(): MeasurementRestorePrepass {
  const liveFoldStatsIds = new Set<string>();
  const foldedTypes = new Set<string>(FOLDED_TYPES);
  const foldSources = new Set<string>(["APPLE_HEALTH", "HEALTH_CONNECT"]);
  const noteLiveFoldRow = (row: BackupMeasurement) => {
    if (
      row.deletedAt == null &&
      row.source !== undefined &&
      foldSources.has(row.source) &&
      foldedTypes.has(row.type) &&
      row.externalId?.startsWith("stats:")
    ) {
      liveFoldStatsIds.add(foldStatsKey(row.source, row.type, row.externalId));
    }
  };
  const rmssdLiveKeys = new Set<string>();
  const rmssdAnyKeys = new Set<string>();
  const legacyLiveKeys = new Set<string>();
  const noteRmssdTwin = (row: BackupMeasurement) => {
    if (isLegacyRmssdRow(row)) {
      if (row.deletedAt == null) {
        for (const key of rmssdTwinKeysOf(row)) legacyLiveKeys.add(key);
      }
      return;
    }
    if (
      row.type === "HRV_RMSSD" &&
      row.source !== undefined &&
      LEGACY_RMSSD_SOURCES.has(row.source)
    ) {
      for (const key of rmssdTwinKeysOf(row)) {
        rmssdAnyKeys.add(key);
        if (row.deletedAt == null) rmssdLiveKeys.add(key);
      }
    }
  };
  const anyKeyIn = (row: BackupMeasurement, keys: ReadonlySet<string>) =>
    rmssdTwinKeysOf(row).some((key) => keys.has(key));
  const isShadowedLegacyRmssd = (row: BackupMeasurement): boolean => {
    if (isLegacyRmssdRow(row)) {
      return anyKeyIn(
        row,
        row.deletedAt == null ? rmssdLiveKeys : rmssdAnyKeys,
      );
    }
    // An RMSSD tombstone on the night a live legacy row is about to take.
    return (
      row.type === "HRV_RMSSD" &&
      row.deletedAt != null &&
      row.source !== undefined &&
      LEGACY_RMSSD_SOURCES.has(row.source) &&
      anyKeyIn(row, legacyLiveKeys) &&
      !anyKeyIn(row, rmssdLiveKeys)
    );
  };
  return {
    note(row) {
      noteLiveFoldRow(row);
      noteRmssdTwin(row);
    },
    liveFoldStatsIds,
    isShadowedLegacyRmssd,
  };
}

export async function clearMeasurements(ctx: RestoreContext): Promise<void> {
  const measurements = await ctx.tx.measurement.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.measurements = measurements.count;
}

/**
 * The persisted measurement rollup partition, wiped for the same reason as
 * the mood one: kept, it would hold the previous owner's daily means after
 * the underlying measurements were replaced, and the chart's `source=rollup`
 * fast-path could surface a stale 30-day mean built from rows that no longer
 * exist. The rebuild after the commit mints fresh rows from the restored set.
 */
export async function clearMeasurementRollups(
  ctx: RestoreContext,
): Promise<void> {
  await ctx.tx.measurementRollup.deleteMany({ where: { userId: ctx.ownerId } });
}

function toRestoredMeasurementData(
  measurement: BackupMeasurement,
  ownTokenIds: ReadonlySet<string>,
) {
  return {
    type: isLegacyRmssdRow(measurement)
      ? ("HRV_RMSSD" as const)
      : measurement.type,
    value: measurement.value,
    valueMin: measurement.valueMin ?? null,
    valueMax: measurement.valueMax ?? null,
    unit: measurement.unit,
    source: measurement.source ?? "MANUAL",
    measuredAt: new Date(measurement.measuredAt),
    notes: null,
    notesEncrypted:
      measurement.notesEncrypted == null
        ? encryptNote(measurement.notes ?? null)
        : decodeEncryptedBytes(measurement.notesEncrypted),
    externalId: measurement.externalId ?? null,
    externalSourceVersion: measurement.externalSourceVersion ?? null,
    // Authority of an Apple Health `stats:` aggregate. A backup
    // written before this field rode the payload carries nothing, and
    // restoring NULL would flatten the authority ladder: an export.xml
    // source-day estimate could then overwrite a native HealthKit
    // statistic, which is the ambiguity migration 0263 already
    // repaired once. Such a row is exactly the case LEGACY_UNKNOWN
    // exists for, so it comes back repairable instead of ambiguous.
    //
    // The gate is scoped exactly as 0263 scoped its backfill and as
    // the cumulative drain scopes its own LEGACY_UNKNOWN writes:
    // Apple Health rows only. Other providers mint `stats:` ids for
    // their cumulative dailies too (Fitbit, Google Health) and have
    // never carried provenance — marking those would invent a state
    // they were never in. Ordinary point rows keep NULL honestly.
    //
    // Only an ABSENT field is the old-backup case. A current backup
    // writes the field for every row, and an explicit null is the row's
    // real state: the nightly daily-mean fold writes Apple Health
    // `stats:` rows with no provenance. Treating that null as absent
    // turned every such row into LEGACY_UNKNOWN on restore (#1031).
    aggregationProvenance: (measurement.aggregationProvenance !== undefined
      ? measurement.aggregationProvenance
      : measurement.source === "APPLE_HEALTH" &&
          measurement.externalId?.startsWith("stats:")
        ? "LEGACY_UNKNOWN"
        : null) as never,
    glucoseContext: (measurement.glucoseContext ?? null) as never,
    sleepStage: (measurement.sleepStage ?? null) as never,
    rhythmClassification: (measurement.rhythmClassification ?? null) as never,
    deviceType: measurement.deviceType ?? null,
    // The token link (#1272) survives only onto the account that still holds
    // the token: a backup restored elsewhere, or after the token was deleted,
    // would point at a row that is not there or not this account's.
    ingestTokenId:
      measurement.ingestTokenId && ownTokenIds.has(measurement.ingestTokenId)
        ? measurement.ingestTokenId
        : null,
    syncVersion: measurement.syncVersion ?? 1,
    deletedAt: measurement.deletedAt ? new Date(measurement.deletedAt) : null,
    ...(measurement.createdAt
      ? { createdAt: new Date(measurement.createdAt) }
      : {}),
    ...(measurement.updatedAt
      ? { updatedAt: new Date(measurement.updatedAt) }
      : {}),
  };
}

/**
 * Which deleted readings the file carries are not written back.
 *
 * Deleted readings the file carries are restored as deleted rows
 * (tombstones), with one exception: a tombstone deleted longer ago than
 * `TOMBSTONE_RETENTION_DAYS` is not written at all.
 *
 * Such a row is exactly what the nightly tombstone purge
 * (`measurement-tombstone-cleanup.ts`) hard-deletes, so writing it costs the
 * restore a row in thirteen indexes for a row that is gone by the next
 * morning. Nothing reads it in between: the delta feed answers
 * `cursorExpired` for every cursor older than the same horizon, so no client
 * that would still be served this tombstone exists; the step-consolidation
 * repair and the hourly rebuild only look inside the horizon; and the undo of
 * a delete is offered for what the purge has not removed yet, which this row
 * would not survive either.
 *
 * Younger tombstones are written. They still have readers: a paired client
 * that has not yet drained that deletion from the delta feed, the undo of a
 * recent delete, the consolidation repairs that rebuild from folded samples,
 * and the unique `(user, type, source, externalId)` key that stops a device
 * from uploading a folded sample again. The backup file itself is unchanged
 * and keeps every row.
 *
 * Nor is a compaction tombstone written, whatever its age: a raw sample the
 * folds soft-deleted before v1.42, whose whole hour or day the fold had
 * reached when it was deleted and which a live `stats:` row of the same
 * source in the same file covers. The folds delete those outright now and the
 * backlog purge removes the old ones, so writing one back would only hand the
 * purge the same row again; the `folded_window` ingest guard is what keeps
 * the sample from being uploaded again. Classified by the rule the purge and
 * the sync feed use (`folded-window.ts`), against the `stats:` ids gathered
 * on the file's first read and the zone the account will have after the
 * restore. Counted with the expired ones.
 */
async function expiredTombstoneFilter(
  ctx: RestoreContext,
): Promise<(measurement: BackupMeasurement) => boolean> {
  const { tx, ownerId, payload } = ctx;
  const tombstoneHorizonMs = Date.now() - TOMBSTONE_RETENTION_DAYS * 86_400_000;
  const foldTz = resolveUserTimezone(
    payload.accountSettings?.timezone ??
      (
        await tx.user.findUnique({
          where: { id: ownerId },
          select: { timezone: true },
        })
      )?.timezone ??
      null,
  );
  // Only once the fold repair has been through the means this file holds.
  // The repair recomputes a mean an older release folded from part of its
  // day, and these tombstones are what it reads. A file exported after the
  // account's repair finished carries repaired means, so its compaction
  // tombstones can go. Any other file is written back whole, the account's
  // repair marker is removed, and the repair runs again once the transaction
  // commits; the purge then removes the tombstones as usual.
  const foldRepair = await tx.measurementFoldRepair.findUnique({
    where: { userId: ownerId },
    select: { completedAt: true },
  });
  const dropCompactionTombstones =
    foldRepair !== null &&
    new Date(payload.exportedAt).getTime() > foldRepair.completedAt.getTime();
  if (!dropCompactionTombstones) {
    await tx.measurementFoldRepair.deleteMany({
      where: { userId: ownerId },
    });
    ctx.outputs.foldRepairReset = true;
  }
  const { liveFoldStatsIds } = ctx.measurementPrepass;
  const isCompactionTombstone = (measurement: BackupMeasurement) => {
    if (!dropCompactionTombstones) return false;
    if (measurement.deletedAt == null) return false;
    const source = measurement.source ?? "MANUAL";
    const covering = compactionTombstoneCoverId(
      {
        type: measurement.type,
        source,
        externalId: measurement.externalId ?? null,
        measuredAt: new Date(measurement.measuredAt),
        deletedAt: new Date(measurement.deletedAt),
      },
      foldTz,
    );
    return (
      covering !== null &&
      liveFoldStatsIds.has(foldStatsKey(source, measurement.type, covering))
    );
  };
  return (measurement: BackupMeasurement) =>
    measurement.deletedAt != null &&
    (new Date(measurement.deletedAt).getTime() < tombstoneHorizonMs ||
      isCompactionTombstone(measurement));
}

/**
 * Two later sections point INTO the measurements (a record's
 * `sourceMeasurementId`, an ECG strip's `measurementId`) and have to know
 * which of those ids this transaction actually wrote. They used to be handed
 * every written id; they only ever ask about the ones they reference, so only
 * those are collected.
 */
function referencedMeasurementIdsOf(
  payload: RestoreContext["payload"],
): Set<string> {
  const referenced = new Set<string>();
  for (const record of payload.personalRecords) {
    if (record.sourceMeasurementId) {
      referenced.add(record.sourceMeasurementId);
    }
  }
  for (const recording of payload.ecgRecordings) {
    if (recording.measurementId) {
      referenced.add(recording.measurementId);
    }
  }
  return referenced;
}

/**
 * v1 payloads did not require stable ids. Their historical natural-key
 * reconciliation is preserved without routing canonical v2 rows through it.
 */
async function reconcileWithoutId(
  tx: Prisma.TransactionClient,
  ownerId: string,
  measurement: BackupMeasurement,
  ownTokenIds: ReadonlySet<string>,
): Promise<void> {
  const restoredData = toRestoredMeasurementData(measurement, ownTokenIds);
  const existing = await tx.measurement.findFirst({
    where: {
      userId: ownerId,
      type: measurement.type,
      source: restoredData.source,
      measuredAt: restoredData.measuredAt,
      sleepStage: restoredData.sleepStage,
    },
    select: { id: true },
  });
  if (existing) {
    await tx.measurement.update({
      where: { id: existing.id, userId: ownerId },
      data: restoredData,
    });
  } else {
    await tx.measurement.create({
      data: { userId: ownerId, ...restoredData },
    });
  }
}

/**
 * The measurements, a batch at a time from a second read of the file, so the
 * restore never holds more than one batch of them.
 */
export async function restoreMeasurements(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload, streamed } = ctx;
  const referencedMeasurementIds = referencedMeasurementIdsOf(payload);
  const writtenReferencedIds = ctx.links.writtenReferencedMeasurementIds;
  const measurementBatchSize = 1_000;
  const isExpiredTombstone = await expiredTombstoneFilter(ctx);
  const { isShadowedLegacyRmssd } = ctx.measurementPrepass;
  // Tokens are not part of a backup; the ones the account holds now decide
  // which token links come back.
  const ownTokenIds = new Set(
    (
      await tx.apiToken.findMany({
        where: { userId: ownerId },
        select: { id: true },
      })
    ).map((token) => token.id),
  );
  ctx.reportMeasurements(0);
  await streamed.forEachMeasurementBatch(
    measurementBatchSize,
    async (fileBatch) => {
      const kept = fileBatch.filter(
        (measurement) => !isExpiredTombstone(measurement),
      );
      ctx.outputs.expiredTombstonesSkipped += fileBatch.length - kept.length;
      const batch = kept.filter(
        (measurement) => !isShadowedLegacyRmssd(measurement),
      );
      const stableRows = batch.flatMap((measurement): MeasurementInsertRow[] =>
        measurement.id
          ? [
              {
                id: measurement.id,
                userId: ownerId,
                ...toRestoredMeasurementData(measurement, ownTokenIds),
              },
            ]
          : [],
      );
      // One statement per batch, not `createMany`: see
      // `insertMeasurementRows` for what the latter cost here.
      await insertMeasurementRows(tx, stableRows);
      // Counted through the file, so the bar ends at the file's total.
      ctx.reportMeasurements(fileBatch.length);
      for (const row of stableRows) {
        if (referencedMeasurementIds.has(row.id)) {
          writtenReferencedIds.add(row.id);
        }
      }
      for (const measurement of batch) {
        if (measurement.id) continue;
        await reconcileWithoutId(tx, ownerId, measurement, ownTokenIds);
      }
    },
  );
}
