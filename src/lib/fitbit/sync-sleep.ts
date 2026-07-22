/**
 * Fitbit Web API sleep sync.
 *
 * Reads sleep sessions from the classic `1.2/sleep/date` log and maps each into
 * per-SEGMENT `SLEEP_DURATION` rows via `mapSleepSession` (one row per stage
 * segment; `measuredAt = segment START + seconds = segment END`; harmonised onto
 * the shared `SleepStage` enum IN_BED/AWAKE/ASLEEP/REM/CORE/DEEP the night-total
 * + hypnogram readers already consume for WHOOP / Apple). The 1.2 log carries a
 * real per-segment series, so the rows lay each block at its true clock time (a
 * MEASURED timeline, not reconstructed). Upserts as `source = FITBIT`.
 *
 * Each segment carries the `sleepStage` axis and an indexed fieldTag so the
 * several segments of one stage stay distinct under the dedup key. externalId =
 * `<logId>:sleep_<stage>:<i>` — a re-scored night overwrites in place. A 24 h
 * overlap covers Fitbit's after-the-fact re-score.
 *
 * A per-endpoint 403 soft-skips the resource — the `sleep` scope is granted
 * independently in the consent flow.
 */
import {
  FITBIT_SLEEP_RANGE_DAYS,
  fetchSleepRange,
  mapSleepSession,
  readSleepSessions,
} from "./client";
import {
  chunkDateRanges,
  getValidToken,
  handleCollectionFetchError,
  upsertFitbitMeasurements,
} from "./sync-core";
import type {
  FitbitMeasurementUpsert,
  FitbitResourceSyncOptions,
} from "./sync-core";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";

export async function syncUserSleep(
  userId: string,
  opts: FitbitResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // The classic 1.2 sleep log emits offset-less local wall-clock timestamps;
  // anchor them against the user's stored zone so a near-midnight segment END
  // lands on the correct wake-day rather than being shifted by the process zone.
  const tz = await resolveUserTimezone(userId);

  const start = opts.start ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = opts.end ?? new Date();
  const windows = chunkDateRanges(start, end, FITBIT_SLEEP_RANGE_DAYS);

  const readings: FitbitMeasurementUpsert[] = [];
  for (const w of windows) {
    let body: unknown;
    try {
      body = await fetchSleepRange(tokenInfo.accessToken, w.start, w.end);
    } catch (err) {
      return handleCollectionFetchError("fetchSleep", userId, err);
    }
    for (const session of readSleepSessions(body)) {
      for (const m of mapSleepSession(session, tz)) {
        readings.push({
          type: m.type,
          value: m.value,
          unit: m.unit,
          measuredAt: m.measuredAt,
          externalId: m.fieldTag,
          sleepStage: m.sleepStage ?? null,
        });
      }
    }
  }

  const { imported, inserted } = await upsertFitbitMeasurements(
    userId,
    readings,
    {
      deferRollup: opts.deferRollup,
    },
  );
  // `markSynced` is owned by the orchestrator (`syncUserFitbit`).

  // S4 — trigger the debounced morning refresh on a last-night segment landing
  // (mirrors the Withings / WHOOP / Apple seams).
  void maybeEnqueueMorningRefresh(
    userId,
    inserted
      .filter((r) => r.type === "SLEEP_DURATION")
      .map((r) => r.measuredAt),
  ).catch(() => {});

  annotate({ action: { name: "fitbit.sleep.sync", details: { imported } } });
  return imported;
}
