/**
 * The air-quality day and its attributions (v1.42, #615).
 *
 * One `EnvironmentContext` row carries, beside the weather, the day's air
 * quality, pollen and UV from the Open-Meteo air-quality API (CAMS models).
 * This is the shape every reader agrees on: the environment overview, the
 * Coach and MCP read, and the day view. Every value is nullable, because a
 * partial feed stores what it has and a day the feed never covered is
 * absent, not zero.
 */

/** One local day of air quality, as stored and as served. */
export interface AirQualityDay {
  /** Daily apparent ("feels-like") maximum, °C. */
  apparentMax: number | null;
  /** PM2.5 daily mean and hourly maximum, µg/m³. */
  pm25Mean: number | null;
  pm25Max: number | null;
  /** PM10 daily mean, µg/m³. */
  pm10Mean: number | null;
  /** NO2, SO2 and CO daily means, µg/m³. */
  no2Mean: number | null;
  so2Mean: number | null;
  coMean: number | null;
  /** Ozone, highest 8-hour running mean of the day, µg/m³. */
  o3Max8h: number | null;
  /** European and US air-quality index, daily maximum. */
  eaqiMax: number | null;
  usaqiMax: number | null;
  /** UV index, daily maximum. */
  uvIndexMax: number | null;
  /** Saharan dust (µg/m³) and aerosol optical depth, daily maximum. */
  dustMax: number | null;
  aodMax: number | null;
  /** Pollen daily maxima, grains/m³; Europe only. */
  pollenAlderMax: number | null;
  pollenBirchMax: number | null;
  pollenGrassMax: number | null;
  pollenMugwortMax: number | null;
  pollenOliveMax: number | null;
  pollenRagweedMax: number | null;
  /** Which model domain served the day, e.g. `cams_europe`. */
  aqDomain: string | null;
  /** Hourly samples the day was aggregated from. */
  aqHours: number | null;
  /** When the air-quality part was fetched, ISO-8601; null = not yet. */
  aqFetchedAt: string | null;
}

/** Who the values come from, shown wherever they are shown. */
export const AIR_QUALITY_ATTRIBUTIONS = [
  {
    key: "cams",
    name: "Copernicus Atmosphere Monitoring Service (CAMS)",
    url: "https://atmosphere.copernicus.eu/",
  },
  {
    key: "open-meteo",
    name: "Open-Meteo",
    url: "https://open-meteo.com/",
  },
] as const;
