import { z } from "zod/v4";

import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import { runCoachTool, whenModuleOn } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/**
 * `get_environment` (#615). Declared field by field rather than as
 * the opaque Coach `data`, so the advertised schema itself says what the read
 * can carry: no coordinate and no place name appear anywhere in it, and a
 * strict client refuses a result that grew one. Every value is nullable
 * (null = the feed did not cover it); the air-quality fields are absent
 * while that part is switched off.
 */
const envValue = z.number().nullable();
const envPollen = z.object({
  alder: envValue,
  birch: envValue,
  grass: envValue,
  mugwort: envValue,
  olive: envValue,
  ragweed: envValue,
});
const envAirQuality = z.object({
  pm25Mean: envValue,
  pm25Max: envValue,
  pm10Mean: envValue,
  no2Mean: envValue,
  so2Mean: envValue,
  coMean: envValue,
  o3Max8h: envValue,
  eaqiMax: envValue,
  usaqiMax: envValue,
  uvIndexMax: envValue,
  dustMax: envValue,
  aodMax: envValue,
  pollen: envPollen,
});
const getEnvironmentOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  searchedWindow: z.string().optional(),
  available: z
    .object({
      count: z.number(),
      firstDate: z.string(),
      lastDate: z.string(),
      reachableWithWindow: z.string().nullable(),
    })
    .optional(),
  data: z
    .object({
      window: coachScopeWindowSchema,
      coverage: z.object({
        firstDate: z.string(),
        lastDate: z.string(),
        days: z.number(),
        awayDays: z.number(),
        airQualityDays: z.number().optional(),
      }),
      daily: z.array(
        z.object({
          date: z.string(),
          tempMin: envValue,
          tempMax: envValue,
          tempMean: envValue,
          apparentMax: envValue,
          precipSum: envValue,
          sunshineHours: envValue,
          pressureMean: envValue,
          pressureDelta: envValue,
          humidityMean: envValue,
          airQuality: envAirQuality.nullable().optional(),
        }),
      ),
      summary: z.object({
        hotNights: z.number(),
        veryPoorAirDays: z.number().optional(),
        highPollenDays: z.number().optional(),
        pollenPeak: envValue.optional(),
      }),
      airQuality: z.enum(["on", "off_account", "off_operator"]),
      provenance: z.object({
        weather: z.string(),
        airQuality: z.string(),
        note: z.string(),
      }),
      attributions: z.array(z.string()),
    })
    .optional(),
};

export const getEnvironmentTool: McpToolDefinition = {
  name: "get_environment",
  title: "Get weather, air quality and pollen",
  description:
    "Fetch the weather, air quality, pollen and UV the user's stored days had (environment module): per day the temperature (min, max, mean, feels-like high), precipitation, sunshine hours, pressure and humidity, and while air quality is on, PM2.5 (mean and peak), PM10, NO2, the ozone 8-hour high, the European AQI peak, UV, dust and six pollen kinds; plus coverage and a summary (hot nights, very poor air days, high pollen days). These are modelled outdoor conditions at a coarse location (ERA5 and CAMS, 9 to 45 km grid), not the user's personal exposure; describe co-occurrence, never a cause. Null means not covered, never zero. Carries no coordinates and no place names. Each result lists the attributions to show with it (Open-Meteo, CC BY 4.0; Copernicus Atmosphere Monitoring Service). Returns { present: false, reason: \"module_disabled\" } when the environment module is off, and no_data / outside_window when nothing is stored in the window.",
  inputShape: {
    window: coachScopeWindowSchema.optional(),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getEnvironmentOutput,
  run(ctx, args) {
    return whenModuleOn(ctx, "environment", "get_environment", () =>
      runCoachTool(ctx, "get_environment", args),
    );
  },
};
