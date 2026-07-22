/**
 * Fitbit Web API activity-bundle sync.
 *
 * Reads the daily cumulative-activity time series + VO2 max from the classic
 * Fitbit Web API and upserts each mapped daily total as `source = FITBIT`:
 *
 *   - activities/steps            → ACTIVITY_STEPS            (count)
 *   - activities/distance         → WALKING_RUNNING_DISTANCE  (metres, km→m)
 *   - activities/activityCalories → ACTIVE_ENERGY_BURNED      (kcal, ACTIVE only)
 *   - activities/floors           → FLIGHTS_CLIMBED           (count)
 *   - cardioscore                 → VO2_MAX                    (mL/(kg·min))
 *
 * These are per-day summaries (one value per calendar day). The externalId is
 * minted with the `stats:` daily-total prefix — `stats:<fieldTag>:<YYYY-MM-DD>`
 * — so a re-fetched day OVERWRITES the existing row, matching the Apple-Health
 * `stats:<HK>:<YYYY-MM-DD>` overwrite contract. A rest day records a real 0
 * (dropping it would leave a chart gap); VO2 max stays strictly positive.
 *
 * Each endpoint is a date-RANGE call chunked into ≤30-day windows. A per-endpoint
 * 403 soft-skips THAT metric only.
 */
import {
  FITBIT_RANGE_DAYS,
  fetchActivitySeries,
  fetchVo2MaxRange,
  mapActiveCalories,
  mapDistance,
  mapFloors,
  mapSteps,
  mapVo2Max,
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
import { annotate } from "@/lib/logging/context";

/** One mappable activity metric: a range fetcher + a body mapper + a verb. */
interface ActivityResource {
  fetch: (accessToken: string, start: Date, end: Date) => Promise<unknown>;
  map: (body: unknown) => FitbitMappedMeasurement[];
  verb: string;
}

const ACTIVITY_RESOURCES: ActivityResource[] = [
  {
    fetch: (t, s, e) => fetchActivitySeries("steps", t, s, e),
    map: mapSteps,
    verb: "fetchSteps",
  },
  {
    fetch: (t, s, e) => fetchActivitySeries("distance", t, s, e),
    map: mapDistance,
    verb: "fetchDistance",
  },
  {
    fetch: (t, s, e) => fetchActivitySeries("activityCalories", t, s, e),
    map: mapActiveCalories,
    verb: "fetchActiveCalories",
  },
  {
    fetch: (t, s, e) => fetchActivitySeries("floors", t, s, e),
    map: mapFloors,
    verb: "fetchFloors",
  },
  { fetch: fetchVo2MaxRange, map: mapVo2Max, verb: "fetchVo2Max" },
];

/**
 * Assemble the stored externalId for a mapped activity reading. A cumulative
 * daily metric carries the `cumulativeDaily` flag — its externalId gets the
 * `stats:` daily-total prefix so a re-fetched day overwrites in place (the
 * mapper's `fieldTag` is already the `<tag>:<YYYY-MM-DD>` form).
 */
function externalIdFor(m: FitbitMappedMeasurement): string {
  return m.cumulativeDaily ? `stats:${m.fieldTag}` : m.fieldTag;
}

export async function syncUserActivity(
  userId: string,
  opts: FitbitResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  const start = opts.start ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = opts.end ?? new Date();
  const windows = chunkDateRanges(start, end, FITBIT_RANGE_DAYS);

  let imported = 0;
  for (const resource of ACTIVITY_RESOURCES) {
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
            externalId: externalIdFor(m),
          });
        }
      } catch (err) {
        // A malformed point whose mapper throws routes through the same ledger
        // as a fetch failure — record it, short-circuit this resource, and let
        // the sibling resources keep syncing.
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
  annotate({ action: { name: "fitbit.activity.sync", details: { imported } } });
  return imported;
}
