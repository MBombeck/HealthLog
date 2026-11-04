/**
 * v1.11.5 — SLEEP_DURATION list collapse.
 *
 * `GET /api/measurements?type=SLEEP_DURATION` is stored one row per stage
 * per night. The list route now collapses those raw stage rows into one
 * synthetic row per night (TIME ASLEEP), with a `dayKey` drill-down to the
 * night's stage segments. This locks the leak closure end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface ListEnvelope {
  data: {
    measurements: Array<{
      id: string;
      type: string;
      value: number;
      unit: string;
      dayKey?: string;
      sampleCount?: number;
      sleepStage?: string | null;
      napCount?: number;
      mainAsleepMinutes?: number | null;
      awakenings?: number;
    }>;
    meta: { total: number; groupBy?: string; windowFrom?: string };
  };
}

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test`, role: "USER" },
  });
  const session = await prisma.session.create({
    // An hour, not a minute: walking every page of a long history can
    // outlast a minute on a loaded runner, and an expired session reads as
    // a 401 halfway through.
    data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function callList(query: string): Promise<Response> {
  const { GET } = await import("@/app/api/measurements/route");
  return GET(new NextRequest(`http://localhost/api/measurements?${query}`));
}

describe("GET /api/measurements?type=SLEEP_DURATION", () => {
  it("collapses raw stage rows into one row per night", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-list-user");

    // Recent night so the trailing-year window includes it. Contiguous
    // stage rows ending this morning (Berlin default tz).
    const wakeBase = new Date();
    wakeBase.setUTCHours(4, 0, 0, 0);
    const seed = async (
      stage: "CORE" | "DEEP" | "REM",
      min: number,
      offsetMin: number,
    ) =>
      prisma.measurement.create({
        data: {
          userId: user.id,
          type: "SLEEP_DURATION",
          value: min,
          unit: "minutes",
          source: "APPLE_HEALTH",
          measuredAt: new Date(wakeBase.getTime() - offsetMin * 60_000),
          externalId: `uuid-${stage}`,
          sleepStage: stage,
        },
      });
    // CORE 240 (ends -180), DEEP 120 (ends -60), REM 60 (ends 0).
    await seed("CORE", 240, 180);
    await seed("DEEP", 120, 60);
    await seed("REM", 60, 0);

    const res = await callList("type=SLEEP_DURATION");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEnvelope;
    // ONE per-night row, not three stage rows.
    expect(body.data.measurements).toHaveLength(1);
    const row = body.data.measurements[0];
    // value = TIME ASLEEP = 240 + 120 + 60 = 420 min.
    expect(row.value).toBe(420);
    expect(row.dayKey).toBeDefined();
    expect(body.data.meta.groupBy).toBe("night");
  });

  it("drills down to the night's stage segments via dayKey", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-drill-user");

    const wakeBase = new Date();
    wakeBase.setUTCHours(4, 0, 0, 0);
    const seed = async (
      stage: "CORE" | "DEEP" | "REM",
      min: number,
      offsetMin: number,
    ) =>
      prisma.measurement.create({
        data: {
          userId: user.id,
          type: "SLEEP_DURATION",
          value: min,
          unit: "minutes",
          source: "APPLE_HEALTH",
          measuredAt: new Date(wakeBase.getTime() - offsetMin * 60_000),
          externalId: `uuid-${stage}`,
          sleepStage: stage,
        },
      });
    await seed("CORE", 240, 180);
    await seed("DEEP", 120, 60);
    await seed("REM", 60, 0);

    // First get the per-night row to learn its dayKey.
    const nightRes = await callList("type=SLEEP_DURATION");
    const nightBody = (await nightRes.json()) as ListEnvelope;
    const dayKey = nightBody.data.measurements[0].dayKey!;

    const res = await callList(`type=SLEEP_DURATION&dayKey=${dayKey}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEnvelope;
    // The drill-down returns the three stage segments.
    expect(body.data.measurements).toHaveLength(3);
    const stages = body.data.measurements.map((m) => m.sleepStage).sort();
    expect(stages).toEqual(["CORE", "DEEP", "REM"]);
  });

  it("pages over every night of a long history in SQL, with no year cut", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-paging-user");
    const day = 86_400_000;
    const morning = new Date();
    morning.setUTCHours(4, 0, 0, 0);
    const NIGHTS = 730;
    const dayKeyOf = (d: Date) => d.toISOString().slice(0, 10);
    // One night of a single CORE stage every day for two years. Every
    // seventh day also carries an afternoon nap, which is not a night of its
    // own, and every eleventh an in-bed-only evening (more than the session
    // gap from both the nap and the night), which holds no sleep and must
    // not count as a night either.
    const rows: Array<{
      userId: string;
      type: "SLEEP_DURATION";
      value: number;
      unit: string;
      source: "APPLE_HEALTH";
      measuredAt: Date;
      externalId: string;
      sleepStage: "CORE" | "IN_BED";
    }> = [];
    for (let i = 0; i < NIGHTS; i++) {
      const wake = new Date(morning.getTime() - i * day);
      const base = {
        userId: user.id,
        type: "SLEEP_DURATION" as const,
        unit: "minutes",
        source: "APPLE_HEALTH" as const,
      };
      rows.push({
        ...base,
        value: 420,
        measuredAt: wake,
        externalId: `uuid-night-${i}`,
        sleepStage: "CORE",
      });
      if (i % 7 === 0) {
        rows.push({
          ...base,
          value: 30,
          measuredAt: new Date(wake.getTime() + 10 * 3_600_000),
          externalId: `uuid-nap-${i}`,
          sleepStage: "CORE",
        });
      }
      if (i % 11 === 5) {
        rows.push({
          ...base,
          value: 20,
          measuredAt: new Date(wake.getTime() - 10.5 * 3_600_000),
          externalId: `uuid-inbed-${i}`,
          sleepStage: "IN_BED",
        });
      }
    }
    await prisma.measurement.createMany({ data: rows });

    const spy = vi.spyOn(prisma.measurement, "findMany");
    const first = await callList("type=SLEEP_DURATION&limit=25");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ListEnvelope;
    expect(firstBody.data.meta.total).toBe(NIGHTS);
    expect(firstBody.data.meta.windowFrom).toBeUndefined();
    expect(firstBody.data.measurements).toHaveLength(25);
    expect(firstBody.data.measurements[0].dayKey).toBe(dayKeyOf(morning));
    // The day's sleep counts the nap; the main night rides beside it.
    expect(firstBody.data.measurements[0].value).toBe(450);
    expect(firstBody.data.measurements[0].mainAsleepMinutes).toBe(420);
    expect(firstBody.data.measurements[0].napCount).toBe(1);
    // The stage read covered the page's nights, not the history.
    const read = spy.mock.calls
      .map(
        ([args]) =>
          args as {
            where?: { AND?: Array<{ measuredAt?: { gte?: Date } }> };
          },
      )
      .find((args) => args?.where?.AND?.[0]?.measuredAt?.gte);
    const readFrom = read!.where!.AND![0].measuredAt!.gte!.getTime();
    expect(morning.getTime() - readFrom).toBeLessThan(26 * day);

    // Walk every page: each night exactly once, newest first, back to the
    // oldest one two years ago.
    const seen: string[] = [];
    for (let offset = 0; offset < NIGHTS; offset += 100) {
      const res = await callList(
        `type=SLEEP_DURATION&limit=100&offset=${offset}`,
      );
      const body = (await res.json()) as ListEnvelope;
      expect(body.data.meta.total).toBe(NIGHTS);
      for (const row of body.data.measurements) {
        seen.push(row.dayKey!);
        expect(row.mainAsleepMinutes).toBe(420);
        expect(row.value).toBe(row.napCount ? 450 : 420);
      }
    }
    expect(seen).toHaveLength(NIGHTS);
    expect(new Set(seen).size).toBe(NIGHTS);
    expect(seen).toEqual([...seen].sort().reverse());
    const oldest = dayKeyOf(new Date(morning.getTime() - (NIGHTS - 1) * day));
    expect(seen[seen.length - 1]).toBe(oldest);

    // Past the end: an empty page that still reports the total.
    const past = (await (
      await callList(`type=SLEEP_DURATION&limit=25&offset=${NIGHTS + 25}`)
    ).json()) as ListEnvelope;
    expect(past.data.measurements).toEqual([]);
    expect(past.data.meta.total).toBe(NIGHTS);

    // Ascending starts at the oldest night; a window counts only its nights.
    const asc = (await (
      await callList("type=SLEEP_DURATION&limit=5&sortDir=asc")
    ).json()) as ListEnvelope;
    expect(asc.data.measurements[0].dayKey).toBe(oldest);
    const recent = (await (
      await callList(
        `type=SLEEP_DURATION&from=${encodeURIComponent(new Date(morning.getTime() - 10.5 * day).toISOString())}`,
      )
    ).json()) as ListEnvelope;
    expect(recent.data.meta.total).toBe(11);

    // A night older than a year still drills down.
    const drill = (await (
      await callList(`type=SLEEP_DURATION&dayKey=${oldest}`)
    ).json()) as ListEnvelope;
    expect(drill.data.measurements).toHaveLength(1);
    expect(drill.data.measurements[0].sleepStage).toBe("CORE");
  }, 240_000);

  // Review finding on the SQL paging: the page labels a session by the last
  // row of ANY writer, the reconstruction by its winning writer. A watch that
  // stops before midnight beside a phone whose in-bed span runs past it gave
  // two different days, and matching by label dropped the night from both.
  it("keeps a night whose losing writer runs past midnight", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-midnight-user");
    await prisma.user.update({
      where: { id: user.id },
      data: { timezone: "UTC" },
    });
    const base = {
      userId: user.id,
      type: "SLEEP_DURATION" as const,
      unit: "minutes",
      source: "APPLE_HEALTH" as const,
    };
    await prisma.measurement.createMany({
      data: [
        // The watch wins the device ladder and ends at 23:50.
        {
          ...base,
          value: 420,
          measuredAt: new Date("2026-03-10T23:50:00.000Z"),
          externalId: "uuid-watch-core",
          sleepStage: "CORE" as const,
          deviceType: "watch",
        },
        // The phone's in-bed span ends at 00:20 the next day.
        {
          ...base,
          value: 450,
          measuredAt: new Date("2026-03-11T00:20:00.000Z"),
          externalId: "uuid-phone-inbed",
          sleepStage: "IN_BED" as const,
          deviceType: "phone",
        },
      ],
    });

    const list = (await (
      await callList("type=SLEEP_DURATION")
    ).json()) as ListEnvelope;
    expect(list.data.meta.total).toBe(1);
    // The night is listed, not lost between two labels.
    expect(list.data.measurements).toHaveLength(1);
    const [night] = list.data.measurements;
    expect(night.value).toBe(420);

    // Its drill-down, asked by the label the list gave it, finds it too.
    const drill = (await (
      await callList(`type=SLEEP_DURATION&dayKey=${night.dayKey}`)
    ).json()) as ListEnvelope;
    expect(drill.data.measurements.map((m) => m.sleepStage)).toEqual(["CORE"]);
  });
});
