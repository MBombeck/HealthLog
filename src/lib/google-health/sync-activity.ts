/**
 * Google Health activity-bundle sync (v1.27.0).
 *
 * Reads the daily cumulative-activity data types from the
 * `activity_and_fitness.readonly` Restricted bundle and upserts each mapped
 * daily total as `source = GOOGLE_HEALTH`:
 *
 *   - steps                → ACTIVITY_STEPS            (countSum)
 *   - distance             → WALKING_RUNNING_DISTANCE  (millimetersSum → m)
 *   - active-energy-burned → ACTIVE_ENERGY_BURNED      (kcalSum — ACTIVE portion only)
 *   - floors               → FLIGHTS_CLIMBED           (countSum)
 *   - daily-vo2-max        → VO2_MAX                    (mL/(kg·min); daily latest-wins)
 *
 * The four cumulative types read through `POST :dailyRollUp` with
 * `windowSizeDays: 1` (their `list` surface returns minute-grain buckets, not
 * daily totals — and floors has no list method at all); VO2 max is a daily
 * summary read through list with a `.date` filter. The externalId is minted
 * with the `stats:` daily-total prefix — `stats:<fieldTag>:<YYYY-MM-DD>` — so a
 * re-fetched day OVERWRITES the existing row rather than minting a duplicate,
 * matching the Apple-Health `stats:<HK>:<YYYY-MM-DD>` overwrite contract. A day
 * of rest legitimately records 0 steps / 0 floors / 0 active kcal, so the
 * rollup mapper preserves a zero; VO2 max stays strictly positive.
 *
 * A per-data-class 403 soft-skips THAT class (returns 0, leaves the connection
 * connected) — the Restricted bundles are granted independently.
 */
import {
  GOOGLE_HEALTH_DATA_TYPES,
  type GoogleHealthDataType,
  type GoogleHealthMappedMeasurement,
  fetchDailyRollUp,
  fetchDataPoints,
  mapActiveEnergy,
  mapDistance,
  mapFloors,
  mapSteps,
  mapVo2Max,
} from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  upsertGoogleHealthMeasurements,
  type GoogleHealthMeasurementUpsert,
  type GoogleHealthResourceSyncOptions,
} from "./sync-core";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/** One mappable activity metric: its data-type encoding + the mapper + a verb. */
interface ActivityResource {
  dataType: GoogleHealthDataType;
  map: (point: Record<string, unknown>) => GoogleHealthMappedMeasurement[];
  verb: string;
}

/** The four cumulative daily totals — read via `POST :dailyRollUp`. */
const ROLLUP_RESOURCES: ActivityResource[] = [
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.steps,
    map: mapSteps,
    verb: "fetchSteps",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.distance,
    map: mapDistance,
    verb: "fetchDistance",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.activeEnergy,
    map: mapActiveEnergy,
    verb: "fetchActiveEnergy",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.floors,
    map: mapFloors,
    verb: "fetchFloors",
  },
];

/**
 * Assemble the stored externalId for a mapped activity reading. A cumulative
 * daily metric carries the `cumulativeDaily` flag from its mapper — its
 * externalId gets the `stats:` daily-total prefix so a re-fetched day overwrites
 * in place (the mapper's `fieldTag` is already the `<tag>:<YYYY-MM-DD>` form).
 */
function externalIdFor(m: GoogleHealthMappedMeasurement): string {
  return m.cumulativeDaily ? `stats:${m.fieldTag}` : m.fieldTag;
}

export async function syncUserActivity(
  userId: string,
  opts: GoogleHealthResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // The dailyRollUp request range is civil and user-local; resolve the user's
  // stored zone so the range bounds land on the correct civil days rather than
  // the process zone's. (The response day-key comes from each window's own
  // `civilStartTime.date`, tz-independent.)
  const tz = await resolveUserTimezone(userId);

  // Cycle-wide watermark snapshotted once by `syncUserGoogleHealth`; undefined
  // on a full/backfill run.
  const start = opts.start;

  let imported = 0;
  // Rollup observability — a cumulative type that "works" (HTTP 200) can still
  // land zero rows for two very different reasons, and the sync log must tell
  // them apart without a live-account debugging round-trip:
  //   emptyResponse → the service returned NO rollup points at all (Google-side
  //                   materialisation for the account / device cohort);
  //   droppedAll    → points arrived but none survived the mapper (a response
  //                   naming/shape drift on this account's service revision).
  const rollupEmptyResponse: string[] = [];
  const rollupDroppedAll: string[] = [];
  for (const resource of ROLLUP_RESOURCES) {
    let points: Record<string, unknown>[];
    try {
      points = await fetchDailyRollUp(
        resource.dataType,
        tokenInfo.accessToken,
        resource.verb,
        { start, tz },
      );
    } catch (err) {
      imported += await handleCollectionFetchError(resource.verb, userId, err);
      continue;
    }

    // The mapper runs INSIDE a per-type catch too (mirrors sync-metrics): a
    // single malformed point whose `resource.map(point)` throws must not
    // escape the ROLLUP_RESOURCES loop and abort every sibling type ordered
    // after it. Route a map throw through the same ledger as a fetch failure —
    // record it, fail the cycle, and move on to the next type.
    const readings: GoogleHealthMeasurementUpsert[] = [];
    try {
      for (const point of points) {
        for (const m of resource.map(point)) {
          readings.push({
            type: m.type,
            value: m.value,
            unit: m.unit,
            measuredAt: m.measuredAt,
            externalId: externalIdFor(m),
          });
        }
      }
    } catch (err) {
      imported += await handleCollectionFetchError(resource.verb, userId, err);
      continue;
    }
    if (points.length === 0) {
      rollupEmptyResponse.push(resource.verb);
    } else if (readings.length === 0) {
      rollupDroppedAll.push(resource.verb);
    }
    imported += (
      await upsertGoogleHealthMeasurements(userId, readings, {
        deferRollup: opts.deferRollup,
      })
    ).imported;
  }
  if (rollupEmptyResponse.length > 0 || rollupDroppedAll.length > 0) {
    annotate({
      meta: {
        "googleHealth.rollup.emptyResponse": rollupEmptyResponse,
        "googleHealth.rollup.droppedAll": rollupDroppedAll,
      },
    });
  }

  // VO2 max — a daily summary (list + `.date` filter), not a rollup type.
  try {
    const points = await fetchDataPoints(
      GOOGLE_HEALTH_DATA_TYPES.vo2Max,
      tokenInfo.accessToken,
      "fetchVo2Max",
      { start },
    );
    const readings: GoogleHealthMeasurementUpsert[] = [];
    for (const point of points) {
      for (const m of mapVo2Max(point)) {
        readings.push({
          type: m.type,
          value: m.value,
          unit: m.unit,
          measuredAt: m.measuredAt,
          externalId: externalIdFor(m),
        });
      }
    }
    imported += (
      await upsertGoogleHealthMeasurements(userId, readings, {
        deferRollup: opts.deferRollup,
      })
    ).imported;
  } catch (err) {
    imported += await handleCollectionFetchError("fetchVo2Max", userId, err);
  }

  // `markSynced` is owned by the orchestrator (`syncUserGoogleHealth`).
  annotate({
    action: { name: "googleHealth.activity.sync", details: { imported } },
  });
  return imported;
}
