/**
 * Sleep statistics are statistics of nights, on every summary surface.
 *
 * `SLEEP_DURATION` is stored one row per stage segment: a watch night lands
 * as an in-bed span plus a few dozen core, deep, REM and awake segments of a
 * few minutes each. A summary that treats each row as a reading reports the
 * mean segment ("19 min a night"), the latest segment as the latest value,
 * a half-minute awake spell as the minimum and the segment count as the
 * number of readings. This suite seeds segmented nights and holds the
 * insights overview and both analytics slices to one point per night: the
 * night's time asleep, as the sleep pages reconstruct it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  const { __resetAllCachesForTests } = await import("@/lib/cache/server-cache");
  __resetAllCachesForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

type Stage = "IN_BED" | "AWAKE" | "CORE" | "DEEP" | "REM";

/**
 * One night's segments, as minutes. Asleep: 40+30+25+45+35+20+50+40+45+30+
 * 25+35 = 420; awake: 3+0.5+4 = 7.5; the in-bed span covers them all.
 */
const NIGHT: Array<{ stage: Stage; minutes: number }> = [
  { stage: "CORE", minutes: 40 },
  { stage: "DEEP", minutes: 30 },
  { stage: "REM", minutes: 25 },
  { stage: "AWAKE", minutes: 3 },
  { stage: "CORE", minutes: 45 },
  { stage: "DEEP", minutes: 35 },
  { stage: "REM", minutes: 20 },
  { stage: "AWAKE", minutes: 0.5 },
  { stage: "CORE", minutes: 50 },
  { stage: "DEEP", minutes: 40 },
  { stage: "REM", minutes: 45 },
  { stage: "AWAKE", minutes: 4 },
  { stage: "CORE", minutes: 30 },
  { stage: "REM", minutes: 25 },
  { stage: "CORE", minutes: 35 },
];
const ASLEEP_PER_NIGHT = 420;
const NIGHTS = 6;

async function seed() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "sleep-per-night",
      email: "sleep-per-night@example.test",
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  // Anchored a day back: the latest night then ends yesterday morning, so
  // no segment lies after the run's clock, whatever hour the suite runs at.
  // Anchored on today, the latest night ran until about 05:30 UTC and a run
  // between midnight and then saw it only in part.
  const today = new Date(Date.now() - DAY_MS);
  today.setUTCHours(0, 0, 0, 0);
  const rows: Array<{
    userId: string;
    type: "SLEEP_DURATION";
    value: number;
    unit: string;
    source: "APPLE_HEALTH";
    deviceType: string;
    sleepStage: Stage;
    measuredAt: Date;
  }> = [];
  for (let n = 1; n <= NIGHTS; n++) {
    // Bedtime 22:00 UTC the evening before day `today - n + 1`.
    // Each night starts at 22:00 UTC two or more days back and ends near
    // 05:30 UTC the next morning: a night starting yesterday evening would
    // still be running for the first hours of a UTC day, and a run then saw
    // only its finished half.
    let cursor = today.getTime() - (n + 1) * DAY_MS + 22 * 60 * MIN_MS;
    const bedStart = cursor;
    for (const seg of NIGHT) {
      cursor += seg.minutes * MIN_MS;
      rows.push({
        userId: user.id,
        type: "SLEEP_DURATION",
        value: seg.minutes,
        unit: "minutes",
        source: "APPLE_HEALTH",
        deviceType: "watch",
        sleepStage: seg.stage,
        measuredAt: new Date(cursor),
      });
    }
    rows.push({
      userId: user.id,
      type: "SLEEP_DURATION",
      value: (cursor - bedStart) / MIN_MS,
      unit: "minutes",
      source: "APPLE_HEALTH",
      deviceType: "watch",
      sleepStage: "IN_BED",
      measuredAt: new Date(cursor),
    });
  }
  await prisma.measurement.createMany({ data: rows });
  return user;
}

type Summary = {
  count: number;
  latest: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  avg7: number | null;
  avg30: number | null;
};

function expectNightly(summary: Summary | undefined) {
  expect(summary).toBeDefined();
  const s = summary!;
  expect(s.count).toBe(NIGHTS);
  expect(s.latest).toBeCloseTo(ASLEEP_PER_NIGHT, 0);
  expect(s.min).toBeCloseTo(ASLEEP_PER_NIGHT, 0);
  expect(s.max).toBeCloseTo(ASLEEP_PER_NIGHT, 0);
  expect(s.mean).toBeCloseTo(ASLEEP_PER_NIGHT, 0);
  expect(s.avg7).toBeCloseTo(ASLEEP_PER_NIGHT, 0);
  expect(s.avg30).toBeCloseTo(ASLEEP_PER_NIGHT, 0);
  if (s.median !== null) expect(s.median).toBeCloseTo(ASLEEP_PER_NIGHT, 0);
}

type Get = (req: Request) => Promise<Response>;

async function route(path: string): Promise<Get> {
  if (path.startsWith("/insights/comprehensive")) {
    return (await import("@/app/api/insights/comprehensive/route"))
      .GET as unknown as Get;
  }
  return (await import("@/app/api/analytics/route")).GET as unknown as Get;
}

async function call(path: string): Promise<Record<string, unknown>> {
  const get = await route(path);
  const res = await get(new Request(`http://localhost/api${path}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe("sleep statistics per night", () => {
  it("summarises the insights overview per night, not per stage row", async () => {
    await seed();
    const body = (await call("/insights/comprehensive")) as {
      summaries: Record<string, Summary>;
    };
    expectNightly(body.summaries.SLEEP_DURATION);
  });

  it("summarises both analytics slices per night", async () => {
    await seed();
    const thick = (await call("/analytics")) as {
      summaries: Record<string, Summary>;
    };
    expectNightly(thick.summaries.SLEEP_DURATION);
    const { __resetAllCachesForTests } =
      await import("@/lib/cache/server-cache");
    __resetAllCachesForTests();
    const slim = (await call("/analytics?slice=summaries")) as {
      summaries: Record<string, Summary>;
    };
    expectNightly(slim.summaries.SLEEP_DURATION);
  });
});
