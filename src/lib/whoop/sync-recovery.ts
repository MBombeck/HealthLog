/**
 * WHOOP recovery sync. Fetches recovery records since the incremental cursor
 * (24 h overlap to absorb WHOOP's after-the-fact re-scoring), maps each scored
 * record via `mapRecovery`, and upserts the readings as `source = WHOOP`.
 *
 * Each recovery object yields several Measurement rows (recovery-score, RMSSD,
 * RHR, SpO2, skin-temp), disambiguated by the field-tag in the externalId:
 * `<sleep_id>:<fieldTag>`. The recovery record is keyed off its associated
 * sleep UUID (v2 recovery carries `sleep_id`, not a stable recovery id) so the
 * externalId is stable across re-scores.
 */
import { fetchRecoveries, fetchRecoveryByCycleId, mapRecovery } from "./client";
import {
  getValidToken,
  incrementalStart,
  handleCollectionFetchError,
  markResourceSynced,
  resolveResourceCursor,
  upsertWhoopMeasurements,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
  type WhoopMeasurementUpsert,
} from "./sync-core";
import { prisma } from "@/lib/db";

export async function syncUserRecovery(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  const connection = await prisma.whoopConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true, resourceCursors: true },
  });
  if (!connection) return 0;

  const start = incrementalStart(
    resolveResourceCursor(connection, "recovery"),
    {
      fullSync: opts.fullSync,
      overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    },
  );

  let records: Awaited<ReturnType<typeof fetchRecoveries>>;
  try {
    records = await fetchRecoveries(tokenInfo.accessToken, { start });
  } catch (err) {
    return handleCollectionFetchError("recovery", userId, err);
  }

  const readings: WhoopMeasurementUpsert[] = [];
  for (const r of records) {
    // `sleep_id` is the stable v2 anchor for the recovery record.
    const anchor = r.sleep_id;
    for (const m of mapRecovery(r)) {
      readings.push({
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt,
        externalId: `${anchor}:${m.fieldTag}`,
      });
    }
  }

  const imported = await upsertWhoopMeasurements(userId, readings);
  await markResourceSynced(userId, "recovery");
  return imported;
}

/**
 * Webhook-driven targeted refresh: resolve ONE recovery by its cycle id and
 * upsert its readings, instead of re-walking the whole collection. WHOOP v2
 * reads a recovery through its cycle (`/v2/cycle/{cycleId}/recovery`), and the
 * recovery webhook carries the cycle id. An unscored / since-deleted record
 * yields nothing. Does NOT advance the resource cursor — a single-id refresh
 * proves nothing about records between the cursor and now, so the cron/overlap
 * path stays responsible for moving the cursor.
 */
export async function syncWhoopRecoveryById(
  userId: string,
  cycleId: string,
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  let record: Awaited<ReturnType<typeof fetchRecoveryByCycleId>>;
  try {
    record = await fetchRecoveryByCycleId(tokenInfo.accessToken, cycleId);
  } catch (err) {
    return handleCollectionFetchError("recovery", userId, err);
  }

  const readings: WhoopMeasurementUpsert[] = [];
  for (const m of mapRecovery(record)) {
    readings.push({
      type: m.type,
      value: m.value,
      unit: m.unit,
      measuredAt: m.measuredAt,
      externalId: `${record.sleep_id}:${m.fieldTag}`,
    });
  }

  return upsertWhoopMeasurements(userId, readings);
}
