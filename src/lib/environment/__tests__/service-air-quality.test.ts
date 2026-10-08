/**
 * v1.42 (#615) — the fetch-and-store run with air quality and sealed
 * locations.
 *
 *  - the weather row is stored even when the air-quality fetch fails, and
 *    its air-quality part is left unfetched for the gap fill;
 *  - with air quality on, the day's values and `aqFetchedAt` ride the same
 *    upsert; off by the account or by the operator, the feed is not asked;
 *  - the home is opened from its sealed copy and only its coarse
 *    coordinates go into a request; the row is written sealed, the readable
 *    location columns empty;
 *  - a refused budget stops the run without failing it;
 *  - the gap fill fetches the stored days newest first at the location each
 *    day was stored for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  travel: [] as Array<Record<string, unknown>>,
  days: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<{
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }>,
  updates: [] as Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }>,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => db.user) },
    environmentTravelLocation: { findMany: vi.fn(async () => db.travel) },
    environmentContext: {
      upsert: vi.fn(
        (args: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          db.upserts.push(args);
          return args;
        },
      ),
      findMany: vi.fn(async () => db.days),
      updateMany: vi.fn(
        (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          db.updates.push(args);
          return { count: 1 };
        },
      ),
    },
    $transaction: vi.fn(async (ops: unknown[]) =>
      ops.map((op) =>
        op && typeof op === "object" && "count" in op ? op : op,
      ),
    ),
  },
}));

const weather = vi.hoisted(() => vi.fn());
vi.mock("@/lib/environment/open-meteo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environment/open-meteo")>()),
  fetchDailyEnvironment: weather,
}));
const air = vi.hoisted(() => vi.fn());
vi.mock("@/lib/environment/open-meteo-air-quality", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/environment/open-meteo-air-quality")
  >()),
  fetchDailyAirQuality: air,
}));

import { openLocation, sealLocation } from "../location-cipher";
import { OpenMeteoBudgetExhaustedError } from "../request-budget";
import { uncoverableDay } from "../open-meteo-air-quality";
import { fetchAndStoreEnvironment, fillAirQualityGaps } from "../service";

function obs(date: string) {
  return {
    date,
    tempMin: 14,
    tempMax: 24,
    tempMean: 19,
    apparentMean: 18,
    apparentMax: 25,
    sunshineSec: 3600,
    daylightSec: 50_000,
    precipSum: 0,
    pressureMean: 1012,
    pressureDelta: 3,
    humidityMean: 60,
    cloudMean: 40,
    weatherCode: 1,
  };
}

function airDay(date: string) {
  return {
    ...uncoverableDay(date),
    pm25Mean: 9.5,
    aqHours: 24,
    aqDomain: "cams_europe",
  };
}

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", "d".repeat(64));
  db.user = {
    homeLat: null,
    homeLon: null,
    homeLabel: null,
    homeLocationEncrypted: sealLocation({
      lat: 51.48,
      lon: 7.21,
      label: "Bochum, Germany",
    }),
    homeTimezone: "Europe/Berlin",
    homeSince: new Date("2026-01-01T00:00:00Z"),
    timezone: "Europe/Berlin",
    environmentAirQualityEnabled: true,
  };
  db.travel = [];
  db.days = [];
  db.upserts = [];
  db.updates = [];
  weather.mockReset();
  air.mockReset();
  weather.mockImplementation(async (args: { startDate: string }) => [
    obs(args.startDate),
  ]);
});
afterEach(() => vi.unstubAllEnvs());

describe("fetchAndStoreEnvironment", () => {
  it("asks both feeds with the coarse home only and writes the day sealed", async () => {
    air.mockResolvedValue({ days: [airDay("2026-05-01")], stopped: null });
    const result = await fetchAndStoreEnvironment({
      userId: "u1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });
    expect(result).toMatchObject({ stored: 1, budgetBlocked: false });
    for (const call of [weather.mock.calls[0][0], air.mock.calls[0][0]]) {
      expect(Object.keys(call).sort()).toEqual(
        ["endDate", "lat", "lon", "startDate", "timezone"].sort(),
      );
      expect([call.lat, call.lon]).toEqual([51.5, 7.2]);
    }
    const { create } = db.upserts[0];
    expect(create).toMatchObject({
      lat: null,
      lon: null,
      locationLabel: null,
      source: "HOME",
      apparentMax: 25,
      pm25Mean: 9.5,
      aqHours: 24,
    });
    expect(create.aqFetchedAt).toBeInstanceOf(Date);
    expect(openLocation(create.locationEncrypted as Uint8Array)).toEqual({
      lat: 51.5,
      lon: 7.2,
      label: "Bochum, Germany",
    });
  });

  it("stores the weather when the air-quality fetch fails, and leaves the air part unfetched", async () => {
    air.mockResolvedValue({ days: [], stopped: "error" });
    const result = await fetchAndStoreEnvironment({
      userId: "u1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });
    expect(result.stored).toBe(1);
    const { update } = db.upserts[0];
    expect(update).toMatchObject({
      tempMin: 14,
      aqFetchedAt: null,
      pm25Mean: null,
    });
  });

  it("does not ask the air-quality feed when the account turned it off", async () => {
    db.user!.environmentAirQualityEnabled = false;
    await fetchAndStoreEnvironment({
      userId: "u1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });
    expect(air).not.toHaveBeenCalled();
    // The stored air part is left as it is: no air column in the write.
    expect(Object.keys(db.upserts[0].update)).not.toContain("aqFetchedAt");
  });

  it("does not ask it when the operator turned it off", async () => {
    vi.stubEnv("ENVIRONMENT_AIR_QUALITY_DISABLED", "1");
    await fetchAndStoreEnvironment({
      userId: "u1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });
    expect(air).not.toHaveBeenCalled();
  });

  it("stops without failing when the budget refuses", async () => {
    weather.mockRejectedValue(new OpenMeteoBudgetExhaustedError());
    const result = await fetchAndStoreEnvironment({
      userId: "u1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });
    expect(result).toMatchObject({ stored: 0, budgetBlocked: true });
    expect(air).not.toHaveBeenCalled();
  });

  it("resolves a period from its sealed copy", async () => {
    db.travel = [
      {
        startDate: "2026-05-01",
        endDate: "2026-05-02",
        lat: null,
        lon: null,
        label: null,
        locationEncrypted: sealLocation({
          lat: 38.72,
          lon: -9.14,
          label: "Lisbon, Portugal",
        }),
      },
    ];
    air.mockResolvedValue({ days: [], stopped: null });
    await fetchAndStoreEnvironment({
      userId: "u1",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });
    expect([
      weather.mock.calls[0][0].lat,
      weather.mock.calls[0][0].lon,
    ]).toEqual([38.7, -9.1]);
    expect(db.upserts[0].create.source).toBe("TRAVEL");
  });
});

describe("fillAirQualityGaps", () => {
  it("fetches each stored day at its own sealed location and marks it fetched", async () => {
    const sealed = sealLocation({ lat: 51.5, lon: 7.2, label: "Home" });
    db.days = [
      {
        date: "2026-05-03",
        lat: null,
        lon: null,
        locationLabel: null,
        locationEncrypted: sealed,
      },
      {
        date: "2026-05-02",
        lat: null,
        lon: null,
        locationLabel: null,
        locationEncrypted: sealed,
      },
    ];
    air.mockResolvedValue({
      days: [airDay("2026-05-02"), airDay("2026-05-03")],
      stopped: null,
    });
    const result = await fillAirQualityGaps("u1");
    expect(result).toEqual({ filled: 2, stopped: null });
    expect(air.mock.calls[0][0]).toMatchObject({
      lat: 51.5,
      lon: 7.2,
      startDate: "2026-05-02",
      endDate: "2026-05-03",
    });
    expect(db.updates.map((u) => u.where)).toEqual([
      { userId: "u1", date: "2026-05-02", aqFetchedAt: null },
      { userId: "u1", date: "2026-05-03", aqFetchedAt: null },
    ]);
  });

  it("is a no-op while air quality is off for the account", async () => {
    db.user!.environmentAirQualityEnabled = false;
    expect(await fillAirQualityGaps("u1")).toEqual({
      filled: 0,
      stopped: null,
    });
    expect(air).not.toHaveBeenCalled();
  });
});
