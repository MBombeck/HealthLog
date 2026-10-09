/**
 * v1.42 (#615) — the air-quality client: how hourly values become a day, and
 * what leaves the host.
 *
 * Fixtures only, no live call: a day is built hour by hour so each rule is
 * pinned at its edge (18 of 24 hours, 6 of 8 in an ozone window, 13 of 17
 * windows, the midday UV hours), a missing value stays null and is never read
 * as zero, and the request carries the coarse coordinates, `domains=auto`
 * and nothing else about the person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reserve = vi.hoisted(() => vi.fn(async (_weight: number) => true));
vi.mock("@/lib/environment/request-budget", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/environment/request-budget")
  >()),
  reserveOpenMeteoCalls: reserve,
}));

import {
  AIR_QUALITY_VARIABLES,
  aggregateAirQuality,
  chunkDays,
  coveredMax,
  coveredMean,
  fetchDailyAirQuality,
  insideCamsEurope,
  ozoneMax8h,
  uvIndexMax,
  variablesForChunk,
  airQualityChunkWeight,
  earliestAirQualityDay,
  type AirQualityHourly,
} from "../open-meteo-air-quality";

/** 24 hourly stamps of one local day. */
function hoursOf(day: string): string[] {
  return Array.from(
    { length: 24 },
    (_, h) => `${day}T${String(h).padStart(2, "0")}:00`,
  );
}

/** A full day with every variable at `value`, then `edit` applied. */
function dayFixture(
  day: string,
  value: number,
  edit: (h: AirQualityHourly) => void = () => {},
): AirQualityHourly {
  const hourly: AirQualityHourly = { time: hoursOf(day) };
  for (const variable of AIR_QUALITY_VARIABLES) {
    hourly[variable] = Array.from({ length: 24 }, () => value);
  }
  edit(hourly);
  return hourly;
}

const BOCHUM = { lat: 51.5, lon: 7.2 };

beforeEach(() => {
  reserve.mockReset();
  reserve.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("daily rules", () => {
  it("averages a day with 18 hours and refuses one with 17", () => {
    const eighteen = [...Array(18).fill(10), ...Array(6).fill(null)];
    const seventeen = [...Array(17).fill(10), ...Array(7).fill(null)];
    expect(coveredMean(eighteen)).toBe(10);
    expect(coveredMean(seventeen)).toBeNull();
    expect(coveredMax(eighteen)).toBe(10);
    expect(coveredMax(seventeen)).toBeNull();
  });

  it("never reads a missing hour as zero", () => {
    // 18 hours at 20 and six missing: a zero-fill would give 15.
    expect(coveredMean([...Array(18).fill(20), ...Array(6).fill(null)])).toBe(
      20,
    );
  });

  it("takes the highest 8-hour running mean inside the day", () => {
    const byHour = Array.from({ length: 24 }, (_, h) =>
      h >= 12 && h < 20 ? 120 : 40,
    );
    expect(ozoneMax8h(byHour)).toBe(120);
  });

  it("counts an ozone window with 6 of 8 hours and drops the day under 13 windows", () => {
    // Hours 0–5 missing: windows starting 0..3 have fewer than 6 hours…
    const sparse = Array.from({ length: 24 }, (_, h) => (h < 6 ? null : 50));
    // windows 0,1 have 2/3 hours; 2,3 have 4/5; 4..16 have ≥6 → 13 windows.
    expect(ozoneMax8h(sparse)).toBe(50);
    const sparser = Array.from({ length: 24 }, (_, h) => (h < 7 ? null : 50));
    expect(ozoneMax8h(sparser)).toBeNull();
  });

  it("gives a UV maximum only when the midday hours are all there", () => {
    const full: (number | null)[] = Array.from({ length: 24 }, (_, h) =>
      h === 13 ? 6.5 : 1,
    );
    expect(uvIndexMax(full)).toBe(6.5);
    const gap = [...full];
    gap[11] = null;
    expect(uvIndexMax(gap)).toBeNull();
  });

  it("decides the model domain by the CAMS Europe box", () => {
    expect(insideCamsEurope(51.5, 7.2)).toBe(true);
    expect(insideCamsEurope(40.7, -74)).toBe(false);
    expect(insideCamsEurope(-33.9, 151.2)).toBe(false);
  });
});

describe("aggregateAirQuality", () => {
  it("folds a full day into one observation", () => {
    const [day] = aggregateAirQuality(
      dayFixture("2025-05-01", 10, (h) => {
        h.pm2_5![15] = 40;
        h.european_aqi![15] = 85;
      }),
      BOCHUM,
    );
    expect(day).toMatchObject({
      date: "2025-05-01",
      pm25Mean: 11.3,
      pm25Max: 40,
      eaqiMax: 85,
      pollenBirchMax: 10,
      aqDomain: "cams_europe",
      aqHours: 24,
    });
  });

  it("keeps a variable the feed left empty as null (pollen outside Europe)", () => {
    const [day] = aggregateAirQuality(
      dayFixture("2023-06-07", 30, (h) => {
        for (const kind of [
          "alder_pollen",
          "birch_pollen",
          "grass_pollen",
          "mugwort_pollen",
          "olive_pollen",
          "ragweed_pollen",
        ] as const) {
          h[kind] = Array(24).fill(null);
        }
      }),
      { lat: 40.7, lon: -74 },
    );
    expect(day.pm25Mean).toBe(30);
    expect(day.pollenGrassMax).toBeNull();
    expect(day.pollenBirchMax).toBeNull();
    expect(day.aqDomain).toBe("cams_global");
  });

  it("keeps a variable missing from the response as null (the pre-2022 era)", () => {
    const hourly: AirQualityHourly = {
      time: hoursOf("2016-03-01"),
      pm2_5: Array(24).fill(12),
    };
    const [day] = aggregateAirQuality(hourly, BOCHUM);
    expect(day.pm25Mean).toBe(12);
    expect(day.uvIndexMax).toBeNull();
    expect(day.pollenBirchMax).toBeNull();
    expect(day.dustMax).toBeNull();
  });
});

describe("requests", () => {
  it("splits into 90-day chunks and asks each era only for what it carries", () => {
    expect(chunkDays("2022-01-01", "2022-07-01")).toEqual([
      { startDate: "2022-01-01", endDate: "2022-03-31" },
      { startDate: "2022-04-01", endDate: "2022-06-29" },
      { startDate: "2022-06-30", endDate: "2022-07-01" },
    ]);
    // Pollutants and indices alone before 2021.
    expect(variablesForChunk("2020-12-31")).toHaveLength(8);
    // Pollen and dust join in 2021 (Europe).
    expect(variablesForChunk("2021-01-01")).toHaveLength(15);
    expect(variablesForChunk("2022-07-31")).toHaveLength(15);
    // UV and aerosol depth from CAMS global, August 2022 on.
    expect(variablesForChunk("2022-08-01")).toHaveLength(17);
    // Weight: 90 days of the full set is 1.7 × 90 / 14 calls.
    expect(airQualityChunkWeight("2023-01-01", "2023-03-31")).toBeCloseTo(
      (1.7 * 90) / 14,
    );
    expect(airQualityChunkWeight("2015-01-01", "2015-01-01")).toBe(1);
  });

  it("sends the coarse coordinates, the timezone and domains=auto, nothing else", async () => {
    const fetchSpy = vi.fn(async (_url: unknown) =>
      Response.json({ hourly: dayFixture("2025-05-01", 10) }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchDailyAirQuality({
      ...BOCHUM,
      timezone: "Europe/Berlin",
      startDate: "2025-05-01",
      endDate: "2025-05-01",
    });
    expect(result.stopped).toBeNull();
    expect(result.days).toHaveLength(1);
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      "https://air-quality-api.open-meteo.com/v1/air-quality",
    );
    expect([...url.searchParams.keys()].sort()).toEqual(
      [
        "domains",
        "end_date",
        "hourly",
        "latitude",
        "longitude",
        "start_date",
        "timezone",
      ].sort(),
    );
    expect(url.searchParams.get("latitude")).toBe("51.5");
    expect(url.searchParams.get("longitude")).toBe("7.2");
    expect(url.searchParams.get("domains")).toBe("auto");
    expect(url.searchParams.get("hourly")!.split(",")).toHaveLength(17);
  });

  it("asks the budget with the request's weight and sends nothing when it refuses", async () => {
    reserve.mockResolvedValue(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchDailyAirQuality({
      ...BOCHUM,
      timezone: "UTC",
      startDate: "2025-01-01",
      endDate: "2025-03-31",
    });
    expect(result).toEqual({ days: [], stopped: "budget" });
    expect(fetchSpy).not.toHaveBeenCalled();
    // 17 variables over 90 days: 1.7 × 90/14.
    expect(reserve.mock.calls[0]![0]).toBeCloseTo(1.7 * (90 / 14), 5);
  });

  it("fetches newest first and keeps what it has when a chunk fails", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ hourly: dayFixture("2025-06-30", 5) }),
      )
      .mockResolvedValueOnce(new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchDailyAirQuality({
      ...BOCHUM,
      timezone: "UTC",
      startDate: "2025-01-01",
      endDate: "2025-06-30",
    });
    expect(result.stopped).toBe("error");
    expect(result.days.map((d) => d.date)).toEqual(["2025-06-30"]);
    const first = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(first.searchParams.get("end_date")).toBe("2025-06-30");
  });

  it("answers days before 2013 as uncoverable without a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchDailyAirQuality({
      ...BOCHUM,
      timezone: "UTC",
      startDate: "2012-12-30",
      endDate: "2012-12-31",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.days.map((d) => [d.date, d.aqHours, d.pm25Mean])).toEqual([
      ["2012-12-30", 0, null],
      ["2012-12-31", 0, null],
    ]);
  });

  it("answers days before August 2022 outside Europe as uncoverable without a request", async () => {
    const fetchSpy = vi.fn(async (_url: unknown) =>
      Response.json({ hourly: dayFixture("2022-08-01", 10) }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchDailyAirQuality({
      lat: 40.7,
      lon: -74,
      timezone: "UTC",
      startDate: "2022-07-30",
      endDate: "2022-08-01",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get("start_date")).toBe("2022-08-01");
    expect(
      result.days.filter((d) => d.aqHours === 0).map((d) => d.date),
    ).toEqual(["2022-07-30", "2022-07-31"]);
    expect(earliestAirQualityDay(40.7, -74)).toBe("2022-08-01");
    expect(earliestAirQualityDay(51.5, 7.2)).toBe("2013-01-01");
  });

  it("honours a self-hosted endpoint", async () => {
    vi.resetModules();
    vi.stubEnv("OPENMETEO_AIR_QUALITY_URL", "https://aq.example.test/");
    const fetchSpy = vi.fn(async (_url: unknown) =>
      Response.json({ hourly: {} }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const fresh = await import("../open-meteo-air-quality");
    await fresh.fetchDailyAirQuality({
      ...BOCHUM,
      timezone: "UTC",
      startDate: "2025-05-01",
      endDate: "2025-05-01",
    });
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(
      /^https:\/\/aq\.example\.test\/v1\/air-quality\?/,
    );
  });

  it("reads the operator switch", async () => {
    const { isAirQualityActive } = await import("../open-meteo-air-quality");
    expect(isAirQualityActive(true)).toBe(true);
    expect(isAirQualityActive(false)).toBe(false);
    vi.stubEnv("ENVIRONMENT_AIR_QUALITY_DISABLED", "true");
    expect(isAirQualityActive(true)).toBe(false);
  });
});
