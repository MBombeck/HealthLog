/**
 * v1.42 (#615) — `get_environment`: the weather, air quality, pollen and UV
 * the person's stored days had, for the Coach and for MCP clients.
 *
 * What it never carries: a coordinate or a place name. The stored days hold
 * their coarse location sealed; this read does not open it. The only trace
 * of where a day was is `coverage.awayDays`, the number of days that resolved
 * to a dated location period rather than the home.
 *
 * What it says about itself: the values are modelled outdoor conditions on a
 * 9 to 45 km grid (ERA5 reanalysis for the weather, CAMS for the air), which
 * is not anyone's personal exposure, and every result carries that note and
 * the attribution lines. Null is "the feed did not cover this", never zero.
 *
 * Gates: the `environment` module (off answers `module_disabled` without
 * reading a row), and the air-quality part, off by the account or the
 * operator, which leaves every air-quality field out of the result rather
 * than null-filling it. The window is clamped to the Coach lookback limit
 * like every Coach read.
 */
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";
import {
  isAirQualityActive,
  isAirQualityOperatorDisabled,
} from "@/lib/environment/open-meteo-air-quality";
import { environmentAttributionLines } from "@/lib/environment/air-quality-contract";
import {
  highPollenKinds,
  isHotNight,
  isVeryPoorAir,
  pollenMax,
  type PollenByKind,
} from "@/lib/environment/day-flags";
import { windowToDays } from "@/lib/ai/coach/snapshot-series";
import {
  clampWindow,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import type { CoachScopeWindow } from "@/lib/ai/coach/types";
import { shiftDateKey } from "@/lib/tz/format";

/** Days listed one by one; the summary covers the whole window. */
export const ENVIRONMENT_DAILY_LIMIT = 31;

/** The air-quality fields of one day; only present while the part is on. */
export interface EnvironmentToolAirQuality {
  pm25Mean: number | null;
  pm25Max: number | null;
  pm10Mean: number | null;
  no2Mean: number | null;
  so2Mean: number | null;
  coMean: number | null;
  o3Max8h: number | null;
  eaqiMax: number | null;
  usaqiMax: number | null;
  uvIndexMax: number | null;
  dustMax: number | null;
  aodMax: number | null;
  pollen: PollenByKind;
}

/** One stored day as the tool returns it. No location, ever. */
export interface EnvironmentToolDay {
  date: string;
  tempMin: number | null;
  tempMax: number | null;
  tempMean: number | null;
  apparentMax: number | null;
  precipSum: number | null;
  sunshineHours: number | null;
  pressureMean: number | null;
  pressureDelta: number | null;
  humidityMean: number | null;
  /** Absent while the air-quality part is off; null when not fetched yet. */
  airQuality?: EnvironmentToolAirQuality | null;
}

export type EnvironmentAirQualityState = "on" | "off_account" | "off_operator";

export interface EnvironmentToolData {
  window: CoachScopeWindow;
  coverage: {
    firstDate: string;
    lastDate: string;
    /** Stored days in the window. */
    days: number;
    /** Of those, days spent at a dated location period, not at home. */
    awayDays: number;
    /** Days with air-quality values; absent while the part is off. */
    airQualityDays?: number;
  };
  /** The newest days of the window, oldest first, at most 31. */
  daily: EnvironmentToolDay[];
  summary: {
    /** Nights whose minimum stayed at or above 20 °C. */
    hotNights: number;
    /** Days whose European AQI reached 80 (absent while the part is off). */
    veryPoorAirDays?: number;
    /** Days with a pollen kind at its high mark (absent while off). */
    highPollenDays?: number;
    /** Highest pollen count of the window, grains/m³ (absent while off). */
    pollenPeak?: number | null;
  };
  airQuality: EnvironmentAirQualityState;
  provenance: {
    weather: string;
    airQuality: string;
    note: string;
  };
  attributions: string[];
}

export type EnvironmentToolResult =
  | { present: true; data: EnvironmentToolData }
  | {
      present: false;
      reason: "module_disabled" | "no_data" | "outside_window";
      searchedWindow?: CoachScopeWindow;
      available?: {
        count: number;
        firstDate: string;
        lastDate: string;
        reachableWithWindow: CoachScopeWindow | null;
      };
    };

const PROVENANCE = {
  weather:
    "ERA5 reanalysis via the Open-Meteo archive, on a grid of about 9 to 25 kilometres; recent days settle over a few days",
  airQuality:
    "CAMS air-quality models via Open-Meteo: hourly on a grid of about 11 kilometres in Europe and 45 kilometres elsewhere; pollen only in Europe; pollen, UV and dust only from about mid 2022",
  note: "Modelled outdoor conditions at a coarse location, not the person's own exposure. A pattern beside their data is context, never a cause.",
} as const;

const WINDOWS_NARROWEST_FIRST: readonly CoachScopeWindow[] = [
  "last7days",
  "last30days",
  "last90days",
  "lastYear",
  "allTime",
];

function round1(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10;
}

/** UTC day key of `date`. */
function dayKey(date: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the environment module keys its stored days and window bounds on UTC day keys (see service.ts); a window edge a day either way does not change the read
  return date.toISOString().slice(0, 10);
}

/**
 * Read the stored environment days for the tool. Never throws for "nothing
 * there"; a database error propagates to the executor, which reports
 * `retrieval_failed`.
 */
export async function readEnvironmentForTool(args: {
  userId: string;
  window: CoachScopeWindow;
  reach: CoachHistoryReach;
  now?: Date;
}): Promise<EnvironmentToolResult> {
  const { userId } = args;
  if (!(await isModuleEnabled(userId, "environment"))) {
    return { present: false, reason: "module_disabled" };
  }
  const window = clampWindow(args.window, args.reach);
  const today = dayKey(args.now ?? new Date());
  const fromKey = shiftDateKey(today, -(windowToDays(window) - 1));

  const [account, rows] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { environmentAirQualityEnabled: true },
    }),
    prisma.environmentContext.findMany({
      where: { userId, date: { gte: fromKey } },
      orderBy: { date: "asc" },
      take: 800,
      select: {
        date: true,
        source: true,
        tempMin: true,
        tempMax: true,
        tempMean: true,
        apparentMax: true,
        precipSum: true,
        sunshineSec: true,
        pressureMean: true,
        pressureDelta: true,
        humidityMean: true,
        pm25Mean: true,
        pm25Max: true,
        pm10Mean: true,
        no2Mean: true,
        so2Mean: true,
        coMean: true,
        o3Max8h: true,
        eaqiMax: true,
        usaqiMax: true,
        uvIndexMax: true,
        dustMax: true,
        aodMax: true,
        pollenAlderMax: true,
        pollenBirchMax: true,
        pollenGrassMax: true,
        pollenMugwortMax: true,
        pollenOliveMax: true,
        pollenRagweedMax: true,
        aqFetchedAt: true,
        aqHours: true,
      },
    }),
  ]);

  if (rows.length === 0) {
    const older = await prisma.environmentContext.aggregate({
      where: { userId },
      _count: { _all: true },
      _min: { date: true },
      _max: { date: true },
    });
    if (older._count._all === 0 || !older._min.date || !older._max.date) {
      return { present: false, reason: "no_data" };
    }
    const lastDate = older._max.date;
    return {
      present: false,
      reason: "outside_window",
      searchedWindow: window,
      available: {
        count: older._count._all,
        firstDate: older._min.date,
        lastDate,
        reachableWithWindow:
          WINDOWS_NARROWEST_FIRST.find(
            (w) =>
              clampWindow(w, args.reach) === w &&
              shiftDateKey(today, -(windowToDays(w) - 1)) <= lastDate,
          ) ?? null,
      },
    };
  }

  const accountEnabled = account?.environmentAirQualityEnabled ?? true;
  const airActive = isAirQualityActive(accountEnabled);
  const airState: EnvironmentAirQualityState = airActive
    ? "on"
    : isAirQualityOperatorDisabled()
      ? "off_operator"
      : "off_account";

  let hotNights = 0;
  let veryPoorAirDays = 0;
  let highPollenDays = 0;
  let airQualityDays = 0;
  let pollenPeak: number | null = null;
  const days: EnvironmentToolDay[] = [];
  for (const row of rows) {
    if (isHotNight(row.tempMin)) hotNights += 1;
    const day: EnvironmentToolDay = {
      date: row.date,
      tempMin: row.tempMin,
      tempMax: row.tempMax,
      tempMean: round1(row.tempMean),
      apparentMax: row.apparentMax,
      precipSum: row.precipSum,
      sunshineHours:
        row.sunshineSec == null ? null : round1(row.sunshineSec / 3600),
      pressureMean: round1(row.pressureMean),
      pressureDelta: row.pressureDelta,
      humidityMean: round1(row.humidityMean),
    };
    if (airActive) {
      if (row.aqFetchedAt) {
        const pollen: PollenByKind = {
          alder: row.pollenAlderMax,
          birch: row.pollenBirchMax,
          grass: row.pollenGrassMax,
          mugwort: row.pollenMugwortMax,
          olive: row.pollenOliveMax,
          ragweed: row.pollenRagweedMax,
        };
        day.airQuality = {
          pm25Mean: row.pm25Mean,
          pm25Max: row.pm25Max,
          pm10Mean: row.pm10Mean,
          no2Mean: row.no2Mean,
          so2Mean: row.so2Mean,
          coMean: row.coMean,
          o3Max8h: row.o3Max8h,
          eaqiMax: row.eaqiMax,
          usaqiMax: row.usaqiMax,
          uvIndexMax: row.uvIndexMax,
          dustMax: row.dustMax,
          aodMax: row.aodMax,
          pollen,
        };
        if ((row.aqHours ?? 0) > 0) airQualityDays += 1;
        if (isVeryPoorAir(row.eaqiMax)) veryPoorAirDays += 1;
        if (highPollenKinds(pollen).length > 0) highPollenDays += 1;
        const peak = pollenMax(pollen);
        if (peak != null && (pollenPeak === null || peak > pollenPeak)) {
          pollenPeak = peak;
        }
      } else {
        day.airQuality = null;
      }
    }
    days.push(day);
  }

  const firstDate = rows[0].date;
  const lastDate = rows[rows.length - 1].date;
  return {
    present: true,
    data: {
      window,
      coverage: {
        firstDate,
        lastDate,
        days: rows.length,
        awayDays: rows.filter((r) => r.source === "TRAVEL").length,
        ...(airActive ? { airQualityDays } : {}),
      },
      daily: days.slice(-ENVIRONMENT_DAILY_LIMIT),
      summary: {
        hotNights,
        ...(airActive ? { veryPoorAirDays, highPollenDays, pollenPeak } : {}),
      },
      airQuality: airState,
      provenance: PROVENANCE,
      attributions: environmentAttributionLines({
        airQuality: airActive,
        year: Number(lastDate.slice(0, 4)),
      }),
    },
  };
}
