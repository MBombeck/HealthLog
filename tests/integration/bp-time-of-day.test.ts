/**
 * Blood pressure by part of the day (#1331), through the real routes.
 *
 * Against Postgres:
 *   - the summary route pairs systolic and diastolic as the series does,
 *     buckets them by the hour in the record's own zone, holds back a mean
 *     below the reading floor, and takes the pulse of the reading's own
 *     source only;
 *   - a reading after midnight is an evening reading, and the narrowed chart
 *     series puts it on the evening before;
 *   - readings outside the window and another account's readings stay out;
 *   - `partOfDay` on the chart's series read narrows each day to the part,
 *     and is refused on any other read.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";
import { invalidateUserTimezone } from "@/lib/tz/resolver";
import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import {
  openEndedFetchWindow,
  localDayKeyFor,
} from "@/lib/charts/fetch-window";

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

const prisma = getPrismaClient();
const TZ = "Europe/Berlin";
const OWNER = "bptod-owner";
const OTHER = "bptod-other";

const today = wallClockInTz(new Date(), TZ);
/** The local wall clock `hour:minute` on the day `daysBack` before today. */
function localAt(daysBack: number, hour: number, minute = 0): Date {
  const d = new Date(
    Date.UTC(today.year, today.month - 1, today.day - daysBack),
  );
  return zonedWallClockToUtc(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour,
      minute,
    },
    TZ,
  );
}

let seq = 0;
function row(
  userId: string,
  type: MeasurementType,
  value: number,
  measuredAt: Date,
  source: MeasurementSource = "MANUAL",
): Prisma.MeasurementCreateManyInput {
  return {
    id: `bptod-${++seq}`,
    userId,
    type,
    unit: type === "PULSE" ? "bpm" : "mmHg",
    source,
    value,
    measuredAt,
  };
}
function bp(
  userId: string,
  at: Date,
  sys: number,
  dia: number,
  pulse?: number,
): Prisma.MeasurementCreateManyInput[] {
  const rows = [
    row(userId, "BLOOD_PRESSURE_SYS", sys, at),
    row(userId, "BLOOD_PRESSURE_DIA", dia, at),
  ];
  if (pulse !== undefined) rows.push(row(userId, "PULSE", pulse, at));
  return rows;
}

async function signIn(userId: string) {
  const s = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
}

interface Summary {
  days: number;
  timeZone: string;
  minReadings: number;
  readingCount: number;
  parts: Array<{
    part: string;
    startHour: number;
    endHour: number;
    readingCount: number;
    systolic: number | null;
    diastolic: number | null;
    pulseReadingCount: number;
    pulse: number | null;
  }>;
  morningEveningDifference: { systolic: number; diastolic: number } | null;
}

async function summary(query: string) {
  const { GET } =
    await import("@/app/api/measurements/blood-pressure/time-of-day/route");
  return GET(
    new NextRequest(
      `http://localhost/api/measurements/blood-pressure/time-of-day?${query}`,
    ),
  );
}

async function series(type: MeasurementType, days: number, partOfDay?: string) {
  const window = openEndedFetchWindow(days, localDayKeyFor(new Date(), TZ), TZ);
  const params = new URLSearchParams({
    type,
    aggregate: "daily",
    source: "rollup",
    from: window.from,
    to: window.to,
    limit: "5000",
  });
  if (partOfDay) params.set("partOfDay", partOfDay);
  const { GET } = await import("@/app/api/measurements/route");
  return GET(new NextRequest(`http://localhost/api/measurements?${params}`));
}

/** The local day key a series row stands for. */
const dayKeyOf = (iso: string) => localDayKeyFor(new Date(iso), TZ);
const dayKeyBack = (n: number) => localDayKeyFor(localAt(n, 12), TZ);

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const id of [OWNER, OTHER]) {
    await prisma.user.create({ data: { id, username: id, timezone: TZ } });
    invalidateUserTimezone(id);
  }
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  for (const d of [1, 2, 3, 4, 5, 6]) {
    rows.push(...bp(OWNER, localAt(d, 7, 30), 140, 90, 72));
    rows.push(...bp(OWNER, localAt(d, 21), 128, 80, 66));
    // A watch's heart-rate row from another source beside the evening
    // reading: never the reading's pulse.
    rows.push(row(OWNER, "PULSE", 120, localAt(d, 21, 1), "APPLE_HEALTH"));
  }
  // Two midday readings: below the floor.
  rows.push(...bp(OWNER, localAt(2, 13), 120, 70));
  rows.push(...bp(OWNER, localAt(3, 13), 122, 72));
  // A late bedtime reading at 01:15 after the evening of day 3 back.
  rows.push(...bp(OWNER, localAt(2, 1, 15), 150, 95));
  // It carries no pulse of its own; a watch's row of another source a minute
  // later must not stand in for one.
  rows.push(row(OWNER, "PULSE", 120, localAt(2, 1, 16), "APPLE_HEALTH"));
  // Half a reading (no diastolic): not a pair.
  rows.push(row(OWNER, "BLOOD_PRESSURE_SYS", 200, localAt(4, 8)));
  // Outside a 7-day window.
  rows.push(...bp(OWNER, localAt(10, 7, 30), 180, 110));
  // Another account's morning.
  rows.push(...bp(OTHER, localAt(1, 7, 30), 100, 60));
  await prisma.measurement.createMany({ data: rows });
});

describe("GET /api/measurements/blood-pressure/time-of-day", () => {
  it("resolves the three parts, the floor and the difference", async () => {
    await signIn(OWNER);
    const res = await summary("days=7");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Summary };
    expect(data.timeZone).toBe(TZ);
    expect(data.days).toBe(7);
    expect(data.minReadings).toBe(3);
    // 6 mornings + 2 middays + 6 evenings + the 01:15 one; the half reading,
    // the old one and the other account's are out.
    expect(data.readingCount).toBe(15);
    const [morning, midday, evening] = data.parts;
    expect(morning).toEqual({
      part: "morning",
      startHour: 4,
      endHour: 12,
      readingCount: 6,
      systolic: 140,
      diastolic: 90,
      pulseReadingCount: 6,
      pulse: 72,
    });
    expect(midday).toMatchObject({
      part: "midday",
      readingCount: 2,
      systolic: null,
      diastolic: null,
    });
    // (6 × 128 + 150) / 7 = 131.1, (6 × 80 + 95) / 7 = 82.1; the 01:15 reading
    // carries no pulse and the watch rows of another source are not taken.
    expect(evening).toEqual({
      part: "evening",
      startHour: 18,
      endHour: 4,
      readingCount: 7,
      systolic: 131,
      diastolic: 82,
      pulseReadingCount: 6,
      pulse: 66,
    });
    expect(data.morningEveningDifference).toEqual({
      systolic: 9,
      diastolic: 8,
    });
  });

  it("sees only the signed-in record", async () => {
    await signIn(OTHER);
    const { data } = (await (await summary("days=7")).json()) as {
      data: Summary;
    };
    expect(data.readingCount).toBe(1);
    expect(data.parts[0].readingCount).toBe(1);
    expect(data.parts[0].systolic).toBeNull();
    expect(data.morningEveningDifference).toBeNull();
  });

  it("refuses a window it does not serve", async () => {
    await signIn(OWNER);
    expect((await summary("days=0")).status).toBe(422);
    expect((await summary("days=abc")).status).toBe(422);
  });
});

describe("GET /api/measurements?partOfDay=", () => {
  it("narrows the evening series and puts an after-midnight reading on the evening before", async () => {
    await signIn(OWNER);
    const res = await series("BLOOD_PRESSURE_SYS", 7, "evening");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        measurements: Array<{
          value: number;
          measuredAt: string;
          count: number;
        }>;
        meta: { partOfDay?: string };
      };
    };
    expect(body.data.meta.partOfDay).toBe("evening");
    const byDay = new Map(
      body.data.measurements.map((m) => [dayKeyOf(m.measuredAt), m]),
    );
    expect(byDay.size).toBe(6);
    expect(byDay.get(dayKeyBack(3))).toMatchObject({ value: 139, count: 2 });
    expect(byDay.get(dayKeyBack(2))).toMatchObject({ value: 128, count: 1 });
  });

  it("narrows the morning series to the morning readings", async () => {
    await signIn(OWNER);
    const body = (await (
      await series("BLOOD_PRESSURE_SYS", 7, "morning")
    ).json()) as {
      data: { measurements: Array<{ value: number; measuredAt: string }> };
    };
    const values = new Map(
      body.data.measurements.map((m) => [dayKeyOf(m.measuredAt), m.value]),
    );
    expect(values.size).toBe(6);
    // The chart series is per type, like the whole-day chart: the half
    // reading's systolic draws on its morning.
    expect(values.get(dayKeyBack(4))).toBe(170);
    expect(values.get(dayKeyBack(1))).toBe(140);
  });

  it("answers an empty part with an empty series, not the whole day", async () => {
    await signIn(OTHER);
    const body = (await (
      await series("BLOOD_PRESSURE_SYS", 7, "evening")
    ).json()) as {
      data: { measurements: unknown[] };
    };
    expect(body.data.measurements).toEqual([]);
  });

  it("leaves the whole-day series as it was", async () => {
    await signIn(OWNER);
    const body = (await (await series("BLOOD_PRESSURE_SYS", 7)).json()) as {
      data: { measurements: Array<{ measuredAt: string; count: number }> };
    };
    const day2 = body.data.measurements.find(
      (m) => dayKeyOf(m.measuredAt) === dayKeyBack(2),
    );
    // Morning, midday, evening and the 01:15 reading of its own calendar day.
    expect(day2?.count).toBe(4);
  });

  it("narrows the long range on weekly buckets", async () => {
    await signIn(OWNER);
    const res = await series("BLOOD_PRESSURE_SYS", 3650, "morning");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { measurements: Array<{ value: number; count: number }> };
    };
    const total = body.data.measurements.reduce((n, m) => n + m.count, 0);
    // Seven mornings in the window, the old one included, plus the half one.
    expect(total).toBe(8);
  });

  it("refuses it on a series it does not narrow", async () => {
    await signIn(OWNER);
    expect((await series("WEIGHT", 7, "morning")).status).toBe(422);
  });
});
