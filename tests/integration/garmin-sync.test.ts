/**
 * The Garmin Personal API integration against the real schema and a fake
 * Garmin served over HTTP.
 *
 * `safeFetch` is wrapped so a request to either Garmin host is sent to a
 * local `http.Server` instead; everything else about the request (method,
 * headers, body reading, the byte cap) is the production path. The fake
 * answers the token exchange (`ApiKey <key>` → a JWT), and the daily
 * summaries, sleep, HRV, weigh-ins, activity search and cycle summary from a
 * made-up history generated on request. No value is from a real account.
 *
 * What is pinned:
 *   - a sync writes each resource's rows under `source = GARMIN`, a workout,
 *     the cycle's period days, and stamps the `garmin` ledger;
 *   - a second sync writes no second row (idempotent re-read);
 *   - a key Garmin stops accepting is re-exchanged exactly once, then the
 *     connection is parked at `reauth_required`;
 *   - a 429 ends the run without reading further resources;
 *   - the history backfill walks back to the start of the history in slices
 *     and stamps its marker; a 429 in the middle sends the next slice after
 *     the wait Garmin named;
 *   - connect validates and stores the key sealed, disconnect purges it and
 *     everything stored about it, while the imported history stays.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { Prisma } from "@/generated/prisma/client";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const fake = vi.hoisted(() => ({
  base: "",
  key: "made-up-garmin-key-0001",
  /** Days with wellness data: from this day to `today`. */
  historyFrom: "2026-10-01",
  today: "2026-11-04",
  requests: [] as string[],
  /** Next data calls answered 401 (count down). */
  dataUnauthorized: 0,
  /** Answer the n-th data request with a 429 (0-based), -1 for never. */
  rateLimitAt: -1,
  dataCalls: 0,
  /** Index in `requests` of the request the 429 answered. */
  rateLimitHit: -1,
  /** First day of the one logged cycle, relative to today. */
  cycleStart: "",
  /** Several logged cycles instead of the one; when set, `cycleStart` is unused. */
  cycles: [] as Array<{ start: string; periodLength: number }>,
  /**
   * The weigh-in shape: `spec` is Garmin's document (kilograms, no
   * `samplePk`, a string instant), `live` the shape seen on the live
   * service (grams, a `samplePk`, epoch ms).
   */
  weightShape: "spec" as "spec" | "live",
  /** Extra weigh-in days, beyond today (e.g. before the first watch day). */
  extraWeighDays: [] as string[],
  /** The status the cycle summary answers with; 200 for the made-up cycle. */
  cycleStatus: 200,
  /** The status the HRV range answers with; 200 for the made-up nights. */
  hrvStatus: 200,
  /** Sleep days Garmin no longer reports (deleted, or now a nap). */
  sleepGone: [] as string[],
  /** Host each request was addressed to before the rewrite. */
  hosts: [] as string[],
  /** Runs on each data request, before the answer. */
  onData: null as null | ((path: string) => Promise<void>),
  sends: [] as Array<{ queue: string; payload: unknown }>,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({
    send: async (queue: string, payload: unknown) => {
      fake.sends.push({ queue, payload });
      return `job-${fake.sends.length}`;
    },
  }),
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (
      url: string | URL,
      init?: RequestInit,
      opts?: Parameters<typeof actual.safeFetch>[2],
    ) => {
      fake.hosts.push(new URL(url.toString()).host);
      const target = url
        .toString()
        .replace(
          /^https:\/\/personal\.connectapi\.garmin\.(com|cn)/,
          fake.base,
        );
      return actual.safeFetch(target, init, opts);
    },
  };
});

const USER_ID = "user-garmin";
const DAY_MS = 86_400_000;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function jwt(): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  return `${enc({ alg: "none" })}.${enc({ exp })}.sig`;
}

const TOKEN = jwt();

/** One weigh-in of 75.5 kg with 19 % body fat, in the configured shape. */
function weighIn(day: string) {
  const at = Date.parse(`${day}T06:00:00Z`);
  return fake.weightShape === "spec"
    ? {
        calendarDate: day,
        date: new Date(at).toISOString().replace("Z", ""),
        timestampGMT: new Date(at).toISOString(),
        weight: 75.5,
        bodyFat: 19,
        muscleMass: 34,
        boneMass: 3,
      }
    : {
        samplePk: 500 + Number(day.slice(8, 10)),
        calendarDate: day,
        date: at,
        timestampGMT: at,
        weight: 75_500,
        bodyFat: 19,
        muscleMass: 34_000,
        boneMass: 3_000,
      };
}

/** The made-up history, generated per request. */
function answer(path: string, q: URLSearchParams): unknown {
  const inHistory = (d: string) => d >= fake.historyFrom && d <= fake.today;
  if (path === "/usersummary-service/v2/dailysummaries") {
    return {
      data: daysBetween(q.get("startDate")!, q.get("endDate")!).map((d) =>
        inHistory(d)
          ? {
              calendarDate: d,
              includesWellnessData: true,
              movement: {
                steps: { value: 9000, distanceInMeters: 7000 },
                floorsAscended: { value: 5 },
              },
              calories: { burnedActive: 450 },
              heartRate: { restingValue: 54 },
              stress: { avgLevel: 28 },
              bodyBattery: { maxValue: 82 },
            }
          : { calendarDate: d, includesWellnessData: false },
      ),
    };
  }
  if (path === "/sleep-service/sleep/dailySleepSummariesByDate") {
    return daysBetween(q.get("startDate")!, q.get("endDate")!).map((d) =>
      inHistory(d) && !fake.sleepGone.includes(d)
        ? {
            calendarDate: d,
            sleepTimeSeconds: 25_200,
            sleepEndTimestampGMT: Date.parse(`${d}T05:30:00Z`),
            deepSleepSeconds: 5_400,
            lightSleepSeconds: 13_800,
            remSleepSeconds: 6_000,
            awakeSleepSeconds: 900,
            averageSpO2Value: 95,
            averageRespirationValue: 14,
            sleepScores: { overall: { value: 77 } },
          }
        : { calendarDate: null, sleepTimeSeconds: null },
    );
  }
  if (path.startsWith("/hrv-service/hrv/daily/")) {
    if (fake.hrvStatus !== 200) return { status: fake.hrvStatus };
    const [, , , , from, to] = path.split("/");
    return {
      hrvSummaries: daysBetween(from!, to!)
        .filter(inHistory)
        .map((d) => ({ calendarDate: d, lastNightAvg: 44 })),
    };
  }
  if (path.startsWith("/weight-service/weight/range/")) {
    const [, , , , from, to] = path.split("/");
    const days = [fake.today, ...fake.extraWeighDays].filter(
      (d) => d >= from! && d <= to!,
    );
    return {
      dailyWeightSummaries: days.map((d) => ({
        summaryDate: d,
        allWeightMetrics: [weighIn(d)],
      })),
    };
  }
  if (path === "/activitylist-service/activities/search/activities") {
    const runDay = addDays(fake.today, -2);
    const start = q.get("startDate")!;
    const end = q.get("endDate")!;
    if (Number(q.get("start")) > 0) return [];
    return runDay >= start && runDay <= end
      ? [
          {
            activityId: 777,
            startTimeGMT: `${runDay} 06:00:00`,
            activityType: { typeKey: "running" },
            duration: 1800,
            distance: 5000,
            calories: 350,
          },
        ]
      : [];
  }
  if (path.startsWith("/periodichealth-service/menstrualcycle/summary/")) {
    if (fake.cycleStatus !== 200) return { status: fake.cycleStatus };
    const day = path.split("/").pop()!;
    if (fake.cycles.length > 0) {
      const at = [...fake.cycles]
        .sort((a, b) => b.start.localeCompare(a.start))
        .find((c) => c.start <= day);
      return at
        ? {
            startDate: { localDate: at.start },
            periodLength: at.periodLength,
            predictedCycle: false,
          }
        : {};
    }
    const cycleStart = fake.cycleStart;
    return day >= cycleStart
      ? { startDate: cycleStart, periodLength: 4, predictedCycle: false }
      : {};
  }
  return null;
}

let server: Server;

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    await readBody(req);
    const u = new URL(req.url!, "http://fake");
    fake.requests.push(`${req.method} ${u.pathname}${u.search}`);
    const auth = req.headers.authorization ?? "";
    if (u.pathname.startsWith("/personalapitoken-service/")) {
      if (auth !== `ApiKey ${fake.key}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end(TOKEN);
      return;
    }
    const n = fake.dataCalls++;
    if (fake.dataUnauthorized > 0) {
      fake.dataUnauthorized--;
      res.writeHead(401).end();
      return;
    }
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (n === fake.rateLimitAt) {
      fake.rateLimitHit =
        fake.requests.filter((r) =>
          r.includes("/usersummary-service/v2/dailysummaries"),
        ).length - 1;
      res.writeHead(429, { "retry-after": "900" }).end();
      return;
    }
    await fake.onData?.(u.pathname);
    const body = answer(u.pathname, u.searchParams);
    if (
      body &&
      typeof body === "object" &&
      "status" in body &&
      Object.keys(body).length === 1
    ) {
      res.writeHead((body as { status: number }).status).end();
      return;
    }
    if (body === null) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connectUser() {
  const { encrypt } = await import("@/lib/crypto");
  await getPrismaClient().user.update({
    where: { id: USER_ID },
    data: {
      garminApiKeyEncrypted: encrypt(fake.key),
      garminRegion: "global",
      garminConnectedAt: new Date(),
    },
  });
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  fake.requests.length = 0;
  fake.sends.length = 0;
  fake.dataUnauthorized = 0;
  fake.rateLimitAt = -1;
  fake.dataCalls = 0;
  fake.rateLimitHit = -1;
  fake.key = "made-up-garmin-key-0001";
  fake.today = new Date().toISOString().slice(0, 10);
  fake.historyFrom = addDays(fake.today, -20);
  fake.cycleStart = addDays(fake.today, -15);
  fake.cycles = [];
  fake.weightShape = "spec";
  fake.extraWeighDays = [];
  fake.cycleStatus = 200;
  fake.hrvStatus = 200;
  fake.sleepGone = [];
  fake.hosts.length = 0;
  fake.onData = null;
  const { clearGarminTokenCache } = await import("@/lib/garmin/client");
  clearGarminTokenCache();
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "garmin-user",
      email: "garmin@example.test",
      timezone: "UTC",
      gender: "FEMALE",
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

async function garminRowCounts() {
  const rows = await getPrismaClient().measurement.groupBy({
    by: ["type"],
    where: { userId: USER_ID, source: "GARMIN", deletedAt: null },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.type, r._count._all]));
}

describe("Garmin sync", () => {
  it("writes every resource under source GARMIN and stamps the ledger", async () => {
    await connectUser();
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    const result = await syncUserGarmin(USER_ID, { lookbackDays: 6 });
    expect(result.failed).toBe(false);

    const counts = await garminRowCounts();
    // Seven days (today and six back), each with its daily and nightly rows.
    expect(counts).toMatchObject({
      ACTIVITY_STEPS: 7,
      WALKING_RUNNING_DISTANCE: 7,
      FLIGHTS_CLIMBED: 7,
      ACTIVE_ENERGY_BURNED: 7,
      RESTING_HEART_RATE: 7,
      STRESS_LEVEL: 7,
      BODY_BATTERY: 7,
      SLEEP_DURATION: 28,
      SLEEP_SCORE: 7,
      OXYGEN_SATURATION: 7,
      RESPIRATORY_RATE: 7,
      HRV_RMSSD: 7,
      WEIGHT: 1,
      BODY_FAT: 1,
    });
    const prisma = getPrismaClient();
    const weight = await prisma.measurement.findFirst({
      where: { userId: USER_ID, type: "WEIGHT" },
    });
    expect(weight).toMatchObject({ source: "GARMIN", value: 75.5, unit: "kg" });
    const stages = await prisma.measurement.findMany({
      where: { userId: USER_ID, type: "SLEEP_DURATION" },
      select: { sleepStage: true },
      distinct: ["sleepStage"],
    });
    expect(stages.map((s) => s.sleepStage).sort()).toEqual([
      "AWAKE",
      "CORE",
      "DEEP",
      "REM",
    ]);

    const workouts = await prisma.workout.findMany({
      where: { userId: USER_ID },
    });
    expect(workouts).toHaveLength(1);
    expect(workouts[0]).toMatchObject({
      source: "GARMIN",
      externalId: "777",
      sportType: "running",
      durationSec: 1800,
    });

    const cycleDays = await prisma.cycleDayLog.findMany({
      where: { userId: USER_ID },
      orderBy: { date: "asc" },
    });
    expect(cycleDays.map((d) => [d.date, d.source, d.flow])).toEqual(
      [0, 1, 2, 3].map((i) => [addDays(fake.cycleStart, i), "GARMIN", "LIGHT"]),
    );

    const ledger = await prisma.integrationStatus.findFirst({
      where: { userId: USER_ID, integration: "garmin" },
    });
    expect(ledger?.state).toBe("connected");
    // One exchange for the whole run.
    expect(
      fake.requests.filter((r) => r.includes("personalapitoken")),
    ).toHaveLength(1);
  });

  it("writes no second row on a re-sync", async () => {
    await connectUser();
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    await syncUserGarmin(USER_ID, { lookbackDays: 6 });
    const before = await getPrismaClient().measurement.count({
      where: { userId: USER_ID },
    });
    await syncUserGarmin(USER_ID, { lookbackDays: 6 });
    const after = await getPrismaClient().measurement.count({
      where: { userId: USER_ID },
    });
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
    expect(
      await getPrismaClient().workout.count({ where: { userId: USER_ID } }),
    ).toBe(1);
    expect(
      await getPrismaClient().cycleDayLog.count({ where: { userId: USER_ID } }),
    ).toBe(4);
  });

  it("never overwrites a cycle day the person logged", async () => {
    await connectUser();
    await getPrismaClient().cycleDayLog.create({
      data: {
        userId: USER_ID,
        date: addDays(fake.cycleStart, 1),
        flow: "HEAVY",
      },
    });
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    await syncUserGarmin(USER_ID, { lookbackDays: 2 });
    const own = await getPrismaClient().cycleDayLog.findFirst({
      where: { userId: USER_ID, date: addDays(fake.cycleStart, 1) },
    });
    expect(own).toMatchObject({ source: "MANUAL", flow: "HEAVY" });
  });

  it("re-exchanges once on a refused token, then parks the key", async () => {
    await connectUser();
    fake.dataUnauthorized = 2;
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    await expect(
      syncUserGarmin(USER_ID, { lookbackDays: 2 }),
    ).rejects.toThrow();
    expect(
      fake.requests.filter((r) => r.includes("personalapitoken")),
    ).toHaveLength(2);
    // The two refused data calls and nothing after them.
    expect(fake.dataCalls).toBe(2);
    const ledger = await getPrismaClient().integrationStatus.findFirst({
      where: { userId: USER_ID, integration: "garmin" },
    });
    expect(ledger?.state).toBe("error_reauth");
    // The hourly cohort skips a parked key instead of asking Garmin again.
    const before = fake.requests.length;
    const skipped = await syncUserGarmin(USER_ID, { skipWhenParked: true });
    expect(skipped).toEqual({ imported: 0, failed: false });
    expect(fake.requests.length).toBe(before);
  });

  it("stops at a 429 and records a transient failure", async () => {
    await connectUser();
    fake.rateLimitAt = 1; // the sleep summaries, after the daily summaries
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    const result = await syncUserGarmin(USER_ID, { lookbackDays: 2 });
    expect(result.failed).toBe(true);
    // Daily summaries, then the refused sleep read; no HRV, weight or
    // activity request, no cycle request.
    expect(fake.dataCalls).toBe(2);
    expect(fake.requests.some((r) => r.includes("/hrv-service/"))).toBe(false);
    const ledger = await getPrismaClient().integrationStatus.findFirst({
      where: { userId: USER_ID, integration: "garmin" },
    });
    expect(ledger?.state).toBe("error_transient");
    expect((await garminRowCounts()).ACTIVITY_STEPS).toBe(3);
  });
});

describe("Garmin history backfill", () => {
  it("walks the history in slices to its start and stamps the marker", async () => {
    await connectUser();
    fake.historyFrom = addDays(fake.today, -400);
    fake.rateLimitAt = 3;
    const { runGarminBackfillForUser } =
      await import("@/lib/jobs/garmin-backfill");
    const prisma = getPrismaClient();

    // Slice 0 hits the 429 and sends the next slice after Garmin's wait.
    const first = await runGarminBackfillForUser(USER_ID, () => false, 0);
    expect(first.continued).toBe(true);
    expect(fake.sends.at(-1)).toMatchObject({
      queue: "integration-backfill-admission",
      payload: { kind: "garmin-backfill", data: { slice: 1 } },
    });

    let slice = 1;
    for (; slice < 20; slice++) {
      const user = await prisma.user.findUnique({
        where: { id: USER_ID },
        select: { garminBackfillCompletedAt: true },
      });
      if (user?.garminBackfillCompletedAt) break;
      await runGarminBackfillForUser(USER_ID, () => false, slice);
    }
    const user = await prisma.user.findUnique({
      where: { id: USER_ID },
      select: { garminBackfillCompletedAt: true, garminBackfillProgress: true },
    });
    expect(user?.garminBackfillCompletedAt).not.toBeNull();
    expect(
      (user?.garminBackfillProgress as { historyStart?: string }).historyStart,
    ).toBe(fake.historyFrom);

    // Every day of the history has its steps row, once.
    const counts = await garminRowCounts();
    expect(counts.ACTIVITY_STEPS).toBe(401);
    expect(counts.HRV_RMSSD).toBe(401);
    expect(counts.SLEEP_DURATION).toBe(401 * 4);
    // No daily-summary window was read twice, apart from the one the 429
    // interrupted: the next slice resumed exactly there.
    const dailyReads = fake.requests.filter((r) =>
      r.includes("/usersummary-service/v2/dailysummaries"),
    );
    expect(dailyReads.length - new Set(dailyReads).size).toBe(1);
    const repeated = dailyReads.find((r, i) => dailyReads.indexOf(r) !== i);
    expect(dailyReads.indexOf(repeated!)).toBe(fake.rateLimitHit);
  });
});

describe("Garmin cycle history", () => {
  async function backfillToEnd() {
    const { runGarminBackfillForUser } =
      await import("@/lib/jobs/garmin-backfill");
    for (let slice = 0; slice < 20; slice++) {
      const user = await getPrismaClient().user.findUnique({
        where: { id: USER_ID },
        select: { garminBackfillCompletedAt: true },
      });
      if (user?.garminBackfillCompletedAt) return;
      await runGarminBackfillForUser(USER_ID, () => false, slice);
    }
    throw new Error("backfill did not finish");
  }

  async function liveCycles() {
    return getPrismaClient().menstrualCycle.findMany({
      where: { userId: USER_ID, deletedAt: null },
      orderBy: { startDate: "asc" },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        lengthDays: true,
        periodEndDate: true,
      },
    });
  }

  it("opens a cycle per back-filled period, newest first, with lengths and a forecast", async () => {
    await connectUser();
    fake.historyFrom = addDays(fake.today, -100);
    const starts = [-80, -52, -24].map((n) => addDays(fake.today, n));
    fake.cycles = starts.map((start) => ({ start, periodLength: 5 }));
    // A day the person logged inside the middle period.
    const ownDay = addDays(starts[1]!, 2);
    const prisma = getPrismaClient();
    await prisma.cycleDayLog.create({
      data: { userId: USER_ID, date: ownDay, flow: "HEAVY" },
    });

    await backfillToEnd();

    const cycles = await liveCycles();
    expect(
      cycles.map((c) => [
        c.startDate,
        c.endDate,
        c.lengthDays,
        c.periodEndDate,
      ]),
    ).toEqual([
      [starts[0], addDays(starts[1]!, -1), 28, addDays(starts[0]!, 4)],
      [starts[1], addDays(starts[2]!, -1), 28, addDays(starts[1]!, 4)],
      [starts[2], null, null, addDays(starts[2]!, 4)],
    ]);
    // Every Garmin day belongs to the period it is part of.
    const days = await prisma.cycleDayLog.findMany({
      where: { userId: USER_ID },
      orderBy: { date: "asc" },
      select: { date: true, source: true, flow: true, cycleId: true },
    });
    expect(days).toHaveLength(15);
    for (const day of days) {
      const owner = [...cycles].reverse().find((c) => c.startDate <= day.date);
      expect(day.cycleId).toBe(owner?.id);
    }
    // The person's own day is theirs, as they logged it.
    expect(days.find((d) => d.date === ownDay)).toMatchObject({
      source: "MANUAL",
      flow: "HEAVY",
    });

    const { getOrCreateCycleProfile } = await import("@/lib/cycle/profile");
    await getOrCreateCycleProfile(USER_ID);
    const { refreshPredictionCacheForUser } =
      await import("@/lib/cycle/prediction-refresh");
    expect(await refreshPredictionCacheForUser(USER_ID)).toBe("persisted");
    const forecast = await prisma.cyclePrediction.findUnique({
      where: { userId: USER_ID },
    });
    expect(forecast).not.toBeNull();

    // A second full backfill changes nothing.
    await prisma.user.update({
      where: { id: USER_ID },
      data: {
        garminBackfillProgress: Prisma.DbNull,
        garminBackfillCompletedAt: null,
      },
    });
    await backfillToEnd();
    expect(await liveCycles()).toEqual(cycles);
    expect(await prisma.cycleDayLog.count({ where: { userId: USER_ID } })).toBe(
      15,
    );
  });

  it("opens the current cycle from the hourly sync and leaves its end open while bleeding", async () => {
    await connectUser();
    const start = addDays(fake.today, -1);
    fake.cycles = [{ start, periodLength: 5 }];
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    await syncUserGarmin(USER_ID, { lookbackDays: 2 });
    const cycles = await liveCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ startDate: start, periodEndDate: null });
    const days = await getPrismaClient().cycleDayLog.findMany({
      where: { userId: USER_ID },
      select: { cycleId: true },
    });
    expect(days).toHaveLength(2);
    expect(days.every((d) => d.cycleId === cycles[0]!.id)).toBe(true);
  });
});

describe("Garmin connect and disconnect", () => {
  function post(url: string, body?: unknown) {
    return new NextRequest(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("refuses a key Garmin does not accept and stores nothing", async () => {
    const { POST } = await import("@/app/api/garmin/connect/route");
    const res = await POST(
      post("/api/garmin/connect", { apiKey: "w".repeat(24) }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta?.errorCode).toBe("garmin.key_refused");
    expect(JSON.stringify(body)).not.toContain("w".repeat(24));
    // Only the chosen service (global by default) was asked.
    expect(
      fake.requests.filter((r) => r.includes("personalapitoken")),
    ).toHaveLength(1);
    expect(fake.hosts).toEqual(["personal.connectapi.garmin.com"]);
    const user = await getPrismaClient().user.findUnique({
      where: { id: USER_ID },
      select: { garminApiKeyEncrypted: true },
    });
    expect(user?.garminApiKeyEncrypted).toBeNull();
  });

  it("stores the key sealed, then disconnect purges it and keeps the history", async () => {
    const prisma = getPrismaClient();
    const { POST: connect } = await import("@/app/api/garmin/connect/route");
    const res = await connect(
      post("/api/garmin/connect", { apiKey: fake.key, validityDays: 90 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      connected: true,
      region: "global",
      keyExpiry: { state: "ok" },
    });
    const stored = await prisma.user.findUnique({
      where: { id: USER_ID },
      select: {
        garminApiKeyEncrypted: true,
        garminKeyExpiresAt: true,
        garminRegion: true,
      },
    });
    expect(stored?.garminApiKeyEncrypted).toBeTruthy();
    expect(stored?.garminApiKeyEncrypted).not.toContain(fake.key);
    expect(stored?.garminRegion).toBe("global");
    const days = (stored!.garminKeyExpiresAt!.getTime() - Date.now()) / DAY_MS;
    expect(Math.round(days)).toBe(90);
    expect(fake.sends.map((s) => s.queue)).toEqual(
      expect.arrayContaining(["garmin-sync", "garmin-backfill"]),
    );

    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    await syncUserGarmin(USER_ID, { lookbackDays: 1 });
    const rows = await prisma.measurement.count({ where: { userId: USER_ID } });
    expect(rows).toBeGreaterThan(0);

    const { POST: disconnect } =
      await import("@/app/api/garmin/disconnect/route");
    const out = await disconnect();
    expect(out.status).toBe(200);
    const after = await prisma.user.findUnique({
      where: { id: USER_ID },
      select: {
        garminApiKeyEncrypted: true,
        garminRegion: true,
        garminConnectedAt: true,
        garminKeyExpiresAt: true,
        garminBackfillProgress: true,
        garminBackfillCompletedAt: true,
      },
    });
    expect(after).toEqual({
      garminApiKeyEncrypted: null,
      garminRegion: null,
      garminConnectedAt: null,
      garminKeyExpiresAt: null,
      garminBackfillProgress: null,
      garminBackfillCompletedAt: null,
    });
    expect(await prisma.measurement.count({ where: { userId: USER_ID } })).toBe(
      rows,
    );
    const ledger = await prisma.integrationStatus.findFirst({
      where: { userId: USER_ID, integration: "garmin" },
    });
    expect(ledger?.state).toBe("disconnected");
    // With no key, a sync is a clean no-op that asks Garmin nothing.
    const before = fake.requests.length;
    expect(await syncUserGarmin(USER_ID)).toEqual({
      imported: 0,
      failed: false,
    });
    expect(fake.requests.length).toBe(before);
  });
});

describe("Garmin connect sends the key only to the chosen service", () => {
  it("contacts the China host alone when the person picks it", async () => {
    const { POST } = await import("@/app/api/garmin/connect/route");
    const res = await POST(
      new NextRequest("http://localhost/api/garmin/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: fake.key, region: "china" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(fake.hosts).toEqual(["personal.connectapi.garmin.cn"]);
    const user = await getPrismaClient().user.findUnique({
      where: { id: USER_ID },
      select: { garminRegion: true },
    });
    expect(user?.garminRegion).toBe("china");
  });
});

describe("Garmin weigh-ins", () => {
  it.each(["spec", "live"] as const)(
    "writes a whole weigh-in from the %s shape",
    async (shape) => {
      await connectUser();
      fake.weightShape = shape;
      const { syncUserGarmin } = await import("@/lib/garmin/sync");
      await syncUserGarmin(USER_ID, { lookbackDays: 1 });
      const rows = await getPrismaClient().measurement.findMany({
        where: {
          userId: USER_ID,
          type: { in: ["WEIGHT", "BODY_FAT", "MUSCLE_MASS", "BONE_MASS"] },
        },
        select: { type: true, value: true, externalId: true },
        orderBy: { type: "asc" },
      });
      expect(
        rows
          .map((r) => [r.type, r.value] as const)
          .sort(([a], [b]) => a.localeCompare(b)),
      ).toEqual([
        ["BODY_FAT", 19],
        ["BONE_MASS", 3],
        ["MUSCLE_MASS", 34],
        ["WEIGHT", 75.5],
      ]);
      // One weigh-in, one id across its rows; a re-read lands on the same.
      expect(new Set(rows.map((r) => r.externalId!.split(":")[1])).size).toBe(
        1,
      );
      await syncUserGarmin(USER_ID, { lookbackDays: 1 });
      expect(
        await getPrismaClient().measurement.count({
          where: { userId: USER_ID, type: "WEIGHT" },
        }),
      ).toBe(1);
    },
  );

  it("walks weigh-ins back past the first watch day", async () => {
    await connectUser();
    fake.historyFrom = addDays(fake.today, -20);
    fake.extraWeighDays = [addDays(fake.today, -600)];
    const { runGarminBackfillForUser } =
      await import("@/lib/jobs/garmin-backfill");
    for (let slice = 0; slice < 30; slice++) {
      const u = await getPrismaClient().user.findUnique({
        where: { id: USER_ID },
        select: { garminBackfillCompletedAt: true },
      });
      if (u?.garminBackfillCompletedAt) break;
      await runGarminBackfillForUser(USER_ID, () => false, slice);
    }
    const weights = await getPrismaClient().measurement.findMany({
      where: { userId: USER_ID, type: "WEIGHT" },
      select: { measuredAt: true },
      orderBy: { measuredAt: "asc" },
    });
    expect(weights).toHaveLength(2);
    expect(weights[0]!.measuredAt.toISOString().slice(0, 10)).toBe(
      addDays(fake.today, -600),
    );
  });
});

describe("Garmin resources the account does not have", () => {
  it("completes the backfill and keeps the connection green when the cycle summary is refused", async () => {
    await connectUser();
    fake.cycleStatus = 404;
    const { runGarminBackfillForUser } =
      await import("@/lib/jobs/garmin-backfill");
    const prisma = getPrismaClient();
    for (let slice = 0; slice < 30; slice++) {
      const u = await prisma.user.findUnique({
        where: { id: USER_ID },
        select: { garminBackfillCompletedAt: true },
      });
      if (u?.garminBackfillCompletedAt) break;
      await runGarminBackfillForUser(USER_ID, () => false, slice);
    }
    const user = await prisma.user.findUnique({
      where: { id: USER_ID },
      select: { garminBackfillCompletedAt: true, garminBackfillProgress: true },
    });
    expect(user?.garminBackfillCompletedAt).not.toBeNull();
    expect(
      (user?.garminBackfillProgress as { unavailable?: unknown }).unavailable,
    ).toEqual({ cycle: "http_404" });

    // The hourly sync skips it and stays green.
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    fake.requests.length = 0;
    const result = await syncUserGarmin(USER_ID, { lookbackDays: 1 });
    expect(result.failed).toBe(false);
    expect(fake.requests.some((r) => r.includes("menstrualcycle"))).toBe(false);
    const ledger = await prisma.integrationStatus.findFirst({
      where: { userId: USER_ID, integration: "garmin" },
    });
    expect(ledger?.state).toBe("connected");
  });

  it("notes a resource the hourly sync is refused, skips it after, and stays green", async () => {
    await connectUser();
    fake.hrvStatus = 404;
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    const first = await syncUserGarmin(USER_ID, { lookbackDays: 1 });
    expect(first.failed).toBe(false);
    const prisma = getPrismaClient();
    const user = await prisma.user.findUnique({
      where: { id: USER_ID },
      select: { garminBackfillProgress: true },
    });
    expect(
      (user?.garminBackfillProgress as { unavailable?: unknown }).unavailable,
    ).toEqual({ hrv: "http_404" });
    fake.requests.length = 0;
    await syncUserGarmin(USER_ID, { lookbackDays: 1 });
    expect(fake.requests.some((r) => r.includes("/hrv-service/"))).toBe(false);
    const ledger = await prisma.integrationStatus.findFirst({
      where: { userId: USER_ID, integration: "garmin" },
    });
    expect(ledger?.state).toBe("connected");
  });

  it("never parks the connection on a refused cycle summary", async () => {
    await connectUser();
    fake.cycleStatus = 401;
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    const result = await syncUserGarmin(USER_ID, { lookbackDays: 1 });
    expect(result.failed).toBe(false);
    const ledger = await getPrismaClient().integrationStatus.findFirst({
      where: { userId: USER_ID, integration: "garmin" },
    });
    expect(ledger?.state).toBe("connected");
  });
});

describe("Garmin parked key", () => {
  it("asks Garmin again once a day and reconnects when the key works", async () => {
    await connectUser();
    const prisma = getPrismaClient();
    fake.dataUnauthorized = 2;
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    await expect(
      syncUserGarmin(USER_ID, { lookbackDays: 1 }),
    ).rejects.toThrow();
    // Within the day: skipped, nothing asked.
    const before = fake.requests.length;
    await syncUserGarmin(USER_ID, { skipWhenParked: true, lookbackDays: 1 });
    expect(fake.requests.length).toBe(before);
    // A day later: one probe, accepted, and the run goes on.
    await prisma.integrationStatus.updateMany({
      where: { userId: USER_ID, integration: "garmin" },
      data: { lastAttemptAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    const result = await syncUserGarmin(USER_ID, {
      skipWhenParked: true,
      lookbackDays: 1,
    });
    expect(result.failed).toBe(false);
    expect(result.imported).toBeGreaterThan(0);
    const ledger = await prisma.integrationStatus.findFirst({
      where: { userId: USER_ID, integration: "garmin" },
    });
    expect(ledger?.state).toBe("connected");
  });
});

describe("Garmin backfill and a reconnect mid-slice", () => {
  it("writes nothing once the connection under the slice was replaced", async () => {
    await connectUser();
    const prisma = getPrismaClient();
    const replacedAt = new Date(Date.now() + 1000);
    fake.onData = async () => {
      fake.onData = null;
      await prisma.user.update({
        where: { id: USER_ID },
        data: {
          garminConnectedAt: replacedAt,
          garminBackfillProgress: Prisma.DbNull,
          garminBackfillCompletedAt: null,
        },
      });
    };
    const { runGarminBackfillForUser } =
      await import("@/lib/jobs/garmin-backfill");
    const out = await runGarminBackfillForUser(USER_ID, () => false, 0);
    expect(out.continued).toBe(false);
    const user = await prisma.user.findUnique({
      where: { id: USER_ID },
      select: { garminBackfillProgress: true, garminBackfillCompletedAt: true },
    });
    expect(user).toEqual({
      garminBackfillProgress: null,
      garminBackfillCompletedAt: null,
    });
  });
});

describe("Garmin catch-up and removed nights", () => {
  it("reaches back to the last successful sync after a long outage", async () => {
    await connectUser();
    const prisma = getPrismaClient();
    await prisma.integrationStatus.create({
      data: {
        userId: USER_ID,
        integration: "garmin",
        state: "error_transient",
        lastSuccessAt: new Date(Date.now() - 60 * 86_400_000),
      },
    });
    const { resolveGarminLookbackDays } = await import("@/lib/garmin/sync");
    expect(await resolveGarminLookbackDays(USER_ID)).toBe(61);
  });

  it("retires a night Garmin no longer reports", async () => {
    await connectUser();
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    await syncUserGarmin(USER_ID, { lookbackDays: 3 });
    const gone = addDays(fake.today, -1);
    const live = (day: string) =>
      getPrismaClient().measurement.count({
        where: {
          userId: USER_ID,
          deletedAt: null,
          externalId: { startsWith: `sleep:${day}:` },
        },
      });
    expect(await live(gone)).toBe(7);
    fake.sleepGone = [gone];
    await syncUserGarmin(USER_ID, { lookbackDays: 3 });
    expect(await live(gone)).toBe(0);
    expect(await live(addDays(fake.today, -2))).toBe(7);
  });
});

describe("Garmin key expiry", () => {
  it("clears an estimated end the key outlived, and takes a corrected validity", async () => {
    await connectUser();
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: USER_ID },
      data: { garminKeyExpiresAt: new Date(Date.now() - 86_400_000) },
    });
    const { syncUserGarmin } = await import("@/lib/garmin/sync");
    await syncUserGarmin(USER_ID, { lookbackDays: 1 });
    expect(
      (
        await prisma.user.findUnique({
          where: { id: USER_ID },
          select: { garminKeyExpiresAt: true },
        })
      )?.garminKeyExpiresAt,
    ).toBeNull();

    const { PATCH } = await import("@/app/api/garmin/key-expiry/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/garmin/key-expiry", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          validityDays: 90,
          createdOn: addDays(fake.today, -10),
        }),
      }),
    );
    expect(res.status).toBe(200);
    const stored = await prisma.user.findUnique({
      where: { id: USER_ID },
      select: { garminKeyExpiresAt: true },
    });
    expect(stored?.garminKeyExpiresAt?.toISOString()).toBe(
      `${addDays(fake.today, 80)}T12:00:00.000Z`,
    );
  });
});
