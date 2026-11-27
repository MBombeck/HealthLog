/**
 * 1.50 — the Health score page never contradicts itself, against real
 * Postgres.
 *
 * The page showed 74 with "+2 vs the previous comparable window" above a
 * history chart that said "No score was recorded in this range yet". Two
 * reads disagreed: the headline computed the score live (and recorded it on
 * the same call), the chart read the stored days, and on a day's first read
 * the chart could get there first. The "+2" came from a third place, the
 * week before computed again from today's rows, which no chart point stood
 * behind.
 *
 * These cases drive the real routes in the order a page load can take them:
 * the chart's newest point is the headline's number, and the delta is the
 * move between two of the chart's points.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { userDayKey } from "@/lib/tz/format";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const DAY = 24 * 60 * 60 * 1000;
const TZ = "Europe/Berlin";

interface History {
  points: Array<{ day: string; value: number; seamBreak: boolean }>;
}

interface Report {
  composite: { status: string; value?: { score: number } };
  delta: number | null;
  deltaReason: string | null;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  __resetAllCachesForTests();
});

/** Blood pressure, sleep and waist over the last weeks: a scored account. */
async function seedScoredAccount() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "hs-truth",
      email: "hs-truth@example.test",
      role: "USER",
      heightCm: 178,
      dateOfBirth: new Date("1985-07-09"),
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  const now = Date.now();
  const rows: Array<{
    type:
      | "BLOOD_PRESSURE_SYS"
      | "BLOOD_PRESSURE_DIA"
      | "SLEEP_DURATION"
      | "WAIST_CIRCUMFERENCE";
    value: number;
    unit: string;
    measuredAt: Date;
    sleepStage?: "ASLEEP";
  }> = [];
  for (let daysAgo = 0; daysAgo < 20; daysAgo++) {
    const at = new Date(now - daysAgo * DAY);
    rows.push(
      { type: "BLOOD_PRESSURE_SYS", value: 122, unit: "mmHg", measuredAt: at },
      { type: "BLOOD_PRESSURE_DIA", value: 78, unit: "mmHg", measuredAt: at },
    );
  }
  for (let i = 0; i < 14; i++) {
    const wake = new Date(now - i * DAY);
    wake.setUTCHours(6, 0, 0, 0);
    rows.push({
      type: "SLEEP_DURATION",
      value: 450,
      unit: "min",
      measuredAt: wake,
      sleepStage: "ASLEEP",
    });
  }
  rows.push({
    type: "WAIST_CIRCUMFERENCE",
    value: 82,
    unit: "cm",
    measuredAt: new Date(now),
  });
  await prisma.measurement.createMany({
    data: rows.map((row) => ({ ...row, userId: user.id })),
  });
  return user;
}

async function analytics(): Promise<Report> {
  const { GET } = await import("@/app/api/analytics/route");
  const res = await (GET as (req: Request) => Promise<Response>)(
    new Request("http://localhost/api/analytics"),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { healthScore: Report } }).data
    .healthScore;
}

async function history(): Promise<History> {
  const { GET } = await import("@/app/api/insights/score-history/route");
  const res = await (
    GET as (
      req: NextRequest,
      ctx: { params: Promise<Record<string, never>> },
    ) => Promise<Response>
  )(
    new NextRequest(
      "http://localhost/api/insights/score-history?score=HEALTH_SCORE&days=30",
    ),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: History }).data;
}

describe("the Health score page agrees with itself", () => {
  it("draws the headline's score on the day's first read, before the headline was asked", async () => {
    await seedScoredAccount();
    const today = userDayKey(new Date(), TZ);

    // The chart first: nothing computed, nothing stored yet today.
    const chart = await history();
    const headline = await analytics();

    expect(headline.composite.status).toBe("ok");
    expect(chart.points.at(-1)).toEqual({
      day: today,
      value: headline.composite.value!.score,
      seamBreak: false,
    });
  });

  it("names no move when the history holds no day to compare against", async () => {
    await seedScoredAccount();

    const headline = await analytics();
    const chart = await history();

    expect(headline.composite.status).toBe("ok");
    expect(headline.delta).toBeNull();
    expect(headline.deltaReason).toBe("no_previous_window");
    expect(chart.points).toHaveLength(1);
  });

  it("names the move between two of the chart's points", async () => {
    const user = await seedScoredAccount();
    const prisma = getPrismaClient();

    // Today's record, as the first read wrote it, gives the stored weeks the
    // same recipe and pillar set; they sit ten points lower.
    const first = await analytics();
    const todayRow = await prisma.healthScoreRecord.findFirstOrThrow({
      where: { userId: user.id },
    });
    for (const back of [7, 14]) {
      const at = new Date(Date.now() - back * DAY);
      await prisma.healthScoreRecord.create({
        data: {
          userId: user.id,
          dayKey: userDayKey(at, TZ),
          timezone: TZ,
          composite: first.composite.value!.score - 10,
          band: todayRow.band,
          scoreVersion: todayRow.scoreVersion,
          composition: todayRow.composition,
          pillarScores: todayRow.pillarScores ?? {},
          inputFingerprint: "b".repeat(64),
          configVersion: todayRow.configVersion,
          computedAt: at,
        },
      });
    }
    __resetAllCachesForTests();

    const headline = await analytics();
    const chart = await history();
    const newest = chart.points.at(-1)!;
    const weekAgo = chart.points.find(
      (p) => p.day === userDayKey(new Date(Date.now() - 7 * DAY), TZ),
    )!;

    expect(headline.deltaReason).toBeNull();
    expect(headline.delta).toBe(10);
    expect(newest.value).toBe(headline.composite.value!.score);
    expect(headline.delta).toBe(newest.value - weekAgo.value);
  });
});
