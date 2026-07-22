/**
 * WHOOP sleep sync. Fetches sleep activity records since the incremental
 * cursor (24 h overlap for the re-score lag), maps each scored record via
 * `mapSleep` (per-stage SLEEP_DURATION rows, SLEEP_NEED, the SLEEP_*
 * percentages, RESPIRATORY_RATE), and upserts as `source = WHOOP`.
 *
 * Sleep rows carry the `sleepStage` axis so the night's rows stay distinct
 * under the dedup key. WHOOP exposes only per-stage DURATION totals (no onset
 * timestamps), so `mapSleep` RECONSTRUCTS an ordered, contiguous per-segment
 * timeline (CORE/DEEP/REM/AWAKE laid back-to-back from sleep onset) and flags
 * those rows `reconstructed`; each reconstructed segment carries its own
 * stage-tagged externalId `<sleep_id>:seg:<tag>` — stable across a WHOOP
 * re-score (the retired positional index renumbered whenever a stage's
 * duration flipped 0↔positive). IN_BED stays a single envelope row keyed
 * `<sleep_id>:sleep_in_bed`. The non-segment scores keep the
 * `<sleep_id>:<fieldTag>` shape.
 *
 * Before the upsert, `sweepStaleSleepSegments` tombstones any live
 * SLEEP_DURATION row under a re-fetched record's `<sleep_id>:` prefix that
 * this fetch did not re-produce — clearing re-score orphans AND every legacy
 * `<sleep_id>:seg:<tag>:<i>` row, so the id change self-heals without a
 * migration (mirrors Google Health's replace-by-window cleanup).
 */
import {
  sweepStaleSleepSegments,
  type SleepSegmentSweep,
} from "@/lib/sleep/sweep-stale-segments";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";

import { fetchSleeps, fetchSleepById, mapSleep } from "./client";
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

function enqueueMorningRefreshForMeasuredAts(
  userId: string,
  measuredAts: Date[],
): void {
  if (measuredAts.length === 0) return;
  void maybeEnqueueMorningRefresh(userId, measuredAts).catch(() => {});
}

export async function syncUserSleep(
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

  const start = incrementalStart(resolveResourceCursor(connection, "sleep"), {
    fullSync: opts.fullSync,
    overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
  });

  let records: Awaited<ReturnType<typeof fetchSleeps>>;
  try {
    records = await fetchSleeps(tokenInfo.accessToken, { start });
  } catch (err) {
    return handleCollectionFetchError("sleep", userId, err);
  }

  const readings: WhoopMeasurementUpsert[] = [];
  const sweeps: SleepSegmentSweep[] = [];
  for (const s of records) {
    const keepIds: string[] = [];
    for (const m of mapSleep(s)) {
      // Reconstructed sleep segments carry their own stage-tagged externalId
      // so the several rows of one night stay distinct; everything else keeps
      // the `<sleep_id>:<fieldTag>` shape.
      const externalId = m.externalId ?? `${s.id}:${m.fieldTag}`;
      if (m.type === "SLEEP_DURATION") keepIds.push(externalId);
      readings.push({
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt,
        externalId,
        sleepStage: m.sleepStage ?? null,
      });
    }
    // Record-scoped sweep entry — only rows under THIS record's prefix are
    // candidates, and only when the fetch re-produced the record (an unscored
    // record maps to nothing and is skipped by the sweep's keep-guard).
    sweeps.push({ prefix: `${s.id}:`, keepIds });
  }

  // Clear whatever an earlier scoring left under the re-fetched records before
  // the fresh set upserts (mirrors Google Health's replace-by-window order).
  await sweepStaleSleepSegments(userId, "WHOOP", sweeps);

  // Accumulate committed chunks, then trigger once after the write pass settles.
  // The finally path also covers a later chunk failure without generating from
  // an intermediate prefix while more chunks are still being written.
  const insertedSleepMeasuredAts: Date[] = [];
  let imported: number;
  try {
    imported = await upsertWhoopMeasurements(userId, readings, {
      onInserted: (rows) => {
        insertedSleepMeasuredAts.push(
          ...rows
            .filter((row) => row.type === "SLEEP_DURATION")
            .map((row) => row.measuredAt),
        );
      },
    });
  } finally {
    enqueueMorningRefreshForMeasuredAts(userId, insertedSleepMeasuredAts);
  }
  await markResourceSynced(userId, "sleep");

  return imported;
}

/**
 * Webhook-driven targeted refresh: resolve ONE sleep activity by its uuid and
 * upsert its readings, instead of re-walking the whole collection. An unscored
 * / since-deleted record yields nothing. Does NOT advance the resource cursor
 * (a single-id refresh proves nothing about the records between the cursor and
 * now).
 */
export async function syncWhoopSleepById(
  userId: string,
  sleepId: string,
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  let record: Awaited<ReturnType<typeof fetchSleepById>>;
  try {
    record = await fetchSleepById(tokenInfo.accessToken, sleepId);
  } catch (err) {
    return handleCollectionFetchError("sleep", userId, err);
  }

  const readings: WhoopMeasurementUpsert[] = [];
  const keepIds: string[] = [];
  for (const m of mapSleep(record)) {
    // Reconstructed sleep segments carry their own stage-tagged externalId
    // (see syncUserSleep).
    const externalId = m.externalId ?? `${record.id}:${m.fieldTag}`;
    if (m.type === "SLEEP_DURATION") keepIds.push(externalId);
    readings.push({
      type: m.type,
      value: m.value,
      unit: m.unit,
      measuredAt: m.measuredAt,
      externalId,
      sleepStage: m.sleepStage ?? null,
    });
  }

  // A webhook refresh IS a re-score in most cases — sweep the record's stale
  // rows before the fresh set upserts (see syncUserSleep).
  await sweepStaleSleepSegments(userId, "WHOOP", [
    { prefix: `${record.id}:`, keepIds },
  ]);

  const insertedSleepMeasuredAts: Date[] = [];
  const imported = await upsertWhoopMeasurements(userId, readings, {
    onInserted: (rows) => {
      insertedSleepMeasuredAts.push(
        ...rows
          .filter((row) => row.type === "SLEEP_DURATION")
          .map((row) => row.measuredAt),
      );
    },
  });
  enqueueMorningRefreshForMeasuredAts(userId, insertedSleepMeasuredAts);
  return imported;
}
