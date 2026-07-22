/**
 * Fitbit Web API health-metrics sync.
 *
 * Reads the launch metric endpoints from the classic Fitbit Web API and upserts
 * each mapped reading as `source = FITBIT`:
 *
 *   - body/log/weight        → WEIGHT                  (kg)
 *   - body/log/fat           → BODY_FAT                (%)
 *   - spo2 summary           → OXYGEN_SATURATION       (%)
 *   - hrv summary            → HEART_RATE_VARIABILITY  (ms, dailyRmssd)
 *   - activities/heart       → RESTING_HEART_RATE      (bpm)
 *   - br summary             → RESPIRATORY_RATE        (breaths/min)
 *
 * Each endpoint is a date-RANGE call (one request per ≤30-day window), so the
 * sync chunks `[start, end]` into per-endpoint windows to respect the API range
 * caps and the 150 req/h budget. Each metric is fetched independently so a
 * per-endpoint 403 (a scope the user did not grant) soft-skips only that metric.
 *
 * NOTE: intraday heart rate (`PULSE`) is intentionally NOT synced — the classic
 * API gates intraday series behind a Personal-app / explicit per-app grant most
 * self-hosters do not have, and the daily resting HR is always available. Skin
 * temperature is also skipped: the classic reading is a baseline DELTA, not an
 * absolute value, so it has no honest canonical slot (see mapping.md).
 */
import {
  FITBIT_RANGE_DAYS,
  fetchBodyFatRange,
  fetchHrvRange,
  fetchRespiratoryRateRange,
  fetchRestingHeartRateRange,
  fetchSpo2Range,
  fetchWeightRange,
  mapBodyFat,
  mapHeartRateVariability,
  mapOxygenSaturation,
  mapRespiratoryRate,
  mapRestingHeartRate,
  mapWeight,
} from "./client";
import type { FitbitMappedMeasurement } from "./client";
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

/** One mappable metric: a range fetcher + a body mapper + a verb. */
interface MetricResource {
  fetch: (accessToken: string, start: Date, end: Date) => Promise<unknown>;
  map: (body: unknown) => FitbitMappedMeasurement[];
  verb: string;
}

const METRIC_RESOURCES: MetricResource[] = [
  { fetch: fetchWeightRange, map: mapWeight, verb: "fetchWeight" },
  { fetch: fetchBodyFatRange, map: mapBodyFat, verb: "fetchBodyFat" },
  { fetch: fetchSpo2Range, map: mapOxygenSaturation, verb: "fetchSpo2" },
  { fetch: fetchHrvRange, map: mapHeartRateVariability, verb: "fetchHrv" },
  {
    fetch: fetchRestingHeartRateRange,
    map: mapRestingHeartRate,
    verb: "fetchRhr",
  },
  {
    fetch: fetchRespiratoryRateRange,
    map: mapRespiratoryRate,
    verb: "fetchRespiratoryRate",
  },
];

export async function syncUserMetrics(
  userId: string,
  opts: FitbitResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  const start = opts.start ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = opts.end ?? new Date();
  const windows = chunkDateRanges(start, end, FITBIT_RANGE_DAYS);

  let imported = 0;

  // Each metric is fetched + mapped independently so a per-endpoint 403
  // soft-skips only that metric. A 403 short-circuits THAT metric (skips its
  // remaining windows) without aborting the others.
  for (const resource of METRIC_RESOURCES) {
    const readings: FitbitMeasurementUpsert[] = [];
    let forbidden = false;
    for (const w of windows) {
      let body: unknown;
      try {
        body = await resource.fetch(tokenInfo.accessToken, w.start, w.end);
      } catch (err) {
        imported += await handleCollectionFetchError(
          resource.verb,
          userId,
          err,
        );
        forbidden = true;
        break;
      }
      try {
        for (const m of resource.map(body)) {
          readings.push({
            type: m.type,
            value: m.value,
            unit: m.unit,
            measuredAt: m.measuredAt,
            externalId: m.fieldTag,
          });
        }
      } catch (err) {
        // A malformed point whose mapper throws routes through the same ledger
        // as a fetch failure — record it, short-circuit this metric, and let the
        // sibling metrics keep syncing.
        imported += await handleCollectionFetchError(
          resource.verb,
          userId,
          err,
        );
        forbidden = true;
        break;
      }
    }
    if (forbidden) continue;
    imported += (
      await upsertFitbitMeasurements(userId, readings, {
        deferRollup: opts.deferRollup,
      })
    ).imported;
  }

  // `markSynced` is owned by the orchestrator (`syncUserFitbit`).
  return imported;
}
