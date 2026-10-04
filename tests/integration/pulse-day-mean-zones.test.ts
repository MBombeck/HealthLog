/**
 * A day of pulse is the mean of its LOCAL hours' means, and the days are LOCAL
 * days, for a profile zone that is not UTC.
 *
 * Two zones that each break a UTC assumption:
 *
 *   - Asia/Kolkata (UTC+05:30). Its hours start at half past a UTC hour, so
 *     10:20Z, 10:25Z (both 15:5x local) and 10:40Z (16:10 local) are two local
 *     hours (100 and 40, day value 70), though one UTC hour (80). 18:45Z is
 *     already 00:15 the next local day.
 *   - Europe/Berlin. 23:30Z is the next local day, so 10:00Z, 11:00Z (three
 *     readings) and 23:30Z are two local days (100 and 40), though one UTC day
 *     (80).
 *
 * Asserted through the live per-day read the chart serves, the series route's
 * day bucket, and the shared SQL day weight every other live reader uses.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { readLiveBuckets } from "@/lib/measurements/daily-series-read";
import {
  dayWeightedRows,
  dayWeightedRowsSql,
  readingsMean,
  windowMeanSql,
  zoneDayFrame,
} from "@/lib/measurements/day-mean";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const DAY = 86_400_000;
const now = new Date();
/** A UTC midnight three weeks back: inside every window the reads use. */
const D = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate() - 21,
);
const iso = (ms: number) => new Date(ms).toISOString();
const hm = (h: number, m: number) => D + h * 3_600_000 + m * 60_000;

const KOLKATA = {
  user: "pulse-zone-kolkata",
  tz: "Asia/Kolkata",
  readings: [
    [hm(10, 20), 100],
    [hm(10, 25), 100],
    [hm(10, 40), 40],
    [hm(18, 45), 90],
  ] as const,
  /** Local days: 70 (two local hours) and 90. */
  days: [70, 90],
  /** What a UTC frame would give: one day, hours 80 and 90. */
  utcDay: 85,
};

const BERLIN = {
  user: "pulse-zone-berlin",
  tz: "Europe/Berlin",
  readings: [
    [hm(10, 0), 100],
    [hm(11, 0), 100],
    [hm(11, 10), 100],
    [hm(11, 20), 100],
    [hm(23, 30), 40],
  ] as const,
  /** Local days: 100 and 40. */
  days: [100, 40],
  /** What a UTC frame would give: one day, hours 100, 100 and 40. */
  utcDay: 80,
};

const CASES = [KOLKATA, BERLIN];

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const c of CASES) {
    await prisma.user.create({
      data: { id: c.user, username: c.user, timezone: c.tz },
    });
    invalidateUserTimezone(c.user);
    const rows: Prisma.MeasurementCreateManyInput[] = c.readings.map(
      ([at, value], i) => ({
        id: `${c.user}-${i}`,
        userId: c.user,
        type: "PULSE",
        unit: "bpm",
        source: "APPLE_HEALTH",
        value,
        measuredAt: new Date(at),
      }),
    );
    await prisma.measurement.createMany({ data: rows });
  }
}, 120_000);

describe.each(CASES)("profile zone $tz", (c) => {
  it("the TypeScript helper reads local hours and local days", () => {
    const rows = c.readings.map(([at, value]) => ({
      value,
      measuredAt: new Date(at),
    }));
    expect(readingsMean("PULSE", rows, c.tz)).toBeCloseTo(
      (c.days[0] + c.days[1]) / 2,
      9,
    );
    expect(readingsMean("PULSE", rows, "UTC")).toBeCloseTo(c.utcDay, 9);
  });

  it("the live per-day read buckets by local hour and local day", async () => {
    const rows = await readLiveBuckets({
      userId: c.user,
      type: "PULSE",
      from: new Date(D - DAY),
      to: new Date(D + 2 * DAY),
      cap: 400,
      priorityJson: null,
      grain: "daily",
      timeZone: c.tz,
    });
    expect(rows.map((r) => r.value)).toEqual(
      c.days.map((v) => expect.closeTo(v, 6)),
    );
    // Count and band stay over every reading.
    expect(rows.reduce((s, r) => s + (r.count ?? 0), 0)).toBe(
      c.readings.length,
    );
  });

  it("the shared SQL day weight gives the mean of the local days", async () => {
    const [row] = await prisma.$queryRawUnsafe<Array<{ mean: number }>>(
      `
      WITH src AS (
        SELECT * FROM measurements
        WHERE "user_id" = $1 AND "deleted_at" IS NULL
      )
      SELECT ${windowMeanSql({
        typeColumn: 'm."type"',
        value: 'm."value"',
        weight: "m.day_weight",
      })}::double precision AS mean
      FROM ${dayWeightedRows("src", zoneDayFrame("$2"))} m
      GROUP BY m."type"
    `,
      c.user,
      c.tz,
    );
    expect(row.mean).toBeCloseTo((c.days[0] + c.days[1]) / 2, 9);

    const [tagged] = await prisma.$queryRaw<Array<{ days: number }>>`
      WITH src AS (
        SELECT * FROM measurements
        WHERE "user_id" = ${c.user} AND "deleted_at" IS NULL
      )
      SELECT SUM(m.day_weight)::double precision AS days
      FROM ${dayWeightedRowsSql("src", c.tz)} m
    `;
    // Each local day's weights add up to one.
    expect(tagged.days).toBeCloseTo(2, 9);
  });

  it("the series route's day bucket is the local day of local hours", async () => {
    const s = await prisma.session.create({
      data: { userId: c.user, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.clear();
    cookieJar.set("healthlog_session", s.id);
    const { GET } = await import("@/app/api/measurements/series/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/measurements/series?kind=pulse&days=365",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        points: Array<{ id: string; value: number }>;
        stats: { mean: number; count: number };
      };
    };
    expect(body.data.points.every((p) => p.id.startsWith("day:"))).toBe(true);
    expect(body.data.points.map((p) => p.value)).toEqual(
      c.days.map((v) => expect.closeTo(v, 2)),
    );
    // The stats strip: the mean of the day values, the count of readings.
    expect(body.data.stats.mean).toBeCloseTo((c.days[0] + c.days[1]) / 2, 2);
    expect(body.data.stats.count).toBe(c.readings.length);
  });
});

it("the fixture really separates the frames", () => {
  expect(iso(hm(18, 45))).toMatch(/T18:45/);
  for (const c of CASES) {
    expect((c.days[0] + c.days[1]) / 2).not.toBeCloseTo(c.utcDay, 2);
  }
});
