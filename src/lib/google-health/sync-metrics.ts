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
 *   - daily-heart-rate-variability          → HRV_RMSSD (RMSSD; see mapper)
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
  GOOGLE_HEALTH_DEFAULT_MAX_PAGES,
  GOOGLE_HEALTH_DENSE_MAX_PAGES,
  fetchDataPoints,
  forEachDataPointPage,
} from "./data-points";
import { type GoogleHealthTokenSource } from "./request";
import {
  GOOGLE_HEALTH_DATA_TYPES,
  type GoogleHealthDataPoint,
  type GoogleHealthDataType,
  type GoogleHealthMappedMeasurement,
  googleHealthSampleInstant,
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
} from "./mappers";
import { googleHealthBackfillHorizon } from "./backfill-bounds";
import {
  getValidToken,
  googleHealthBackfillCursor,
  googleHealthHardFailureCount,
  googleHealthTokenSource,
  handleCollectionFetchError,
  noteGoogleHealthEdgeFilterUnsupported,
  recordGoogleHealthBackfillEnd,
  recordGoogleHealthBackfillPage,
  recordGoogleHealthBackfillResumePoint,
  runGoogleHealthCollection,
  upsertGoogleHealthMeasurements,
  type GoogleHealthMeasurementUpsert,
  type GoogleHealthResourceSyncOptions,
} from "./sync-core";
import { getEvent } from "@/lib/logging/context";
import type { GoogleHealthCollectionKey } from "./collection-keys";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/** One mappable metric: its data-type encoding + the per-point mapper + a verb. */
interface MetricResource {
  dataType: GoogleHealthDataType;
  map: (
    point: Record<string, unknown>,
    tz: string,
  ) => GoogleHealthMappedMeasurement[];
  verb: GoogleHealthCollectionKey;
  /**
   * The measurement type the collection's readings land as (heart rate's
   * main one for the intraday stream), which names its history when a
   * backfill ends it short.
   */
  type: MeasurementType;
  /** Page ceiling for the walk; the client default when omitted. */
  maxPages?: number;
  /**
   * v1.42 — a minute-level sample stream, final when written, so it
   * re-reads only the short intraday overlap instead of a whole day.
   */
  intraday?: boolean;
}

/** The launch metric resources (Measurement-producing). Height handled separately. */
const METRIC_RESOURCES: MetricResource[] = [
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.weight,
    map: mapWeight,
    verb: "fetchWeight",
    type: "WEIGHT",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.bodyFat,
    map: mapBodyFat,
    verb: "fetchBodyFat",
    type: "BODY_FAT",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.oxygenSaturation,
    map: mapOxygenSaturation,
    verb: "fetchSpo2",
    type: "OXYGEN_SATURATION",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.heartRateVariability,
    map: mapHeartRateVariability,
    verb: "fetchHrv",
    type: "HRV_RMSSD",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.restingHeartRate,
    map: mapRestingHeartRate,
    verb: "fetchRhr",
    type: "RESTING_HEART_RATE",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.respiratoryRate,
    map: mapRespiratoryRate,
    verb: "fetchRespiratoryRate",
    type: "RESPIRATORY_RATE",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.bloodGlucose,
    map: mapBloodGlucose,
    verb: "fetchBloodGlucose",
    type: "BLOOD_GLUCOSE",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.coreBodyTemperature,
    map: mapCoreBodyTemperature,
    verb: "fetchCoreBodyTemperature",
    type: "BODY_TEMPERATURE",
  },
  // Nightly sleep skin temperature — the documented `nightlyTemperatureCelsius`
  // is an absolute reading (not the once-assumed signed deviation), so it lands
  // in the WRIST_TEMPERATURE absolute-reading slot.
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.sleepTemperature,
    map: mapWristTemperature,
    verb: "fetchSleepTemperature",
    type: "WRIST_TEMPERATURE",
  },
  // Last: the dense stream. A backfill finishes every light collection in
  // its first slice and then works through this one slice by slice; ahead
  // of them it held them back until the whole stream was in.
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.heartRate,
    map: mapHeartRate,
    verb: "fetchHeartRate",
    type: "PULSE",
    maxPages: GOOGLE_HEALTH_DENSE_MAX_PAGES,
    intraday: true,
  },
];

/**
 * Whether a metric is walked resumably by a backfill: written page by page,
 * and a spot reading whose sample time can mark how far the walk got.
 */
function isResumable(resource: MetricResource): boolean {
  return resource.dataType.timeField === "sample";
}

export async function syncUserMetrics(
  userId: string,
  opts: GoogleHealthResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;
  const token = googleHealthTokenSource(userId, tokenInfo);

  // The incremental lower bound is the cycle-wide watermark snapshotted once by
  // `syncUserGoogleHealth` — never re-read here, so a sibling resource's stamp
  // can't shrink this one's window. Undefined on a full/backfill run.
  const start = opts.start;
  // Daily summaries are anchored at local noon of their date, and offset-less
  // sample times are read on the user's wall clock.
  const tz = await resolveUserTimezone(userId);

  let imported = 0;

  // Each metric data type is fetched + mapped independently so a per-class 403
  // soft-skips only that class.
  //
  // Every type is written page by page as it is read. Intraday heart rate is
  // one point a minute, so a full-history backfill is over a million points;
  // collecting the whole collection first and mapping it second held the raw
  // points and the readings at once and ran a 1 GB heap out of memory on
  // exactly the accounts with the most history. A page is at most
  // `GOOGLE_HEALTH_PAGE_SIZE` points, and nothing from it outlives its write.
  //
  // The mapper runs inside the same per-type catch: a single malformed point
  // whose `resource.map(point)` throws must not escape the METRIC_RESOURCES
  // loop and skip every metric type ordered after it (which also blocked the
  // watermark, so the bad point refetched hourly and those types stayed dead).
  // A map throw goes through the same ledger as a fetch failure — record it,
  // fail the cycle, and move on to the next type. Pages already written before
  // the failure stay written: every write is keyed, so the retry that the
  // failed verdict causes overwrites them in place.
  for (const resource of METRIC_RESOURCES) {
    imported += await runGoogleHealthCollection(resource.verb, () =>
      syncMetricCollection(userId, resource, token, tz, opts),
    );
  }

  // Height → User.heightCm, only when the user has no height yet. Never mint a
  // Measurement; never overwrite a user-set value. Mirrors WHOOP's mapBody seed.
  try {
    let heightPoints: Record<string, unknown>[];
    try {
      heightPoints = await fetchDataPoints(
        GOOGLE_HEALTH_DATA_TYPES.height,
        token,
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

/**
 * Walk one metric collection page by page and write each page as it arrives.
 * A failure (fetch, map or write) goes through the collection ledger and
 * stops only this collection; the siblings still run.
 */
async function syncMetricCollection(
  userId: string,
  resource: MetricResource,
  token: GoogleHealthTokenSource,
  tz: string,
  opts: GoogleHealthResourceSyncOptions,
): Promise<number> {
  let imported = 0;
  // Inside a backfill a spot-reading collection keeps its place: it starts
  // from the edge an earlier attempt reached and records its new edge after
  // every page it writes (see `GoogleHealthBackfillCursor`). Its walk is
  // bounded per attempt by the slice, across attempts by the edge having to
  // move back on every page and by the horizon: readings older than it are
  // not read, and the collection ends there (see `backfill-bounds.ts`).
  const cursor = isResumable(resource)
    ? googleHealthBackfillCursor(resource.verb)
    : null;
  const maxPages = resource.maxPages ?? GOOGLE_HEALTH_DEFAULT_MAX_PAGES;
  const horizon = cursor ? googleHealthBackfillHorizon() : null;
  // The order the walk returns readings in: the one its edge has recorded,
  // else the page's own (as `recordGoogleHealthBackfillPage` reads it),
  // newest first when a page cannot tell.
  const walkOrder = (page: GoogleHealthDataPoint[]): "desc" | "asc" => {
    const known = googleHealthBackfillCursor(resource.verb)?.edge?.order;
    if (known) return known;
    const instants = page
      .map((p) =>
        googleHealthSampleInstant(p, resource.dataType, tz)?.getTime(),
      )
      .filter((t): t is number => t !== undefined);
    return instants.length > 1 && instants[0]! < instants.at(-1)!
      ? "asc"
      : "desc";
  };
  // Once one page's write fails, the edge stays where it is for the rest of
  // the walk: moving it past the failed page would leave that page's rows
  // behind it for good.
  let edgeHeld = false;
  try {
    await forEachDataPointPage(
      resource.dataType,
      token,
      resource.verb,
      {
        start: resource.intraday
          ? (opts.intradayStart ?? opts.start)
          : opts.start,
        maxPages,
        ...(cursor
          ? {
              resumable: true,
              // Google keeps handing out pages that reach no further back:
              // the walk is noted as ending where it got to. The first time
              // it waits a day for another attempt; a second such end is
              // where the history stays (`backfill-bounds.ts`).
              onNoProgress: async () => {
                // A page whose write failed fails the collection instead.
                if (edgeHeld) return;
                // Nothing written yet: there is no place the history could
                // be said to end at, and "now" would be false. The walk
                // stays unfinished and fails the slice like any stuck one.
                const at = googleHealthBackfillCursor(resource.verb)?.edge?.at;
                if (!at) return;
                await recordGoogleHealthBackfillEnd(resource.verb, {
                  type: resource.type,
                  at: at.toISOString(),
                  reason: "no_progress",
                });
              },
              edge: cursor.edge && {
                ...cursor.edge,
                tz,
                onFilterUnsupported: () =>
                  noteGoogleHealthEdgeFilterUnsupported(resource.verb),
                // A place past a page whose write failed would leave that
                // page's rows behind it, like a moved edge would.
                onResumePoint: (point) =>
                  edgeHeld
                    ? undefined
                    : recordGoogleHealthBackfillResumePoint(
                        resource.verb,
                        point,
                      ),
              },
            }
          : {}),
      },
      async (page) => {
        // Past the horizon nothing is written; on a newest-first walk
        // everything after it is older still, so the walk ends there. An
        // oldest-first walk starts beyond the horizon and works toward it,
        // so it is read as before: dropping its first pages would write
        // nothing and move no edge, and the slice would fail as stuck.
        let points = page;
        let pastHorizon = false;
        if (horizon && walkOrder(page) === "desc") {
          points = page.filter((p) => {
            const t = googleHealthSampleInstant(p, resource.dataType, tz);
            return t === null || t.getTime() >= horizon.getTime();
          });
          pastHorizon = points.length < page.length;
        }
        const readings: GoogleHealthMeasurementUpsert[] = [];
        for (const point of points) {
          for (const m of resource.map(point, tz)) {
            readings.push({
              type: m.type,
              value: m.value,
              unit: m.unit,
              measuredAt: m.measuredAt,
              externalId: m.fieldTag,
            });
          }
        }
        const failuresBefore = googleHealthHardFailureCount();
        imported += (
          await upsertGoogleHealthMeasurements(userId, readings, {
            deferRollup: opts.deferRollup,
          })
        ).imported;
        if (!cursor) return;
        if (googleHealthHardFailureCount() !== failuresBefore) edgeHeld = true;
        if (points.length > 0 && !edgeHeld) {
          await recordGoogleHealthBackfillPage(resource.verb, {
            first: googleHealthSampleInstant(points[0]!, resource.dataType, tz),
            last: googleHealthSampleInstant(
              points[points.length - 1]!,
              resource.dataType,
              tz,
            ),
          });
        }
        if (pastHorizon) {
          // With a page's write failed the collection is not finished
          // either way; it is walked again next slice.
          if (!edgeHeld) {
            await recordGoogleHealthBackfillEnd(resource.verb, {
              type: resource.type,
              at: horizon!.toISOString(),
              reason: "horizon",
            });
          }
          return "end";
        }
      },
    );
  } catch (err) {
    imported += await handleCollectionFetchError(resource.verb, userId, err);
  }
  return imported;
}
