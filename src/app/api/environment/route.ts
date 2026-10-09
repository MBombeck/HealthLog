/**
 * `GET /api/environment` — the environmental-context module overview.
 *
 * Returns the account's coarse home location, its travel overrides, a small
 * summary of stored daily observations (count + latest day), and the upstream
 * attribution string. Module-gated: a 403 `module.disabled` envelope when the
 * opt-in module is off. `userId` is narrowed from auth, never a body field.
 *
 * v1.42 (#615) — the locations are stored sealed and opened here, so the
 * answer keeps its readable shape. Added beside it: the air-quality state
 * (the account switch, the operator switch, how many days carry air-quality
 * values), the newest stored day for the dashboard chips (with its air
 * quality only while the part is on), and every attribution line in
 * `attributions`, and the progress of the air-quality history backfill
 * (`airQuality.history`).
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { OPEN_METEO_ATTRIBUTION } from "@/lib/environment/open-meteo";
import { isAirQualityOperatorDisabled } from "@/lib/environment/open-meteo-air-quality";
import { environmentAttributionLines } from "@/lib/environment/air-quality-contract";
import { readLocation } from "@/lib/environment/location-cipher";
import { isAirQualityActive } from "@/lib/environment/service";
import { readAirQualityHistoryState } from "@/lib/environment/air-quality-history";
import { ENVIRONMENT_FETCH_QUEUE } from "@/lib/jobs/environment-fetch";
import { readQueueFailureForUser } from "@/lib/jobs/job-failures";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  const [
    profile,
    travelRows,
    contextCount,
    latest,
    airDays,
    latestAir,
    lastFetchFailure,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: {
        homeLat: true,
        homeLon: true,
        homeLabel: true,
        homeLocationEncrypted: true,
        homeTimezone: true,
        homeSince: true,
        timezone: true,
        environmentAirQualityEnabled: true,
        environmentAqHistoryJson: true,
      },
    }),
    prisma.environmentTravelLocation.findMany({
      where: { userId: user.id },
      orderBy: { startDate: "desc" },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        lat: true,
        lon: true,
        label: true,
        locationEncrypted: true,
      },
    }),
    prisma.environmentContext.count({ where: { userId: user.id } }),
    prisma.environmentContext.findFirst({
      where: { userId: user.id },
      orderBy: { date: "desc" },
      select: {
        date: true,
        fetchedAt: true,
        tempMin: true,
        tempMax: true,
        apparentMax: true,
        pm25Mean: true,
        pm10Mean: true,
        no2Mean: true,
        o3Max8h: true,
        eaqiMax: true,
        uvIndexMax: true,
        dustMax: true,
        pollenAlderMax: true,
        pollenBirchMax: true,
        pollenGrassMax: true,
        pollenMugwortMax: true,
        pollenOliveMax: true,
        pollenRagweedMax: true,
        aqFetchedAt: true,
      },
    }),
    // A day "carries air quality" when the feed returned hourly values for
    // it; a day fetched with nothing in it (outside the feed) does not count.
    prisma.environmentContext.count({
      where: { userId: user.id, aqHours: { gt: 0 } },
    }),
    prisma.environmentContext.findFirst({
      where: { userId: user.id, aqHours: { gt: 0 } },
      orderBy: { date: "desc" },
      select: { date: true, aqDomain: true },
    }),
    // A day count on its own cannot tell an empty module from a broken one —
    // which is exactly how a job that failed on every run since the module
    // shipped could render as "0 days recorded" and nothing else. The queue
    // knows; the overview asks it.
    readQueueFailureForUser(ENVIRONMENT_FETCH_QUEUE, user.id),
  ]);

  const homeLocation = profile
    ? readLocation({
        sealed: profile.homeLocationEncrypted,
        lat: profile.homeLat,
        lon: profile.homeLon,
        // The label may be absent on a pre-v1.42 home; the answer has
        // always allowed a null label there.
        label: profile.homeLabel ?? "",
      })
    : null;
  const home =
    profile && homeLocation
      ? {
          lat: homeLocation.lat,
          lon: homeLocation.lon,
          label: homeLocation.label === "" ? null : homeLocation.label,
          timezone: profile.homeTimezone ?? profile.timezone,
          // Effective-from instant: the settings surface uses it to label the
          // home and to prefill the backfill start (conservative default range).
          since: profile.homeSince?.toISOString() ?? null,
        }
      : null;

  const travel = travelRows.flatMap((row) => {
    const location = readLocation({
      sealed: row.locationEncrypted,
      lat: row.lat,
      lon: row.lon,
      label: row.label,
    });
    return location
      ? [
          {
            id: row.id,
            startDate: row.startDate,
            endDate: row.endDate,
            ...location,
          },
        ]
      : [];
  });

  const accountEnabled = profile?.environmentAirQualityEnabled ?? true;
  const operatorDisabled = isAirQualityOperatorDisabled();
  const airActive = isAirQualityActive(accountEnabled);
  // The history backfill's progress, while the part is on: what the last run
  // counted, so the card can say how far the past has been filled.
  const historyState = airActive
    ? readAirQualityHistoryState(profile?.environmentAqHistoryJson)
    : null;
  const history = historyState
    ? {
        total: historyState.total,
        done: historyState.done,
        complete: historyState.complete,
        checkedAt: historyState.checkedAt,
      }
    : null;
  const latestYear = Number(
    (latestAir?.date ?? latest?.date ?? new Date().toISOString()).slice(0, 4),
  );

  const latestDay = latest
    ? {
        date: latest.date,
        tempMin: latest.tempMin,
        tempMax: latest.tempMax,
        apparentMax: latest.apparentMax,
        // The air-quality part of the day only while the part is on, and
        // only once it was fetched: an unfetched day says nothing, which is
        // not the same as clean air.
        airQuality:
          airActive && latest.aqFetchedAt
            ? {
                pm25Mean: latest.pm25Mean,
                pm10Mean: latest.pm10Mean,
                no2Mean: latest.no2Mean,
                o3Max8h: latest.o3Max8h,
                eaqiMax: latest.eaqiMax,
                uvIndexMax: latest.uvIndexMax,
                dustMax: latest.dustMax,
                pollen: {
                  alder: latest.pollenAlderMax,
                  birch: latest.pollenBirchMax,
                  grass: latest.pollenGrassMax,
                  mugwort: latest.pollenMugwortMax,
                  olive: latest.pollenOliveMax,
                  ragweed: latest.pollenRagweedMax,
                },
              }
            : null,
      }
    : null;

  annotate({
    action: { name: "environment.overview.read" },
    meta: {
      has_home: home !== null,
      travel_count: travel.length,
      context_days: contextCount,
      air_quality_days: airDays,
      air_quality_active: airActive,
      last_fetch_failed: lastFetchFailure !== null,
    },
  });

  return apiSuccess({
    home,
    travel,
    context: {
      days: contextCount,
      latestDate: latest?.date ?? null,
      latestFetchedAt: latest?.fetchedAt?.toISOString() ?? null,
    },
    airQuality: {
      enabled: accountEnabled,
      operatorDisabled,
      days: airDays,
      latestDate: latestAir?.date ?? null,
      domain: latestAir?.aqDomain ?? null,
      history,
    },
    latestDay,
    // null = the last background runs did not fail (or there is no queue to
    // ask). Non-null names the failure so a zero day count is never left to
    // stand alone. No error text: that message is written for an operator.
    lastFetchFailure,
    attribution: OPEN_METEO_ATTRIBUTION,
    attributions: environmentAttributionLines({
      airQuality: airActive,
      year: latestYear,
    }),
  });
});
