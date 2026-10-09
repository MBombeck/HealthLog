/**
 * v1.42 (#615) — Open-Meteo air-quality client: particles, gases, the two
 * air-quality indices, UV, Saharan dust, aerosol depth and six pollen kinds
 * per local day, from the CAMS models.
 *
 * ## The request
 *
 * `GET /v1/air-quality` with the 17 hourly variables below, the coarse
 * coordinates (one decimal, the module's privacy floor), the day range and the
 * same timezone the weather archive is asked in, so a stored day means the
 * same local day for both. `domains=auto` is required: CAMS Europe (0.1°,
 * about 11 km) alone never returns UV or aerosol depth, CAMS global (0.4°,
 * about 45 km) alone never returns pollen; `auto` takes each variable from the
 * model that has it. The feed has no daily aggregates (asking for one is an
 * error), so it is read hourly and folded into days here.
 *
 * Egress goes through `safeFetch` like the archive client, without
 * `requirePublicHost`: the base URL is operator configuration
 * (`OPENMETEO_AIR_QUALITY_URL`), and an operator may point it at a
 * self-hosted Open-Meteo on a private host. `ENVIRONMENT_AIR_QUALITY_DISABLED`
 * turns the whole feed off for the instance; nothing is sent then.
 *
 * ## Coverage, and why a missing value is null and never zero
 *
 * What the feed serves (open-meteo.com/en/docs/air-quality-api, checked
 * against the live API in v1.42): inside Europe the CAMS European reanalysis
 * reaches back to 2013-01-01 and the forecast takes over from October 2023;
 * outside Europe only CAMS global exists, from 2022-08-01. Pollen is Europe
 * only and present from 2021 (in season); UV and aerosol depth come from CAMS
 * global, so from 2022-08-01. A value the feed did not cover is stored as
 * null. The variables asked for follow the era of a chunk's last day
 * ({@link variablesForChunk}): the eight pollutant and index variables before
 * {@link AIR_QUALITY_POLLEN_FROM}, plus pollen and dust until
 * {@link AIR_QUALITY_GLOBAL_FROM}, everything after, which keeps the
 * request weight down where the extra variables would come back empty. A day
 * before the first day the feed serves at the location
 * ({@link earliestAirQualityDay}) is not requested at all and is returned as
 * uncoverable (every value null, no hours), so nobody asks for it again.
 *
 * ## Daily rules (a local day of hourly values)
 *
 *   - PM2.5, PM10, NO2, SO2, CO: the mean, only when at least 18 of the day's
 *     hours have a value (the 75 % completeness rule air-quality reporting
 *     uses); PM2.5 also its hourly maximum under the same rule (smoke shows in
 *     the peak, not the mean).
 *   - Ozone: the highest 8-hour running mean whose window lies inside the day
 *     (windows starting 00:00 to 16:00, 17 of them), a window counting when 6
 *     of its 8 hours have a value; the day only when at least 13 windows
 *     count. A simplified form of the EU 8-hour ozone metric.
 *   - European and US AQI, dust, aerosol depth, each pollen kind: the day's
 *     maximum, under the 18-hour rule.
 *   - UV index: the day's maximum, only when 10:00 to 16:00 are all present,
 *     because a UV maximum with the midday hours missing is not a maximum.
 *   - `aqHours`: the number of hours with a PM2.5 value, the day's coverage.
 *   - `aqDomain`: `cams_europe` when the coordinates lie inside the CAMS
 *     Europe domain (30–72° N, 25° W–45° E), else `cams_global`. The response
 *     does not say which model `auto` used; the domain box is what decides it.
 *
 * ## Attribution
 *
 * CAMS data is free to use with the notice "Contains modified Copernicus
 * Atmosphere Monitoring Service information" (modified, because hourly
 * values are folded into days here), and Open-Meteo's terms ask for credit
 * (CC BY 4.0). Both lines come from `airQualityAttributionLines` in the
 * contract module and are shown wherever the values are.
 */
import { envFlag, envOr } from "@/lib/env";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { shiftDateKey } from "@/lib/tz/format";
import type { AirQualityDay } from "@/lib/environment/air-quality-contract";
import { enumerateDayCount } from "@/lib/environment/day-span";
import {
  openMeteoCallWeight,
  reserveOpenMeteoCalls,
  type BudgetCeiling,
} from "@/lib/environment/request-budget";

/** Hosted default; override with `OPENMETEO_AIR_QUALITY_URL` (self-host). */
const AIR_QUALITY_BASE_URL = envOr(
  "OPENMETEO_AIR_QUALITY_URL",
  "https://air-quality-api.open-meteo.com",
).replace(/\/$/, "");

const FETCH_TIMEOUT_MS = 15_000;

/** True when the operator turned the air-quality feed off for the instance. */
export function isAirQualityOperatorDisabled(): boolean {
  return envFlag("ENVIRONMENT_AIR_QUALITY_DISABLED");
}

/**
 * Whether the air-quality part runs for an account: the operator has not
 * turned it off for the instance and the account has not turned it off
 * (`User.environmentAirQualityEnabled`).
 */
export function isAirQualityActive(accountEnabled: boolean): boolean {
  return accountEnabled && !isAirQualityOperatorDisabled();
}

/** The first day the feed serves (the CAMS European reanalysis). */
export const AIR_QUALITY_EARLIEST_DAY = "2013-01-01";
/**
 * The first day CAMS global serves, the only model outside Europe, and so the
 * first day with every variable (UV and aerosol depth come from it).
 */
export const AIR_QUALITY_GLOBAL_FROM = "2022-08-01";
/** From here the European feed carries pollen (and dust). */
export const AIR_QUALITY_POLLEN_FROM = "2021-01-01";
/** Days per request: bounds the response (about 300 KB) and the heap. */
export const AIR_QUALITY_CHUNK_DAYS = 90;

/** The eight pollutant and index variables, served from 2013. */
const POLLUTANT_VARIABLES = [
  "pm2_5",
  "pm10",
  "ozone",
  "nitrogen_dioxide",
  "sulphur_dioxide",
  "carbon_monoxide",
  "european_aqi",
  "us_aqi",
] as const;

/** The seven variables the European feed fills from 2021. */
const POLLEN_ERA_VARIABLES = [
  "dust",
  "alder_pollen",
  "birch_pollen",
  "grass_pollen",
  "mugwort_pollen",
  "olive_pollen",
  "ragweed_pollen",
] as const;

/** The two variables that come from CAMS global, so from August 2022. */
const GLOBAL_ERA_VARIABLES = ["uv_index", "aerosol_optical_depth"] as const;

type HourlyVariable =
  | (typeof POLLUTANT_VARIABLES)[number]
  | (typeof POLLEN_ERA_VARIABLES)[number]
  | (typeof GLOBAL_ERA_VARIABLES)[number];

const POLLEN_ERA_REQUEST: readonly HourlyVariable[] = [
  ...POLLUTANT_VARIABLES,
  ...POLLEN_ERA_VARIABLES,
];

/** All 17 hourly variables, in request order. */
export const AIR_QUALITY_VARIABLES: readonly HourlyVariable[] = [
  ...POLLEN_ERA_REQUEST,
  ...GLOBAL_ERA_VARIABLES,
];

/** One stored day's air-quality part, as the feed produced it. */
export type DailyAirQualityObservation = { date: string } & Omit<
  AirQualityDay,
  "apparentMax" | "aqFetchedAt"
>;

/** The hourly block of a response: local ISO times and one array per variable. */
export type AirQualityHourly = { time?: string[] } & Partial<
  Record<HourlyVariable, (number | null)[]>
>;

/** Hours a day needs for a mean or a maximum (75 % of 24). */
const MIN_HOURS = 18;
/** Valid hours an 8-hour ozone window needs. */
const MIN_O3_WINDOW_HOURS = 6;
/** Valid 8-hour windows (of 17) an ozone day needs. */
const MIN_O3_WINDOWS = 13;
/** Local hours whose values a UV maximum needs. */
const UV_MIDDAY_HOURS = [10, 11, 12, 13, 14, 15, 16];

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function present(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

/** Mean when the day is covered, else null. Rounded to 0.1. */
export function coveredMean(values: readonly (number | null)[]): number | null {
  const xs = present(values);
  if (xs.length < MIN_HOURS) return null;
  return round1(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/** Maximum when the day is covered, else null. */
export function coveredMax(values: readonly (number | null)[]): number | null {
  const xs = present(values);
  if (xs.length < MIN_HOURS) return null;
  return Math.max(...xs);
}

/**
 * Highest 8-hour running mean of the day, from values indexed by local hour
 * (0–23, a missing hour null). Null when fewer than 13 of the 17 windows have
 * 6 of their 8 hours.
 */
export function ozoneMax8h(byHour: readonly (number | null)[]): number | null {
  let best: number | null = null;
  let validWindows = 0;
  for (let start = 0; start <= 16; start += 1) {
    const window = present(byHour.slice(start, start + 8));
    if (window.length < MIN_O3_WINDOW_HOURS) continue;
    validWindows += 1;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    if (best === null || mean > best) best = mean;
  }
  if (validWindows < MIN_O3_WINDOWS || best === null) return null;
  return round1(best);
}

/** The day's UV maximum when the midday hours are all present, else null. */
export function uvIndexMax(byHour: readonly (number | null)[]): number | null {
  if (UV_MIDDAY_HOURS.some((h) => byHour[h] == null)) return null;
  const xs = present(byHour);
  return xs.length === 0 ? null : Math.max(...xs);
}

/** Whether a coarse location lies inside the CAMS Europe model domain. */
export function insideCamsEurope(lat: number, lon: number): boolean {
  return lat >= 30 && lat <= 72 && lon >= -25 && lon <= 45;
}

/**
 * The first day the feed has air quality for at a coarse location: 2013
 * inside the CAMS Europe domain, August 2022 (CAMS global) outside it.
 */
export function earliestAirQualityDay(lat: number, lon: number): string {
  return insideCamsEurope(lat, lon)
    ? AIR_QUALITY_EARLIEST_DAY
    : AIR_QUALITY_GLOBAL_FROM;
}

/**
 * Fold an hourly response into one observation per local day present in it.
 * Pure; exported for tests. Times are the feed's local `YYYY-MM-DDTHH:MM`;
 * a repeated hour (the autumn clock change) keeps its first value.
 */
export function aggregateAirQuality(
  hourly: AirQualityHourly,
  location: { lat: number; lon: number },
): DailyAirQualityObservation[] {
  const times = hourly.time ?? [];
  // day → variable → value per local hour (24 slots, null when absent).
  const byDay = new Map<string, Map<HourlyVariable, (number | null)[]>>();
  for (let i = 0; i < times.length; i += 1) {
    const stamp = times[i];
    if (typeof stamp !== "string" || stamp.length < 13) continue;
    const day = stamp.slice(0, 10);
    const hour = Number(stamp.slice(11, 13));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    let vars = byDay.get(day);
    if (!vars) {
      vars = new Map();
      byDay.set(day, vars);
    }
    for (const variable of AIR_QUALITY_VARIABLES) {
      let slots = vars.get(variable);
      if (!slots) {
        slots = new Array<number | null>(24).fill(null);
        vars.set(variable, slots);
      }
      if (slots[hour] === null) {
        slots[hour] = finite(hourly[variable]?.[i]);
      }
    }
  }

  const domain = insideCamsEurope(location.lat, location.lon)
    ? "cams_europe"
    : "cams_global";
  const out: DailyAirQualityObservation[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const vars = byDay.get(day)!;
    const v = (name: HourlyVariable) =>
      vars.get(name) ?? new Array<number | null>(24).fill(null);
    const pm25 = v("pm2_5");
    out.push({
      date: day,
      pm25Mean: coveredMean(pm25),
      pm25Max: coveredMax(pm25),
      pm10Mean: coveredMean(v("pm10")),
      no2Mean: coveredMean(v("nitrogen_dioxide")),
      so2Mean: coveredMean(v("sulphur_dioxide")),
      coMean: coveredMean(v("carbon_monoxide")),
      o3Max8h: ozoneMax8h(v("ozone")),
      eaqiMax: coveredMax(v("european_aqi")),
      usaqiMax: coveredMax(v("us_aqi")),
      uvIndexMax: uvIndexMax(v("uv_index")),
      dustMax: coveredMax(v("dust")),
      aodMax: coveredMax(v("aerosol_optical_depth")),
      pollenAlderMax: coveredMax(v("alder_pollen")),
      pollenBirchMax: coveredMax(v("birch_pollen")),
      pollenGrassMax: coveredMax(v("grass_pollen")),
      pollenMugwortMax: coveredMax(v("mugwort_pollen")),
      pollenOliveMax: coveredMax(v("olive_pollen")),
      pollenRagweedMax: coveredMax(v("ragweed_pollen")),
      aqDomain: domain,
      aqHours: present(pm25).length,
    });
  }
  return out;
}

/** A day the feed cannot serve: every value null, no hours, no domain. */
export function uncoverableDay(date: string): DailyAirQualityObservation {
  return {
    date,
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
    aqHours: 0,
  };
}

/** Split an inclusive day range into chunks of at most `size` days. */
export function chunkDays(
  startDate: string,
  endDate: string,
  size: number = AIR_QUALITY_CHUNK_DAYS,
): Array<{ startDate: string; endDate: string }> {
  const chunks: Array<{ startDate: string; endDate: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const last = shiftDateKey(cursor, size - 1);
    const chunkEnd = last < endDate ? last : endDate;
    chunks.push({ startDate: cursor, endDate: chunkEnd });
    cursor = shiftDateKey(chunkEnd, 1);
  }
  return chunks;
}

/** The variables a chunk asks for, by the era of its last day. */
export function variablesForChunk(endDate: string): readonly HourlyVariable[] {
  if (endDate < AIR_QUALITY_POLLEN_FROM) return POLLUTANT_VARIABLES;
  if (endDate < AIR_QUALITY_GLOBAL_FROM) return POLLEN_ERA_REQUEST;
  return AIR_QUALITY_VARIABLES;
}

/** The request weight of one chunk, in calls (`openMeteoCallWeight`). */
export function airQualityChunkWeight(
  startDate: string,
  endDate: string,
): number {
  return openMeteoCallWeight(
    variablesForChunk(endDate).length,
    enumerateDayCount(startDate, endDate),
  );
}

/** Why a fetch stopped before its last chunk. */
export type AirQualityStop = "budget" | "error" | null;

export interface AirQualityFetchResult {
  /** One observation per day the feed answered (and per uncoverable day). */
  days: DailyAirQualityObservation[];
  /** Null when every chunk was fetched. */
  stopped: AirQualityStop;
}

/**
 * Fetch and fold the air quality for a coarse location over an inclusive day
 * range, newest chunk first, so a run the budget stops part-way has filled
 * the recent days the correlation window reads. Never throws for a feed
 * problem: the caller gets what was fetched and why it stopped, and the days
 * not returned stay unfetched for the next run.
 */
export async function fetchDailyAirQuality(
  args: {
    lat: number;
    lon: number;
    timezone: string;
    startDate: string;
    endDate: string;
  },
  budget: { accountId?: string; ceiling?: BudgetCeiling } = {},
): Promise<AirQualityFetchResult> {
  const days: DailyAirQualityObservation[] = [];
  // Days before the feed's first day at this location are answered here,
  // without a request.
  const earliest = earliestAirQualityDay(args.lat, args.lon);
  for (
    let day = args.startDate;
    day <= args.endDate && day < earliest;
    day = shiftDateKey(day, 1)
  ) {
    days.push(uncoverableDay(day));
  }
  const start = args.startDate < earliest ? earliest : args.startDate;
  if (start > args.endDate) return { days, stopped: null };

  const chunks = chunkDays(start, args.endDate).reverse();
  for (const chunk of chunks) {
    const variables = variablesForChunk(chunk.endDate);
    const weight = airQualityChunkWeight(chunk.startDate, chunk.endDate);
    if (
      !(await reserveOpenMeteoCalls(weight, budget.accountId, budget.ceiling))
    ) {
      return { days, stopped: "budget" };
    }
    try {
      const hourly = await requestHourly({
        lat: args.lat,
        lon: args.lon,
        timezone: args.timezone,
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        variables,
      });
      const wanted = (d: string) => d >= chunk.startDate && d <= chunk.endDate;
      days.push(
        ...aggregateAirQuality(hourly, args).filter((d) => wanted(d.date)),
      );
    } catch {
      // A refused, timed-out or unreadable response: stop here and keep what
      // came back. The weather row is unaffected, and the days not returned
      // stay unfetched for the gap fill.
      return { days, stopped: "error" };
    }
  }
  return { days, stopped: null };
}

async function requestHourly(args: {
  lat: number;
  lon: number;
  timezone: string;
  startDate: string;
  endDate: string;
  variables: readonly HourlyVariable[];
}): Promise<AirQualityHourly> {
  const url = new URL(`${AIR_QUALITY_BASE_URL}/v1/air-quality`);
  url.searchParams.set("latitude", String(args.lat));
  url.searchParams.set("longitude", String(args.lon));
  url.searchParams.set("hourly", args.variables.join(","));
  url.searchParams.set("start_date", args.startDate);
  url.searchParams.set("end_date", args.endDate);
  url.searchParams.set("timezone", args.timezone);
  url.searchParams.set("domains", "auto");

  const res = await safeFetch(
    url,
    { headers: { accept: "application/json" } },
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (!res.ok) {
    throw new SafeFetchError(
      `open-meteo air quality returned HTTP ${res.status}`,
      "network",
    );
  }
  const body = (await res.json()) as { hourly?: AirQualityHourly };
  return body.hourly ?? {};
}
