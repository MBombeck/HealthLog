/**
 * v1.25 (W-ENV) — Open-Meteo client (keyless historical weather + geocoding).
 *
 * The single outbound egress for the environmental-context module. Open-Meteo's
 * Historical (Archive) API is keyless, free for non-commercial use, and offers
 * a clean per-date global lat/lon endpoint — the right fit for a self-host-
 * friendly, privacy-first exposure feed. Data is CC BY 4.0 ("Weather data by
 * Open-Meteo.com" — credited on the settings surface).
 *
 * Egress goes through `safeFetch` (the documented wrapper: manual redirects +
 * a request timeout). The base URL is operator config, not arbitrary user
 * input, so `requirePublicHost` is deliberately NOT forced — a privacy-
 * maximalist operator can point `OPENMETEO_BASE_URL` at a self-hosted Open-Meteo
 * instance on a private/LAN host without it being blocked. The hosted default is
 * public.
 *
 * Server-side only. The archive feed lags real time by a few days (reanalysis
 * settling), so callers fetch with a lookback window rather than "yesterday
 * only" — see the nightly job and the backfill route.
 */
import { envOr } from "@/lib/env";
import { annotate } from "@/lib/logging/context";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { enumerateDayCount } from "@/lib/environment/day-span";
import {
  OpenMeteoBudgetExhaustedError,
  openMeteoCallWeight,
  reserveOpenMeteoCalls,
} from "@/lib/environment/request-budget";

/** Hosted archive default; override with `OPENMETEO_BASE_URL` (self-host). */
const ARCHIVE_BASE_URL = envOr(
  "OPENMETEO_BASE_URL",
  "https://archive-api.open-meteo.com",
).replace(/\/$/, "");

/** Hosted geocoding default; override with `OPENMETEO_GEOCODING_URL`. */
const GEOCODING_BASE_URL = envOr(
  "OPENMETEO_GEOCODING_URL",
  "https://geocoding-api.open-meteo.com",
).replace(/\/$/, "");

const FETCH_TIMEOUT_MS = 15_000;

/** CC BY 4.0 attribution required by Open-Meteo; surfaced on the settings UI. */
export const OPEN_METEO_ATTRIBUTION = "Weather data by Open-Meteo.com";

/** One geocoding match — coarse city placement for the home-location picker. */
export interface GeocodeResult {
  /** Rounded coarse latitude (1 dp, about 11 km, the privacy floor). */
  lat: number;
  /** Rounded coarse longitude (2 dp). */
  lon: number;
  /** Human label, e.g. "Bochum, North Rhine-Westphalia, Germany". */
  label: string;
  /** IANA timezone for the place (anchors the day-key of stored rows). */
  timezone: string;
}

/** A single day's resolved weather observation, mapped to our column shape. */
export interface DailyEnvironmentObservation {
  /** YYYY-MM-DD in the requested timezone. */
  date: string;
  tempMin: number | null;
  tempMax: number | null;
  tempMean: number | null;
  apparentMean: number | null;
  /** v1.42 — daily apparent ("feels-like") maximum, °C. */
  apparentMax: number | null;
  sunshineSec: number | null;
  daylightSec: number | null;
  precipSum: number | null;
  pressureMean: number | null;
  pressureDelta: number | null;
  humidityMean: number | null;
  cloudMean: number | null;
  weatherCode: number | null;
}

/**
 * Round a coordinate to 1 decimal, the coarse-location privacy floor: about
 * 11 km north-south and 7 km east-west at 50° N, the size of a town or a
 * city district rather than a street. The weather reanalysis behind the
 * archive is gridded at 9 to 25 km, so a finer value buys no better weather.
 * Every stored coordinate of this module goes through here (v1.39.4; it was
 * 2 decimals, about 1 km, before).
 */
export function roundCoarse(value: number): number {
  return Math.round(value * 10) / 10;
}

function firstNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Mean of the finite numbers in `xs`, or null when none. */
function meanOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sum = xs.reduce((a, b) => a + b, 0);
  return sum / xs.length;
}

interface ArchiveDaily {
  time?: string[];
  temperature_2m_min?: (number | null)[];
  temperature_2m_max?: (number | null)[];
  temperature_2m_mean?: (number | null)[];
  apparent_temperature_mean?: (number | null)[];
  apparent_temperature_max?: (number | null)[];
  sunshine_duration?: (number | null)[];
  daylight_duration?: (number | null)[];
  precipitation_sum?: (number | null)[];
  weather_code?: (number | null)[];
}

interface ArchiveHourly {
  time?: string[];
  surface_pressure?: (number | null)[];
  relative_humidity_2m?: (number | null)[];
  cloud_cover?: (number | null)[];
}

interface ArchiveResponse {
  daily?: ArchiveDaily;
  hourly?: ArchiveHourly;
}

const DAILY_FIELD_LIST = [
  "temperature_2m_min",
  "temperature_2m_max",
  "temperature_2m_mean",
  "apparent_temperature_mean",
  "apparent_temperature_max",
  "sunshine_duration",
  "daylight_duration",
  "precipitation_sum",
  "weather_code",
];
const DAILY_FIELDS = DAILY_FIELD_LIST.join(",");

const HOURLY_FIELD_LIST = [
  "surface_pressure",
  "relative_humidity_2m",
  "cloud_cover",
];
const HOURLY_FIELDS = HOURLY_FIELD_LIST.join(",");

/** Variables one archive request asks for, for the request budget. */
const ARCHIVE_VARIABLE_COUNT =
  DAILY_FIELD_LIST.length + HOURLY_FIELD_LIST.length;

/** Per-day aggregation accumulator for the hourly-only fields. */
interface HourlyDayAgg {
  pressures: number[];
  humidities: number[];
  clouds: number[];
}

/**
 * Aggregate the hourly feed (pressure / humidity / cloud — not available as a
 * daily aggregate from the archive) into per-day values: mean for each, plus the
 * intraday pressure delta (max − min), the derived headache/symptom feature.
 */
function aggregateHourly(hourly: ArchiveHourly): Map<string, HourlyDayAgg> {
  const byDay = new Map<string, HourlyDayAgg>();
  const times = hourly.time ?? [];
  for (let i = 0; i < times.length; i++) {
    const day = times[i]?.slice(0, 10);
    if (!day) continue;
    const agg = byDay.get(day) ?? { pressures: [], humidities: [], clouds: [] };
    const p = firstNumber(hourly.surface_pressure?.[i]);
    const h = firstNumber(hourly.relative_humidity_2m?.[i]);
    const c = firstNumber(hourly.cloud_cover?.[i]);
    if (p !== null) agg.pressures.push(p);
    if (h !== null) agg.humidities.push(h);
    if (c !== null) agg.clouds.push(c);
    byDay.set(day, agg);
  }
  return byDay;
}

/**
 * Forward-geocode a free-text place to coarse matches. Keyless. Returns at most
 * `count` results; an empty array when nothing matched or the feed errored
 * (the caller surfaces "no match" rather than failing the request).
 */
export async function geocodeLocation(
  query: string,
  count = 5,
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // A geocoder call weighs one; a refused one answers "no match" rather than
  // reaching the host, and says why on the request's event.
  if (!(await reserveOpenMeteoCalls(1))) {
    annotate({ action: { name: "environment.geocode.budget_exhausted" } });
    return [];
  }

  const url = new URL(`${GEOCODING_BASE_URL}/v1/search`);
  url.searchParams.set("name", trimmed);
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 10)));
  url.searchParams.set("format", "json");

  let res: Response;
  try {
    res = await safeFetch(
      url,
      { headers: { accept: "application/json" } },
      {
        timeoutMs: FETCH_TIMEOUT_MS,
      },
    );
  } catch (err) {
    if (err instanceof SafeFetchError) return [];
    throw err;
  }
  if (!res.ok) return [];

  const body = (await res.json()) as {
    results?: Array<{
      name?: string;
      latitude?: number;
      longitude?: number;
      country?: string;
      admin1?: string;
      timezone?: string;
    }>;
  };

  const out: GeocodeResult[] = [];
  for (const r of body.results ?? []) {
    if (typeof r.latitude !== "number" || typeof r.longitude !== "number") {
      continue;
    }
    const parts = [r.name, r.admin1, r.country].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    out.push({
      lat: roundCoarse(r.latitude),
      lon: roundCoarse(r.longitude),
      label: parts.join(", "),
      timezone:
        typeof r.timezone === "string" && r.timezone.length > 0
          ? r.timezone
          : "auto",
    });
  }
  return out;
}

/**
 * Fetch the daily environment observations for a coarse location over a date
 * range (inclusive YYYY-MM-DD). The hourly-only fields (pressure / humidity /
 * cloud) are requested alongside and aggregated to per-day values here. Throws
 * a {@link SafeFetchError} on egress failure so the caller can classify it,
 * and an {@link OpenMeteoBudgetExhaustedError} when the instance-wide request
 * budget, or the account's share of it (`budget.accountId`), refuses the call
 * (nothing is sent then). The account never reaches the request.
 */
export async function fetchDailyEnvironment(
  args: {
    lat: number;
    lon: number;
    timezone: string;
    startDate: string;
    endDate: string;
  },
  budget: { accountId?: string } = {},
): Promise<DailyEnvironmentObservation[]> {
  const weight = openMeteoCallWeight(
    ARCHIVE_VARIABLE_COUNT,
    enumerateDayCount(args.startDate, args.endDate),
  );
  if (!(await reserveOpenMeteoCalls(weight, budget.accountId))) {
    throw new OpenMeteoBudgetExhaustedError();
  }
  const url = new URL(`${ARCHIVE_BASE_URL}/v1/archive`);
  url.searchParams.set("latitude", String(args.lat));
  url.searchParams.set("longitude", String(args.lon));
  url.searchParams.set("start_date", args.startDate);
  url.searchParams.set("end_date", args.endDate);
  url.searchParams.set("daily", DAILY_FIELDS);
  url.searchParams.set("hourly", HOURLY_FIELDS);
  url.searchParams.set("timezone", args.timezone);

  const res = await safeFetch(
    url,
    { headers: { accept: "application/json" } },
    {
      timeoutMs: FETCH_TIMEOUT_MS,
    },
  );
  if (!res.ok) {
    throw new SafeFetchError(
      `open-meteo archive returned HTTP ${res.status}`,
      "network",
    );
  }

  const body = (await res.json()) as ArchiveResponse;
  const daily = body.daily ?? {};
  const days = daily.time ?? [];
  const hourlyByDay = aggregateHourly(body.hourly ?? {});

  const observations: DailyEnvironmentObservation[] = [];
  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    if (!date) continue;
    const agg = hourlyByDay.get(date);
    const pressures = agg?.pressures ?? [];
    const pressureMean = meanOf(pressures);
    const pressureDelta =
      pressures.length > 0
        ? Math.max(...pressures) - Math.min(...pressures)
        : null;

    observations.push({
      date,
      tempMin: firstNumber(daily.temperature_2m_min?.[i]),
      tempMax: firstNumber(daily.temperature_2m_max?.[i]),
      tempMean: firstNumber(daily.temperature_2m_mean?.[i]),
      apparentMean: firstNumber(daily.apparent_temperature_mean?.[i]),
      apparentMax: firstNumber(daily.apparent_temperature_max?.[i]),
      sunshineSec: firstNumber(daily.sunshine_duration?.[i]),
      daylightSec: firstNumber(daily.daylight_duration?.[i]),
      precipSum: firstNumber(daily.precipitation_sum?.[i]),
      pressureMean,
      pressureDelta:
        pressureDelta !== null ? Math.round(pressureDelta * 10) / 10 : null,
      humidityMean: meanOf(agg?.humidities ?? []),
      cloudMean: meanOf(agg?.clouds ?? []),
      weatherCode: firstNumber(daily.weather_code?.[i]),
    });
  }
  return observations;
}
