/**
 * v1.42 — the air-quality history backfill against real Postgres, with
 * Open-Meteo mocked at the wire.
 *
 *   - every past local day with an entry is filled: a day with a weather row
 *     gets its air quality, a day without one gets both, a day of a trip is
 *     fetched at the trip's place, a day before the home was set at the home;
 *   - a day before the source reaches stays without a row and is not counted,
 *     and the last week is left to the nightly fetch;
 *   - nearby days share one request, the coordinates sent are the coarse
 *     ones, and a second run sends nothing (idempotent);
 *   - the history's own ceiling inside the account's daily share stops a run
 *     before anything is sent, and the progress says how far it got;
 *   - the account switch and the operator switch stop it entirely;
 *   - the queue handler runs it and the overview reports the progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS,
  runAirQualityHistory,
} from "@/lib/environment/air-quality-history";
import { openLocation, sealLocation } from "@/lib/environment/location-cipher";
import { handleEnvironmentAqHistory } from "@/lib/jobs/environment-air-quality-history";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const OWNER = "aq-history-owner";
const NOW = new Date("2026-10-09T03:00:00Z");
const BOCHUM = { lat: 51.5, lon: 7.2, label: "Bochum" };
const LISBON = { lat: 38.7, lon: -9.1, label: "Lisbon" };

function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${start}T00:00:00Z`);
    t <= Date.parse(`${end}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Answers both feeds with a full day of values for every requested day. */
function openMeteoStub() {
  return vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const days = daysBetween(
      url.searchParams.get("start_date")!,
      url.searchParams.get("end_date")!,
    );
    if (url.pathname === "/v1/air-quality") {
      const variables = url.searchParams.get("hourly")!.split(",");
      const time = days.flatMap((d) =>
        Array.from(
          { length: 24 },
          (_, h) => `${d}T${String(h).padStart(2, "0")}:00`,
        ),
      );
      const hourly: Record<string, unknown> = { time };
      for (const v of variables) hourly[v] = time.map(() => 12);
      return Response.json({ hourly });
    }
    const daily: Record<string, unknown> = { time: days };
    for (const field of url.searchParams.get("daily")!.split(",")) {
      daily[field] = days.map(() => 5);
    }
    const time = days.flatMap((d) =>
      Array.from(
        { length: 24 },
        (_, h) => `${d}T${String(h).padStart(2, "0")}:00`,
      ),
    );
    const hourly: Record<string, unknown> = { time };
    for (const field of url.searchParams.get("hourly")!.split(",")) {
      hourly[field] = time.map(() => 1000);
    }
    return Response.json({ daily, hourly });
  });
}

async function measurementOn(day: string) {
  await getPrismaClient().measurement.create({
    data: {
      userId: OWNER,
      type: "WEIGHT",
      value: 70,
      unit: "kg",
      measuredAt: new Date(`${day}T10:00:00Z`),
    },
  });
}

let fetchSpy: ReturnType<typeof openMeteoStub>;

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: OWNER,
      username: OWNER,
      email: `${OWNER}@example.test`,
      timezone: "Europe/Berlin",
      homeLocationEncrypted: sealLocation(BOCHUM),
      homeTimezone: "Europe/Berlin",
      // Set recently: every day below lies before it.
      homeSince: new Date("2026-09-01T00:00:00Z"),
      modulePreferencesJson: { environment: true },
    },
  });
  await prisma.environmentTravelLocation.create({
    data: {
      userId: OWNER,
      startDate: "2024-07-01",
      endDate: "2024-07-14",
      locationEncrypted: sealLocation(LISBON),
    },
  });
  // Entries: one before the source reaches, two nearby days in 2020, one on
  // a trip, one on a day with a weather row lacking air quality, one on a
  // day already done, a mood entry, and one inside the last week.
  for (const day of [
    "2012-06-01",
    "2020-03-01",
    "2020-03-05",
    "2024-07-05",
    "2025-05-01",
    "2025-06-01",
    "2026-10-06",
  ]) {
    await measurementOn(day);
  }
  await prisma.moodEntry.create({
    data: {
      userId: OWNER,
      date: "2020-03-05",
      mood: "GUT",
      score: 4,
      moodLoggedAt: new Date("2020-03-05T18:00:00Z"),
    },
  });
  const sealedHome = sealLocation(BOCHUM);
  await prisma.environmentContext.create({
    data: {
      userId: OWNER,
      date: "2025-05-01",
      locationEncrypted: sealedHome,
      source: "HOME",
      tempMax: 20,
    },
  });
  await prisma.environmentContext.create({
    data: {
      userId: OWNER,
      date: "2025-06-01",
      locationEncrypted: sealedHome,
      source: "HOME",
      tempMax: 22,
      pm25Mean: 7,
      aqHours: 24,
      aqFetchedAt: new Date("2025-06-02T00:00:00Z"),
    },
  });
  fetchSpy = openMeteoStub();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function requests() {
  return fetchSpy.mock.calls.map(([input]) => new URL(String(input)));
}

describe("air-quality history backfill", () => {
  it("fills every past day with entries the source reaches, once", async () => {
    const prisma = getPrismaClient();
    const result = await runAirQualityHistory(OWNER, { now: NOW });
    expect(result).toMatchObject({
      status: "complete",
      total: 5,
      done: 5,
      remaining: 0,
    });

    const rows = await prisma.environmentContext.findMany({
      where: { userId: OWNER },
      orderBy: { date: "asc" },
    });
    expect(rows.map((r) => r.date)).toEqual([
      "2020-03-01",
      "2020-03-05",
      "2024-07-05",
      "2025-05-01",
      "2025-06-01",
    ]);
    for (const row of rows) expect(row.aqFetchedAt).not.toBeNull();
    const byDate = new Map(rows.map((r) => [r.date, r]));
    // A day before the home was set: placed at the home, weather and air.
    expect(byDate.get("2020-03-01")).toMatchObject({
      source: "HOME",
      pm25Mean: 12,
      tempMax: 5,
      lat: null,
    });
    // Pollen is not asked for before 2021, so it stays null, not zero.
    expect(byDate.get("2020-03-01")!.pollenBirchMax).toBeNull();
    // A trip day: at the trip's place.
    const trip = byDate.get("2024-07-05")!;
    expect(trip.source).toBe("TRAVEL");
    expect(openLocation(trip.locationEncrypted!)).toMatchObject({
      lat: 38.7,
      lon: -9.1,
    });
    // A day with a weather row: air quality added, weather kept.
    expect(byDate.get("2025-05-01")).toMatchObject({
      tempMax: 20,
      pm25Mean: 12,
    });
    // The done day was not touched.
    expect(byDate.get("2025-06-01")!.pm25Mean).toBe(7);

    // The two 2020 days share one request each for air and weather; the
    // coordinates are the coarse ones; the 2020 request asks the pollutant
    // set only. The done day and the last week are never asked for.
    const sent = requests();
    const air = sent.filter((u) => u.pathname === "/v1/air-quality");
    expect(
      air.map((u) => [
        u.searchParams.get("start_date"),
        u.searchParams.get("end_date"),
      ]),
    ).toEqual([
      ["2025-05-01", "2025-05-01"],
      ["2024-07-05", "2024-07-05"],
      ["2020-03-01", "2020-03-05"],
    ]);
    const old = air.find(
      (u) => u.searchParams.get("start_date") === "2020-03-01",
    )!;
    expect(old.searchParams.get("hourly")!.split(",")).toHaveLength(8);
    for (const u of sent) {
      expect(["51.5", "38.7"]).toContain(u.searchParams.get("latitude"));
    }
    // Weather only where a row was missing.
    expect(
      sent
        .filter((u) => u.pathname === "/v1/archive")
        .map((u) => u.searchParams.get("start_date")),
    ).toEqual(["2024-07-05", "2020-03-01"]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER } });
    expect(user.environmentAqHistoryJson).toMatchObject({
      total: 5,
      done: 5,
      complete: true,
    });

    // Idempotent: a second run finds nothing to ask for.
    fetchSpy.mockClear();
    const again = await runAirQualityHistory(OWNER, { now: NOW });
    expect(again).toMatchObject({ status: "complete", filled: 0, fetches: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops at its own ceiling inside the account's daily share before sending", async () => {
    const prisma = getPrismaClient();
    await prisma.rateLimit.create({
      data: {
        key: `open-meteo-budget:account:${OWNER}:day`,
        count: (AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS - 0.5) * 100,
        resetAt: new Date(Date.now() + 3_600_000),
      },
    });
    const result = await runAirQualityHistory(OWNER, { now: NOW });
    expect(result).toMatchObject({ status: "budget", filled: 0, done: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER } });
    expect(user.environmentAqHistoryJson).toMatchObject({
      total: 5,
      done: 1,
      complete: false,
    });
  });

  it("does nothing while the account or the operator has air quality off", async () => {
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: OWNER },
      data: { environmentAirQualityEnabled: false },
    });
    expect((await runAirQualityHistory(OWNER, { now: NOW })).status).toBe(
      "inactive",
    );
    await prisma.user.update({
      where: { id: OWNER },
      data: { environmentAirQualityEnabled: true },
    });
    vi.stubEnv("ENVIRONMENT_AIR_QUALITY_DISABLED", "true");
    expect((await runAirQualityHistory(OWNER, { now: NOW })).status).toBe(
      "inactive",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await prisma.environmentContext.count({
        where: { userId: OWNER, aqFetchedAt: { not: null } },
      }),
    ).toBe(1);
  });

  it("runs through the queue handler, and discovery offers only a due account", async () => {
    const sends: Array<{ name: string; data: unknown }> = [];
    const boss = {
      send: vi.fn(async (name: string, data: unknown) => {
        sends.push({ name, data });
        return "job-id";
      }),
    };
    const outcome = await handleEnvironmentAqHistory(boss as never, {
      userId: OWNER,
    });
    expect(outcome.ok).toBe(true);
    const state = (
      await getPrismaClient().user.findUniqueOrThrow({ where: { id: OWNER } })
    ).environmentAqHistoryJson as { complete: boolean };
    expect(state.complete).toBe(true);
    // Through and checked just now: discovery leaves it alone.
    sends.length = 0;
    await handleEnvironmentAqHistory(boss as never, {});
    expect(sends).toEqual([]);
  });
});
