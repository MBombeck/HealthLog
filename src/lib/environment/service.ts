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
 */
import { prisma } from "@/lib/db";
import {
  fetchDailyEnvironment,
  roundCoarse,
  type DailyEnvironmentObservation,
} from "@/lib/environment/open-meteo";
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
    select: {
      homeLat: true,
      homeLon: true,
      homeLabel: true,
      homeTimezone: true,
      homeSince: true,
      timezone: true,
    },
  });
  if (!user) return { stored: 0, skipped: 0, fetches: 0 };

  const home: HomeLocation | null =
    user.homeLat != null && user.homeLon != null
      ? {
          lat: user.homeLat,
          lon: user.homeLon,
          label: user.homeLabel ?? "Home",
          timezone: user.homeTimezone ?? user.timezone,
          // Effective-from day-key; null ⇒ home resolves no day (conservative).
          since: user.homeSince ? utcDayKey(user.homeSince) : null,
        }
      : null;

  const travelRecords = await prisma.environmentTravelLocation.findMany({
    where: { userId },
    select: {
      startDate: true,
      endDate: true,
      lat: true,
      lon: true,
      label: true,
    },
  });

  // Since v1.42 the plaintext location is nullable (migration 0382): a period
  // whose plaintext the encryption backfill has already cleared resolves only
  // through its sealed copy, which this reader does not open yet.
  const travelRows: TravelOverride[] = travelRecords.flatMap((row) =>
    row.lat != null && row.lon != null && row.label != null
      ? [{ ...row, lat: row.lat, lon: row.lon, label: row.label }]
      : [],
  );

  // The timezone used to enumerate AND fetch days — one tz keeps the stored
  // `date` consistent with the user's day-keys elsewhere.
  const timezone = home?.timezone ?? user.timezone;

  const days = enumerateDays(startDate, endDate);
  const resolvedByDay = new Map<string, ResolvedLocation>();
  const groups = new Map<string, { loc: ResolvedLocation; days: string[] }>();
  let skipped = 0;
  for (const day of days) {
    const loc = resolveLocationForDay(day, home, travelRows);
    if (!loc) {
      skipped += 1;
      continue;
    }
    resolvedByDay.set(day, loc);
    const gk = groupKey(loc);
    const group = groups.get(gk) ?? { loc, days: [] };
    group.days.push(day);
    groups.set(gk, group);
  }

  let stored = 0;
  let fetches = 0;
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
    } catch {
      // A failed fetch for one location leaves its days un-stored; the nightly
      // lookback re-attempts them. Other locations still get their rows.
      continue;
    }
    fetches += 1;

    const wanted = new Set(groupDays);
    // Batch the group's day upserts into a single transaction round-trip
    // rather than awaiting one upsert per day in series (a 730-day backfill
    // would otherwise issue 730 sequential statements). One transaction per
    // location group keeps the per-backfill DB chatter bounded while
    // preserving the idempotent upsert semantics.
    const ops = observations
      .filter((obs) => wanted.has(obs.date))
      .map((obs) => buildUpsert(userId, loc, obs));
    if (ops.length > 0) {
      await prisma.$transaction(ops);
      stored += ops.length;
    }
    // Days the feed did not return (e.g. beyond the settling lag) stay absent.
  }

  return { stored, skipped, fetches };
}

/** Build the idempotent per-day upsert operation (un-awaited, for a batch). */
function buildUpsert(
  userId: string,
  loc: ResolvedLocation,
  obs: DailyEnvironmentObservation,
) {
  const data = {
    // Already coarse at the source; rounded again so a per-day row never holds
    // more precision than the privacy floor, whatever resolved it.
    lat: roundCoarse(loc.lat),
    lon: roundCoarse(loc.lon),
    locationLabel: loc.label,
    source: loc.source,
    tempMin: obs.tempMin,
    tempMax: obs.tempMax,
    tempMean: obs.tempMean,
    apparentMean: obs.apparentMean,
    sunshineSec: obs.sunshineSec != null ? Math.round(obs.sunshineSec) : null,
    daylightSec: obs.daylightSec != null ? Math.round(obs.daylightSec) : null,
    precipSum: obs.precipSum,
    pressureMean: obs.pressureMean,
    pressureDelta: obs.pressureDelta,
    humidityMean: obs.humidityMean,
    cloudMean: obs.cloudMean,
    weatherCode: obs.weatherCode,
    fetchedAt: new Date(),
  };
  return prisma.environmentContext.upsert({
    where: { userId_date: { userId, date: obs.date } },
    create: { userId, date: obs.date, ...data },
    update: data,
  });
}
