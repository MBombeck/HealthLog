/**
 * Google Health "health metrics & measurements" bundle sync (v1.27.0).
 *
 * Reads the launch metric data types from the
 * `health_metrics_and_measurements.readonly` Restricted bundle and upserts each
 * mapped reading as `source = GOOGLE_HEALTH`:
 *
 *   - weight                                → WEIGHT
 *   - body-fat                              → BODY_FAT
 *   - daily-oxygen-saturation               → OXYGEN_SATURATION
 *   - daily-heart-rate-variability          → HEART_RATE_VARIABILITY (SDNN slot; see mapper)
 *   - daily-resting-heart-rate              → RESTING_HEART_RATE
 *   - daily-respiratory-rate                → RESPIRATORY_RATE
 *   - heart-rate (intraday)                 → PULSE
 *   - blood-glucose                         → BLOOD_GLUCOSE (mg/dL at source)
 *   - core-body-temperature                 → BODY_TEMPERATURE
 *   - daily-sleep-temperature-derivations   → WRIST_TEMPERATURE (absolute nightly skin temp)
 *   - height                                → User.heightCm (profile seed, NOT a Measurement)
 *
 * Each data point yields at most one Measurement row, disambiguated by the
 * per-point anchor + field-tag in the externalId (`<anchor>:<fieldTag>`) so a
 * re-fetch of the same window overwrites in place rather than duplicating.
 *
 * A per-data-class 403 soft-skips THAT class (returns 0, leaves the connection
 * connected) rather than parking the whole integration — the Restricted bundles
 * can be granted independently in the Google consent flow.
 */
import {
  GOOGLE_HEALTH_DATA_TYPES,
  type GoogleHealthDataType,
  type GoogleHealthMappedMeasurement,
  fetchDataPoints,
  mapBloodGlucose,
  mapBodyFat,
  mapCoreBodyTemperature,
  mapHeartRate,
  mapHeartRateVariability,
  mapHeight,
  mapOxygenSaturation,
  mapRespiratoryRate,
  mapRestingHeartRate,
  mapWeight,
  mapWristTemperature,
} from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  upsertGoogleHealthMeasurements,
  type GoogleHealthMeasurementUpsert,
  type GoogleHealthResourceSyncOptions,
} from "./sync-core";
import { getEvent } from "@/lib/logging/context";
import { prisma } from "@/lib/db";

/** One mappable metric: its data-type encoding + the per-point mapper + a verb. */
interface MetricResource {
  dataType: GoogleHealthDataType;
  map: (point: Record<string, unknown>) => GoogleHealthMappedMeasurement[];
  verb: string;
}

/** The launch metric resources (Measurement-producing). Height handled separately. */
const METRIC_RESOURCES: MetricResource[] = [
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.weight,
    map: mapWeight,
    verb: "fetchWeight",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.bodyFat,
    map: mapBodyFat,
    verb: "fetchBodyFat",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.oxygenSaturation,
    map: mapOxygenSaturation,
    verb: "fetchSpo2",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.heartRateVariability,
    map: mapHeartRateVariability,
    verb: "fetchHrv",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.restingHeartRate,
    map: mapRestingHeartRate,
    verb: "fetchRhr",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.respiratoryRate,
    map: mapRespiratoryRate,
    verb: "fetchRespiratoryRate",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.heartRate,
    map: mapHeartRate,
    verb: "fetchHeartRate",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.bloodGlucose,
    map: mapBloodGlucose,
    verb: "fetchBloodGlucose",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.coreBodyTemperature,
    map: mapCoreBodyTemperature,
    verb: "fetchCoreBodyTemperature",
  },
  // Nightly sleep skin temperature — the documented `nightlyTemperatureCelsius`
  // is an absolute reading (not the once-assumed signed deviation), so it lands
  // in the WRIST_TEMPERATURE absolute-reading slot.
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.sleepTemperature,
    map: mapWristTemperature,
    verb: "fetchSleepTemperature",
  },
];

export async function syncUserMetrics(
  userId: string,
  opts: GoogleHealthResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // The incremental lower bound is the cycle-wide watermark snapshotted once by
  // `syncUserGoogleHealth` — never re-read here, so a sibling resource's stamp
  // can't shrink this one's window. Undefined on a full/backfill run.
  const start = opts.start;

  let imported = 0;

  // Each metric data type is fetched + mapped independently so a per-class 403
  // soft-skips only that class.
  for (const resource of METRIC_RESOURCES) {
    let points: Record<string, unknown>[];
    try {
      points = await fetchDataPoints(
        resource.dataType,
        tokenInfo.accessToken,
        resource.verb,
        { start },
      );
    } catch (err) {
      imported += await handleCollectionFetchError(resource.verb, userId, err);
      continue;
    }

    // The mapper runs INSIDE a per-type catch too: a single malformed point
    // whose `resource.map(point)` throws must not escape the METRIC_RESOURCES
    // loop and skip every metric type ordered after it (which also blocked the
    // watermark, so the bad point refetched hourly and those types stayed dead).
    // Route a map throw through the same ledger as a fetch failure — record it,
    // fail the cycle, and move on to the next type.
    const readings: GoogleHealthMeasurementUpsert[] = [];
    try {
      for (const point of points) {
        for (const m of resource.map(point)) {
          readings.push({
            type: m.type,
            value: m.value,
            unit: m.unit,
            measuredAt: m.measuredAt,
            externalId: m.fieldTag,
          });
        }
      }
    } catch (err) {
      imported += await handleCollectionFetchError(resource.verb, userId, err);
      continue;
    }
    imported += (
      await upsertGoogleHealthMeasurements(userId, readings, {
        deferRollup: opts.deferRollup,
      })
    ).imported;
  }

  // Height → User.heightCm, only when the user has no height yet. Never mint a
  // Measurement; never overwrite a user-set value. Mirrors WHOOP's mapBody seed.
  try {
    let heightPoints: Record<string, unknown>[];
    try {
      heightPoints = await fetchDataPoints(
        GOOGLE_HEALTH_DATA_TYPES.height,
        tokenInfo.accessToken,
        "fetchHeight",
        { start },
      );
    } catch (err) {
      heightPoints = [];
      await handleCollectionFetchError("fetchHeight", userId, err);
    }

    // Latest sample wins — picked by max(sampledAt) explicitly, because the
    // list response is ordered DESCENDING by time (a "last row wins" loop would
    // seed the OLDEST height). A sample with no parseable instant only wins
    // over nothing.
    let heightCm: number | null = null;
    let heightAt = -Infinity;
    for (const point of heightPoints) {
      const sample = mapHeight(point);
      if (sample === null) continue;
      const at = sample.sampledAt?.getTime() ?? -Infinity;
      if (heightCm === null || at > heightAt) {
        heightCm = sample.cm;
        heightAt = at;
      }
    }
    if (heightCm !== null) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { heightCm: true },
      });
      if (user && user.heightCm === null) {
        await prisma.user.update({
          where: { id: userId },
          data: { heightCm },
        });
      }
    }
  } catch (err) {
    getEvent()?.addWarning(
      `google-health: failed to seed heightCm for ${userId}: ${err}`,
    );
  }

  // `markSynced` is owned by the orchestrator (`syncUserGoogleHealth`), stamped
  // once at the end of the cycle — never here, so the watermark can't move
  // mid-cycle.
  return imported;
}
