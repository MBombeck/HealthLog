/**
 * v1.42 — the air-quality history backfill against real Postgres, with
 * Open-Meteo mocked at the wire.
 *
 *   - every past local day with an entry is filled: a day with a weather row
 *     gets its air quality, a day without one gets both, a day of a trip is
 *     fetched at the trip's place, a day from the home's effective date at
 *     the home;
 *   - a day before the home was set is filled only inside a location period;
 *     without one it stays empty and is not counted;
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
  AIR_QUALITY_HISTORY_CEILING,
  runAirQualityHistory,
} from "@/lib/environment/air-quality-history";
import { reserveOpenMeteoCalls } from "@/lib/environment/request-budget";
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
const ESSEN = { lat: 51.5, lon: 7.0, label: "Essen" };

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

interface StubOptions {
  /** HTTP status the archive answers with instead of data. */
  archiveStatus?: number;
  /** HTTP status the air-quality API answers with instead of data. */
  airStatus?: number;
  /** Days the archive leaves out of its answer. */
  omitArchiveDays?: readonly string[];
  /** Runs before every air-quality answer. */
  onAir?: () => Promise<void>;
}

/** Answers both feeds with a full day of values for every requested day. */
function openMeteoStub(opts: StubOptions = {}) {
  return vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const days = daysBetween(
      url.searchParams.get("start_date")!,
      url.searchParams.get("end_date")!,
    );
    if (url.pathname === "/v1/air-quality") {
      await opts.onAir?.();
      if (opts.airStatus) return new Response("", { status: opts.airStatus });
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
    if (opts.archiveStatus) {
      return new Response("", { status: opts.archiveStatus });
    }
    const answered = days.filter((d) => !opts.omitArchiveDays?.includes(d));
    const daily: Record<string, unknown> = { time: answered };
    for (const field of url.searchParams.get("daily")!.split(",")) {
      daily[field] = answered.map(() => 5);
    }
    const time = answered.flatMap((d) =>
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
      // Days before it are filled only inside a location period.
      homeSince: new Date("2025-01-01T00:00:00Z"),
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
  await prisma.environmentTravelLocation.create({
    data: {
      userId: OWNER,
      startDate: "2020-03-01",
      endDate: "2020-03-10",
      locationEncrypted: sealLocation(ESSEN),
    },
  });
  // Entries: one before the source reaches, two nearby days on a 2020 trip,
  // one before the home with no trip, one on a 2024 trip, one on a day with a
  // weather row lacking air quality, one on a day already done, one at home
  // without a row, a mood entry, and one inside the last week.
  for (const day of [
    "2012-06-01",
    "2020-03-01",
    "2020-03-05",
    "2020-06-01",
    "2024-07-05",
    "2025-05-01",
    "2025-06-01",
    "2025-09-10",
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

function useStub(opts: StubOptions) {
  fetchSpy = openMeteoStub(opts);
  vi.stubGlobal("fetch", fetchSpy);
}

/** `[path, start_date]` of every request sent, in order. */
function sentRanges() {
  return requests().map((u) => [u.pathname, u.searchParams.get("start_date")]);
}

async function rowOn(day: string) {
  return getPrismaClient().environmentContext.findUnique({
    where: { userId_date: { userId: OWNER, date: day } },
  });
}

describe("air-quality history backfill", () => {
  it("fills every past day with entries the source reaches, once", async () => {
    const prisma = getPrismaClient();
    const result = await runAirQualityHistory(OWNER, { now: NOW });
    expect(result).toMatchObject({
      status: "complete",
      total: 6,
      done: 6,
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
      "2025-09-10",
    ]);
    // Before the home and outside every period: no row, not counted.
    expect(rows.find((r) => r.date === "2020-06-01")).toBeUndefined();
    for (const row of rows) expect(row.aqFetchedAt).not.toBeNull();
    const byDate = new Map(rows.map((r) => [r.date, r]));
    // A day before the home was set, inside a period: at the period's place.
    expect(byDate.get("2020-03-01")).toMatchObject({
      source: "TRAVEL",
      pm25Mean: 12,
      tempMax: 5,
      lat: null,
    });
    expect(
      openLocation(byDate.get("2020-03-01")!.locationEncrypted!),
    ).toMatchObject({ lat: 51.5, lon: 7.0 });
    // A day after the home was set, without a row: at the home.
    const home = byDate.get("2025-09-10")!;
    expect(home).toMatchObject({ source: "HOME", pm25Mean: 12, tempMax: 5 });
    expect(openLocation(home.locationEncrypted!)).toMatchObject({
      lat: 51.5,
      lon: 7.2,
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
      ["2025-09-10", "2025-09-10"],
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
    ).toEqual(["2025-09-10", "2024-07-05", "2020-03-01"]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER } });
    expect(user.environmentAqHistoryJson).toMatchObject({
      total: 6,
      done: 6,
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
      total: 6,
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

describe("air-quality history: placing, failing and stopping", () => {
  it("places no day at a home stored without an effective date, as the nightly fetch does", async () => {
    await getPrismaClient().user.update({
      where: { id: OWNER },
      data: { homeSince: null },
    });
    const result = await runAirQualityHistory(OWNER, { now: NOW });
    // The two 2020 trip days, the 2024 trip day, the day with a row and the
    // day already done; the home day without a row is not placed anywhere.
    expect(result).toMatchObject({ status: "complete", total: 5, done: 5 });
    expect(await rowOn("2025-09-10")).toBeNull();
    expect(sentRanges().map(([, start]) => start)).not.toContain("2025-09-10");
  });

  it("stops at the first refused archive request and sends no air-quality request for it", async () => {
    useStub({ archiveStatus: 503 });
    const result = await runAirQualityHistory(OWNER, { now: NOW });
    expect(result).toMatchObject({ status: "error", filled: 0, fetches: 1 });
    expect(sentRanges()).toEqual([["/v1/archive", "2025-09-10"]]);
  });

  it("stops at the first refused air-quality request and keeps the weather it already paid for", async () => {
    useStub({ airStatus: 429 });
    const result = await runAirQualityHistory(OWNER, { now: NOW });
    expect(result).toMatchObject({ status: "error", filled: 0, fetches: 2 });
    expect(sentRanges()).toEqual([
      ["/v1/archive", "2025-09-10"],
      ["/v1/air-quality", "2025-09-10"],
    ]);
    // The weather row is stored, without air quality.
    expect(await rowOn("2025-09-10")).toMatchObject({
      tempMax: 5,
      pm25Mean: null,
      aqFetchedAt: null,
    });

    // The next run asks for that day's air quality only.
    useStub({});
    const next = await runAirQualityHistory(OWNER, { now: NOW });
    expect(next.status).toBe("complete");
    expect(sentRanges().filter(([, start]) => start === "2025-09-10")).toEqual([
      ["/v1/air-quality", "2025-09-10"],
    ]);
    expect(await rowOn("2025-09-10")).toMatchObject({
      tempMax: 5,
      pm25Mean: 12,
    });
  });

  it("sends no follow-up and no retry after a refused request", async () => {
    useStub({ archiveStatus: 503 });
    const sends: Array<{ data: unknown; options: unknown }> = [];
    const boss = {
      send: vi.fn(async (_name: string, data: unknown, options: unknown) => {
        sends.push({ data, options });
        return "job-id";
      }),
    };
    const outcome = await handleEnvironmentAqHistory(boss as never, {
      userId: OWNER,
    });
    expect(outcome.ok).toBe(false);
    expect(sends).toEqual([]);
  });

  it("creates no row for a day the archive answer leaves out", async () => {
    useStub({ omitArchiveDays: ["2020-03-05"] });
    const result = await runAirQualityHistory(OWNER, { now: NOW });
    expect(result).toMatchObject({ status: "progress", remaining: 1 });
    expect(await rowOn("2020-03-05")).toBeNull();
    expect(await rowOn("2020-03-01")).toMatchObject({ pm25Mean: 12 });
  });

  it.each([
    [
      "the account's air quality",
      () =>
        getPrismaClient()
          .user.update({
            where: { id: OWNER },
            data: { environmentAirQualityEnabled: false },
          })
          .then(() => undefined),
    ],
    [
      "the environment module",
      () =>
        getPrismaClient()
          .user.update({
            where: { id: OWNER },
            data: { modulePreferencesJson: { environment: false } },
          })
          .then(() => undefined),
    ],
    [
      "the operator switch",
      async () => {
        vi.stubEnv("ENVIRONMENT_AIR_QUALITY_DISABLED", "true");
      },
    ],
  ])("stops between two ranges once %s is switched off", async (_, off) => {
    let first = true;
    useStub({
      onAir: async () => {
        if (first) await off();
        first = false;
      },
    });
    const result = await runAirQualityHistory(OWNER, { now: NOW });
    expect(result.status).toBe("inactive");
    expect(
      requests().filter((u) => u.pathname === "/v1/air-quality"),
    ).toHaveLength(1);
  });

  it("holds the history's ceiling under concurrent reservations", async () => {
    const prisma = getPrismaClient();
    const key = `open-meteo-budget:account:${OWNER}:day`;
    await prisma.rateLimit.create({
      data: {
        key,
        count: (AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS - 1) * 100,
        resetAt: new Date(Date.now() + 3_600_000),
      },
    });
    const admitted = await Promise.all(
      Array.from({ length: 6 }, () =>
        reserveOpenMeteoCalls(0.5, OWNER, AIR_QUALITY_HISTORY_CEILING),
      ),
    );
    expect(admitted.filter(Boolean)).toHaveLength(2);
    const bucket = await prisma.rateLimit.findUniqueOrThrow({ where: { key } });
    expect(bucket.count).toBe(AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS * 100);
  });

  it("reads the days with entries once per chain and hands them to the follow-up", async () => {
    // Nine more home days, each more than two weeks apart: more ranges than
    // one run works through, so the run sends a follow-up.
    for (let i = 0; i < 9; i++) {
      await measurementOn(
        new Date(Date.parse("2025-01-10T00:00:00Z") + i * 20 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      );
    }
    const sends: Array<{ data: Record<string, unknown>; options: unknown }> =
      [];
    const boss = {
      send: vi.fn(
        async (
          _name: string,
          data: Record<string, unknown>,
          options: unknown,
        ) => {
          sends.push({ data, options });
          return "job-id";
        },
      ),
    };
    const outcome = await handleEnvironmentAqHistory(boss as never, {
      userId: OWNER,
    });
    expect(outcome.ok).toBe(true);
    expect(sends).toHaveLength(1);
    const followUp = sends[0]!.data as {
      userId: string;
      continuation: number;
      entryDays: { timezone: string; cutoff: string; days: string[] };
    };
    expect(followUp.entryDays.timezone).toBe("Europe/Berlin");
    // A failed run is not retried straight into the same refusal.
    expect(sends[0]!.options).toMatchObject({ retryLimit: 0 });
    expect(followUp.entryDays.days).toContain("2025-01-10");

    // An entry added after the chain read its days is left to the next
    // chain: the follow-up does not scan the entry tables again.
    await measurementOn("2025-11-20");
    fetchSpy.mockClear();
    await handleEnvironmentAqHistory(boss as never, followUp);
    expect(await rowOn("2025-11-20")).toBeNull();
    // A fresh chain reads it.
    const fresh = await runAirQualityHistory(OWNER);
    expect(fresh.entryDays!.days).toContain("2025-11-20");
  });
});
