/**
 * v1.25 (W-ENV) — environmental-context resolution + fetch/upsert service.
 *
 * Owns the location-precedence logic and the per-day upsert into
 * `EnvironmentContext`. Both the nightly job and the on-demand backfill route
 * call {@link fetchAndStoreEnvironment} so the precedence, the day-keying, and
 * the upsert live in exactly one place.
 *
 * Location precedence per day (first hit wins) — CONSERVATIVE:
 *   1. an explicit dated LOCATION PERIOD (override) whose [startDate, endDate]
 *      covers the day (a trip, OR a corrected stretch of history);
 *   2. DEVICE — reserved slot for a future client-supplied coarse per-day
 *      location (iOS v2); not produced server-side yet (see resolver comment);
 *   3. the user's HOME location, but ONLY for days on/after `homeSince` (the
 *      instant the home became effective).
 * A day before `homeSince`, or with no home and no covering period, is SKIPPED.
 * The resolver never attributes a past day to the *current* home — that would
 * fabricate weather for anyone who has moved/travelled. The deep past is filled
 * by adding explicit dated location periods.
 *
 * Coarse location only — the resolver never sees finer than the rounded city
 * coordinates stored on the user / override.
 *
 * v1.42 (#615) — the locations are sealed at rest (`location-cipher.ts`): the
 * home and the periods are opened here, the rows are written with the sealed
 * copy only, and the requests still carry nothing but the coarse coordinates.
 * The same run fetches the day's air quality, pollen and UV when the account
 * and the operator allow it (`isAirQualityActive`). An air-quality failure
 * never costs the weather row: the weather is stored, the air-quality part
 * stays unfetched (`aqFetchedAt` null), and the nightly gap fill
 * ({@link fillAirQualityGaps}) asks for it again.
 */
import { prisma } from "@/lib/db";
import {
  fetchDailyEnvironment,
  type DailyEnvironmentObservation,
} from "@/lib/environment/open-meteo";
import {
  fetchDailyAirQuality,
  isAirQualityActive,
  type AirQualityStop,
  type DailyAirQualityObservation,
} from "@/lib/environment/open-meteo-air-quality";
import { readLocation, sealLocation } from "@/lib/environment/location-cipher";

export { isAirQualityActive };
import { OpenMeteoBudgetExhaustedError } from "@/lib/environment/request-budget";
import type { EnvironmentLocationSource } from "@/generated/prisma/client";
import { shiftDateKey } from "@/lib/tz/format";

/** Default lookback window (days) for the nightly fetch — absorbs the archive
 * settling lag and any days missed across worker reboots. */
export const ENVIRONMENT_LOOKBACK_DAYS = 7;
/** Hard cap on a single backfill span so one request can never fan out forever. */
export const ENVIRONMENT_MAX_BACKFILL_DAYS = 730;

/** A coarse resolved location for a given day. */
interface ResolvedLocation {
  lat: number;
  lon: number;
  label: string;
  source: EnvironmentLocationSource;
}

interface HomeLocation {
  lat: number;
  lon: number;
  label: string;
  timezone: string;
  /** YYYY-MM-DD the home became effective; null ⇒ home resolves no day. */
  since: string | null;
}

interface TravelOverride {
  startDate: string;
  endDate: string;
  lat: number;
  lon: number;
  label: string;
}

/** UTC YYYY-MM-DD for `date` (used to bound the default lookback window). */
export function utcDayKey(date: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the environment module keys homeSince and the backfill window on UTC days throughout, and the worker compares against the same keys
  return date.toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD keys from `start` to `end` (date arithmetic). */
export function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let cur = start; cur <= end; cur = shiftDateKey(cur, 1)) {
    out.push(cur);
  }
  return out;
}

/**
 * Resolve the location for one day (CONSERVATIVE, first hit wins). Pure —
 * exported for unit tests.
 */
export function resolveLocationForDay(
  day: string,
  home: HomeLocation | null,
  travels: readonly TravelOverride[],
): ResolvedLocation | null {
  // 1. An explicit dated location period covering the day wins. This is also
  //    the mechanism a user/operator uses to correct history: an explicit
  //    period for a past range is honoured even before the home was effective.
  for (const t of travels) {
    if (day >= t.startDate && day <= t.endDate) {
      return { lat: t.lat, lon: t.lon, label: t.label, source: "TRAVEL" };
    }
  }
  // 2. DEVICE — reserved priority forward path (iOS v2). A future client supplies
  //    a coarse per-day device location that would rank HERE, between the explicit
  //    period and the home fallback. Nothing produces it server-side yet, but the
  //    resolver signature and the EnvironmentLocationSource enum already accept a
  //    "DEVICE" source, so wiring it in later needs no rework of this precedence.
  //
  // 3. Home — ONLY on/after the day it became effective (`homeSince`). Never
  //    fabricate past weather from the *current* home for days before it was set;
  //    those days are skipped and left to an explicit period above.
  if (home && home.since != null && day >= home.since) {
    return { lat: home.lat, lon: home.lon, label: home.label, source: "HOME" };
  }
  return null;
}

/**
 * The conservative default backfill span for an account: from the day its home
 * became effective (`homeSince`) through `today`. Days before `homeSince` are
 * deliberately excluded — they belong to explicit location periods, not to the
 * current home. Returns null when no home has been set.
 */
export function defaultBackfillRange(
  homeSince: Date | null,
  today: Date = new Date(),
): { startDate: string; endDate: string } | null {
  if (!homeSince) return null;
  return { startDate: utcDayKey(homeSince), endDate: utcDayKey(today) };
}

/** A location-keyed group of days (one upstream fetch per group). */
function groupKey(loc: ResolvedLocation): string {
  return `${loc.lat},${loc.lon},${loc.source},${loc.label}`;
}

export interface FetchAndStoreResult {
  /** Days that resolved to a location and were upserted. */
  stored: number;
  /** Days skipped because no location resolved (no home, no override). */
  skipped: number;
  /** Distinct upstream fetches made. */
  fetches: number;
  /**
   * True when the instance-wide request budget refused a request, so some
   * days were left for the next run.
   */
  budgetBlocked: boolean;
}

/** The user columns every environment read resolves the home from. */
const HOME_SELECT = {
  homeLat: true,
  homeLon: true,
  homeLabel: true,
  homeLocationEncrypted: true,
  homeTimezone: true,
  homeSince: true,
  timezone: true,
  environmentAirQualityEnabled: true,
} as const;

/**
 * The account's home as the resolver uses it: the sealed copy opened, or the
 * readable columns for a row the encryption backfill has not reached. Null
 * when no home is set (or the sealed value does not open).
 */
export function resolveHome(user: {
  homeLat: number | null;
  homeLon: number | null;
  homeLabel: string | null;
  homeLocationEncrypted: Uint8Array | null;
  homeTimezone: string | null;
  homeSince: Date | null;
  timezone: string;
}): HomeLocation | null {
  const location = readLocation({
    sealed: user.homeLocationEncrypted,
    lat: user.homeLat,
    lon: user.homeLon,
    label: user.homeLabel ?? "",
  });
  if (!location) return null;
  return {
    ...location,
    // A home stored without a label (allowed since v1.25) carries an empty
    // one; the stored day says "Home", as it always has.
    label: location.label === "" ? "Home" : location.label,
    timezone: user.homeTimezone ?? user.timezone,
    // Effective-from day-key; null ⇒ home resolves no day (conservative).
    since: user.homeSince ? utcDayKey(user.homeSince) : null,
  };
}

/** Every dated location period of an account, opened. */
async function readTravelOverrides(userId: string): Promise<TravelOverride[]> {
  const records = await prisma.environmentTravelLocation.findMany({
    where: { userId },
    select: {
      startDate: true,
      endDate: true,
      lat: true,
      lon: true,
      label: true,
      locationEncrypted: true,
    },
  });
  return records.flatMap((row) => {
    const location = readLocation({
      sealed: row.locationEncrypted,
      lat: row.lat,
      lon: row.lon,
      label: row.label,
    });
    return location
      ? [{ startDate: row.startDate, endDate: row.endDate, ...location }]
      : [];
  });
}

/**
 * Resolve + fetch + upsert the environment rows for a user across a date range.
 * Groups days by resolved location so each location is fetched once over its
 * contiguous span. A day whose observation is absent from the feed is left
 * un-stored (no fabricated row). Idempotent — re-running upserts the same rows.
 */
export async function fetchAndStoreEnvironment(args: {
  userId: string;
  startDate: string;
  endDate: string;
}): Promise<FetchAndStoreResult> {
  const { userId, startDate, endDate } = args;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: HOME_SELECT,
  });
  if (!user) {
    return { stored: 0, skipped: 0, fetches: 0, budgetBlocked: false };
  }

  const home = resolveHome(user);
  const travelRows = await readTravelOverrides(userId);
  const airQuality = isAirQualityActive(user.environmentAirQualityEnabled);

  // The timezone used to enumerate AND fetch days — one tz keeps the stored
  // `date` consistent with the user's day-keys elsewhere.
  const timezone = home?.timezone ?? user.timezone;

  const days = enumerateDays(startDate, endDate);
  const groups = new Map<string, { loc: ResolvedLocation; days: string[] }>();
  let skipped = 0;
  for (const day of days) {
    const loc = resolveLocationForDay(day, home, travelRows);
    if (!loc) {
      skipped += 1;
      continue;
    }
    const gk = groupKey(loc);
    const group = groups.get(gk) ?? { loc, days: [] };
    group.days.push(day);
    groups.set(gk, group);
  }

  let stored = 0;
  let fetches = 0;
  let budgetBlocked = false;
  for (const { loc, days: groupDays } of groups.values()) {
    const min = groupDays[0];
    const max = groupDays[groupDays.length - 1];
    let observations: DailyEnvironmentObservation[];
    try {
      observations = await fetchDailyEnvironment({
        lat: loc.lat,
        lon: loc.lon,
        timezone,
        startDate: min,
        endDate: max,
      });
    } catch (err) {
      if (err instanceof OpenMeteoBudgetExhaustedError) {
        // Nothing was sent. The remaining groups wait for the next run.
        budgetBlocked = true;
        break;
      }
      // A failed fetch for one location leaves its days un-stored; the nightly
      // lookback re-attempts them. Other locations still get their rows.
      continue;
    }
    fetches += 1;

    // The air-quality part of the same days, at the same coarse location. A
    // stop (budget or feed error) leaves the days it did not reach without
    // air quality; the weather is stored regardless.
    let airByDay: Map<string, DailyAirQualityObservation> | null = null;
    if (airQuality) {
      const result = await fetchDailyAirQuality({
        lat: loc.lat,
        lon: loc.lon,
        timezone,
        startDate: min,
        endDate: max,
      });
      if (result.stopped === "budget") budgetBlocked = true;
      airByDay = new Map(result.days.map((d) => [d.date, d]));
      fetches += result.days.length > 0 ? 1 : 0;
    }

    const wanted = new Set(groupDays);
    const sealed = sealLocation(loc);
    const now = new Date();
    // Batch the group's day upserts into a single transaction round-trip
    // rather than awaiting one upsert per day in series (a 730-day backfill
    // would otherwise issue 730 sequential statements). One transaction per
    // location group keeps the per-backfill DB chatter bounded while
    // preserving the idempotent upsert semantics.
    const ops = observations
      .filter((obs) => wanted.has(obs.date))
      .map((obs) =>
        buildUpsert(userId, loc, sealed, obs, {
          active: airQuality,
          day: airByDay?.get(obs.date) ?? null,
          now,
        }),
      );
    if (ops.length > 0) {
      await prisma.$transaction(ops);
      stored += ops.length;
    }
    // Days the feed did not return (e.g. beyond the settling lag) stay absent.
    if (budgetBlocked) break;
  }

  return { stored, skipped, fetches, budgetBlocked };
}

/** The air-quality columns of a stored day, from one observation. */
function airQualityColumns(day: DailyAirQualityObservation, fetchedAt: Date) {
  return {
    pm25Mean: day.pm25Mean,
    pm25Max: day.pm25Max,
    pm10Mean: day.pm10Mean,
    no2Mean: day.no2Mean,
    so2Mean: day.so2Mean,
    coMean: day.coMean,
    o3Max8h: day.o3Max8h,
    eaqiMax: day.eaqiMax,
    usaqiMax: day.usaqiMax,
    uvIndexMax: day.uvIndexMax,
    dustMax: day.dustMax,
    aodMax: day.aodMax,
    pollenAlderMax: day.pollenAlderMax,
    pollenBirchMax: day.pollenBirchMax,
    pollenGrassMax: day.pollenGrassMax,
    pollenMugwortMax: day.pollenMugwortMax,
    pollenOliveMax: day.pollenOliveMax,
    pollenRagweedMax: day.pollenRagweedMax,
    aqDomain: day.aqDomain,
    aqHours: day.aqHours,
    aqFetchedAt: fetchedAt,
  };
}

/** The air-quality columns of a day whose air quality is not (yet) known. */
const AIR_QUALITY_UNFETCHED = {
  pm25Mean: null,
  pm25Max: null,
  pm10Mean: null,
  no2Mean: null,
  so2Mean: null,
  coMean: null,
  o3Max8h: null,
  eaqiMax: null,
  usaqiMax: null,
  uvIndexMax: null,
  dustMax: null,
  aodMax: null,
  pollenAlderMax: null,
  pollenBirchMax: null,
  pollenGrassMax: null,
  pollenMugwortMax: null,
  pollenOliveMax: null,
  pollenRagweedMax: null,
  aqDomain: null,
  aqHours: null,
  aqFetchedAt: null,
} as const;

/** Build the idempotent per-day upsert operation (un-awaited, for a batch). */
function buildUpsert(
  userId: string,
  loc: ResolvedLocation,
  sealed: Uint8Array<ArrayBuffer>,
  obs: DailyEnvironmentObservation,
  air: {
    active: boolean;
    day: DailyAirQualityObservation | null;
    now: Date;
  },
) {
  // With air quality on, the row's air-quality part is rewritten with the
  // weather: the fetched values, or nothing at all when the fetch did not
  // reach the day, so a value measured for the location the day resolved to
  // before can never stand beside the weather of the one it resolves to now.
  // With it off, the stored part is left as it is.
  const airColumns = !air.active
    ? {}
    : air.day
      ? airQualityColumns(air.day, air.now)
      : AIR_QUALITY_UNFETCHED;
  const data = {
    // The coarse location rides sealed only; the readable columns are
    // written empty (they drop in a later release).
    locationEncrypted: sealed,
    lat: null,
    lon: null,
    locationLabel: null,
    source: loc.source,
    tempMin: obs.tempMin,
    tempMax: obs.tempMax,
    tempMean: obs.tempMean,
    apparentMean: obs.apparentMean,
    apparentMax: obs.apparentMax,
    sunshineSec: obs.sunshineSec != null ? Math.round(obs.sunshineSec) : null,
    daylightSec: obs.daylightSec != null ? Math.round(obs.daylightSec) : null,
    precipSum: obs.precipSum,
    pressureMean: obs.pressureMean,
    pressureDelta: obs.pressureDelta,
    humidityMean: obs.humidityMean,
    cloudMean: obs.cloudMean,
    weatherCode: obs.weatherCode,
    fetchedAt: air.now,
    ...airColumns,
  };
  return prisma.environmentContext.upsert({
    where: { userId_date: { userId, date: obs.date } },
    create: { userId, date: obs.date, ...data },
    update: data,
  });
}

/** Days per gap-fill run: about 11 weighted calls per account per night. */
export const AIR_QUALITY_GAP_FILL_DAYS = 90;
/** Two gap days further apart than this are fetched as separate ranges. */
const GAP_RANGE_JOIN_DAYS = 7;

export interface AirQualityGapFillResult {
  /** Stored days whose air-quality part was filled (or marked uncoverable). */
  filled: number;
  /** Why the run stopped early, or null. */
  stopped: AirQualityStop;
}

/**
 * The nightly gap fill: up to {@link AIR_QUALITY_GAP_FILL_DAYS} stored days
 * of an account whose air-quality part was never fetched (`aqFetchedAt`
 * null), newest first, so the correlation window fills first and an account
 * with two years of weather catches up within about nine nights. Each day is
 * fetched at the location it was stored for (opened from its sealed copy),
 * never re-resolved. A day the feed cannot serve (before 2013) is marked
 * fetched with every value null, so it is not asked for again. A no-op when
 * the air-quality part is off for the account or the instance.
 */
export async function fillAirQualityGaps(
  userId: string,
  maxDays: number = AIR_QUALITY_GAP_FILL_DAYS,
): Promise<AirQualityGapFillResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: HOME_SELECT,
  });
  if (!user || !isAirQualityActive(user.environmentAirQualityEnabled)) {
    return { filled: 0, stopped: null };
  }
  const timezone = user.homeTimezone ?? user.timezone;

  const rows = await prisma.environmentContext.findMany({
    where: { userId, aqFetchedAt: null },
    orderBy: { date: "desc" },
    take: maxDays,
    select: {
      date: true,
      lat: true,
      lon: true,
      locationLabel: true,
      locationEncrypted: true,
    },
  });

  // Group the days by location, then cut each group into ranges of nearby
  // days, so a sparse group does not fetch the empty stretch between.
  const byLocation = new Map<
    string,
    { lat: number; lon: number; days: string[] }
  >();
  for (const row of rows) {
    const location = readLocation({
      sealed: row.locationEncrypted,
      lat: row.lat,
      lon: row.lon,
      label: row.locationLabel,
    });
    if (!location) continue;
    const key = `${location.lat},${location.lon}`;
    const group = byLocation.get(key) ?? {
      lat: location.lat,
      lon: location.lon,
      days: [],
    };
    group.days.push(row.date);
    byLocation.set(key, group);
  }

  let filled = 0;
  for (const group of byLocation.values()) {
    for (const range of nearbyRanges(group.days)) {
      const result = await fetchDailyAirQuality({
        lat: group.lat,
        lon: group.lon,
        timezone,
        startDate: range[0],
        endDate: range[range.length - 1],
      });
      const wanted = new Set(range);
      const now = new Date();
      const ops = result.days
        .filter((day) => wanted.has(day.date))
        .map((day) =>
          prisma.environmentContext.updateMany({
            // Still unfetched, so a weather rewrite that landed meanwhile
            // (with its own air quality) is not overwritten.
            where: { userId, date: day.date, aqFetchedAt: null },
            data: airQualityColumns(day, now),
          }),
        );
      if (ops.length > 0) {
        const done = await prisma.$transaction(ops);
        filled += done.reduce((sum, r) => sum + r.count, 0);
      }
      if (result.stopped) return { filled, stopped: result.stopped };
    }
  }
  return { filled, stopped: null };
}

/** Sorted runs of day keys, a new run wherever two days lie far apart. */
export function nearbyRanges(days: readonly string[]): string[][] {
  const sorted = [...new Set(days)].sort();
  const ranges: string[][] = [];
  for (const day of sorted) {
    const current = ranges[ranges.length - 1];
    if (
      current &&
      shiftDateKey(current[current.length - 1], GAP_RANGE_JOIN_DAYS) >= day
    ) {
      current.push(day);
    } else {
      ranges.push([day]);
    }
  }
  return ranges;
}
