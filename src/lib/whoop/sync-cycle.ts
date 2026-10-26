/**
 * WHOOP cycle (day) sync. There is NO webhook for cycles — this is poll-only,
 * driven by the hourly fallback cron. Maps each scored cycle via `mapCycle`
 * (DAY_STRAIN + ENERGY_EXPENDITURE_KJ) and upserts as `source = WHOOP`.
 *
 * Cycle id is an int64 (not a UUID); externalId = `cycle:<id>:<fieldTag>`.
 */
import { fetchCycles } from "./client";
import { mapCycle } from "./map";
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

export async function syncUserCycle(
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

  // WHOOP re-scores a cycle THROUGH the day (day strain + energy accrue and
  // settle after the fact) and the collection filters on the cycle's own time
  // range, not on when it updated — so a narrow 1 h overlap could step the
  // cursor past a cycle still being revised and miss the final value. Ride the
  // same 7-day re-score overlap workout/recovery/sleep already use; one cycle
  // per day means ~7 records re-fetched per tick (one page), and the
  // `cycle:<id>:<fieldTag>` upsert keeps the overwrite idempotent.
  const start = incrementalStart(resolveResourceCursor(connection, "cycle"), {
    fullSync: opts.fullSync,
    overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
  });

  let records: Awaited<ReturnType<typeof fetchCycles>>;
  try {
    records = await fetchCycles(tokenInfo.accessToken, { start });
  } catch (err) {
    return handleCollectionFetchError("cycle", userId, err);
  }

  const readings: WhoopMeasurementUpsert[] = [];
  for (const c of records) {
    for (const m of mapCycle(c)) {
      readings.push({
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt,
        externalId: `cycle:${c.id}:${m.fieldTag}`,
      });
    }
  }

  const imported = await upsertWhoopMeasurements(userId, readings);
  await markResourceSynced(userId, "cycle");
  return imported;
}
