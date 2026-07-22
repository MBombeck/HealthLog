/**
 * Google Health sleep-bundle sync (v1.27.0).
 *
 * Reads sleep sessions from the `sleep.readonly` Restricted bundle and maps each
 * into per-SEGMENT `SLEEP_DURATION` rows via `mapSleepSession` (one row per stage
 * segment; `measuredAt = that segment's END` instant; harmonised onto the shared
 * `SleepStage` enum IN_BED/AWAKE/ASLEEP/REM/CORE/DEEP that the night-total +
 * hypnogram readers already consume for WHOOP / Apple). Google carries a real
 * per-segment series, so the rows lay each block at its true clock time (a
 * MEASURED timeline, not reconstructed). Upserts as `source = GOOGLE_HEALTH`.
 *
 * Each segment carries the `sleepStage` axis and a fieldTag keyed on the STABLE
 * session anchor plus the segment's own start —
 * `<session-anchor>:sleep:<segment-start>` — so a re-scored night overwrites in
 * place instead of minting parallel duplicate rows the night-total would then
 * double-count. A 24 h overlap covers Google's after-the-fact re-score, and
 * `replaceStaleGoogleHealthSleep` clears anything an earlier scoring left in the
 * night's window before the fresh set upserts.
 *
 * A per-data-class 403 soft-skips the resource — the sleep bundle is granted
 * independently of activity / metrics in the Google consent flow.
 */
import {
  GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE,
  GOOGLE_HEALTH_DATA_TYPES,
  fetchDataPoints,
  mapSleepSessionDetailed,
} from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  noteHardFailure,
  replaceStaleGoogleHealthSleep,
  upsertGoogleHealthMeasurements,
  type GoogleHealthMeasurementUpsert,
  type GoogleHealthResourceSyncOptions,
  type GoogleHealthSleepReplaceWindow,
} from "./sync-core";
import { annotate, getEvent } from "@/lib/logging/context";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";

export async function syncUserSleep(
  userId: string,
  opts: GoogleHealthResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // Sleep-segment timestamps can arrive offset-less; anchor them against the
  // user's stored zone so a near-midnight segment END lands on the correct
  // wake-day rather than being shifted by the process zone.
  const tz = await resolveUserTimezone(userId);

  // Cycle-wide watermark snapshotted once by `syncUserGoogleHealth`; undefined
  // on a full/backfill run.
  const start = opts.start;

  let points: Record<string, unknown>[];
  try {
    points = await fetchDataPoints(
      GOOGLE_HEALTH_DATA_TYPES.sleep,
      tokenInfo.accessToken,
      "fetchSleep",
      { start, pageSize: GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE },
    );
  } catch (err) {
    return handleCollectionFetchError("fetchSleep", userId, err);
  }

  const readings: GoogleHealthMeasurementUpsert[] = [];
  const replaceWindows: GoogleHealthSleepReplaceWindow[] = [];
  for (const point of points) {
    // Per-session throw-guard (mapper parity with sync-metrics): a single
    // malformed session must not abort the sibling sessions in the same page.
    // The ledger entry still fails the cycle so the watermark holds and the
    // bad point is re-fetched rather than silently lost past the overlap.
    let session: ReturnType<typeof mapSleepSessionDetailed>;
    try {
      session = mapSleepSessionDetailed(point, tz);
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: sleep session map failed for ${userId}: ${err}`,
      );
      noteHardFailure("mapSleepSession");
      continue;
    }
    if (session.rows.length === 0) continue;
    for (const m of session.rows) {
      readings.push({
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt,
        externalId: m.fieldTag,
        sleepStage: m.sleepStage ?? null,
      });
    }
    // Clean any stale rows a prior re-score left in this night's window before
    // the fresh set upserts — so a re-scored night reads its true total rather
    // than the sum of the old and the re-scored copies.
    replaceWindows.push({
      windowStart: session.windowStart,
      windowEnd: session.windowEnd,
      keepIds: session.rows.map((m) => m.fieldTag),
    });
  }

  await replaceStaleGoogleHealthSleep(userId, replaceWindows);

  const { imported, inserted } = await upsertGoogleHealthMeasurements(
    userId,
    readings,
    {
      deferRollup: opts.deferRollup,
    },
  );
  // `markSynced` is owned by the orchestrator (`syncUserGoogleHealth`).

  // S4 — trigger the debounced morning refresh on a last-night segment landing
  // (mirrors the Withings / WHOOP / Apple seams). Google Health is a first-
  // class sleep transport, so without this a Google-Health user's morning
  // refresh never fired and their day stayed stuck at the 04:30 pre-pass.
  void maybeEnqueueMorningRefresh(
    userId,
    inserted
      .filter((r) => r.type === "SLEEP_DURATION")
      .map((r) => r.measuredAt),
  ).catch(() => {});

  annotate({
    action: { name: "googleHealth.sleep.sync", details: { imported } },
  });
  return imported;
}
