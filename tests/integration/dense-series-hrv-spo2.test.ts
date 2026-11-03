/**
 * The per-kind series for heart-rate variability and blood oxygen follows the
 * same dense rule as pulse and glucose.
 *
 * Both used to read every raw row for any window up to 3650 days, and a ring
 * or a watch that writes them every minute overnight, or all day, makes that
 * the same unbounded read pulse had before #1023. Beyond 90 days they now fold
 * per local day; within 90 days a window of more than 10 000 readings folds
 * per local hour. A sparse account inside 90 days keeps its raw readings,
 * byte for byte, and a bucket has the shape of a reading of its kind (no
 * `valueMin` / `valueMax`, which only pulse carries).
 *
 * The doctor report applies the same rule to both: their sections are a
 * statistics row and a series, so a dense window takes the per-day path pulse
 * already takes, with exact count, minimum, maximum and latest reading.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { latestReading } from "@/lib/fhir/resources/common";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
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

const prisma = getPrismaClient();
const TZ = "Europe/Berlin";
const DENSE = "dense-hrv-spo2-owner";
const SPARSE = "sparse-hrv-spo2-owner";
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
/** Twelve days of one reading a minute: over the 10 000-row cap. */
const DENSE_ROWS = 12 * 24 * 60;

const KINDS = [
  { kind: "heartRateVariability", type: "HEART_RATE_VARIABILITY", unit: "ms" },
  { kind: "oxygenSaturation", type: "OXYGEN_SATURATION", unit: "%" },
] as const;

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const id of [DENSE, SPARSE]) {
    await prisma.user.create({ data: { id, username: id, timezone: TZ } });
    invalidateUserTimezone(id);
  }
  for (const { type, unit } of KINDS) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO measurements (
         id, user_id, type, value, unit, source, measured_at,
         created_at, updated_at, sync_version)
       SELECT $4 || lpad(g::text, 7, '0'), $1, $5::measurement_type,
         CASE WHEN $5 = 'OXYGEN_SATURATION' THEN 92 + (g % 8) ELSE 30 + (g % 40) * 0.5 END,
         $6, 'GOOGLE_HEALTH'::measurement_source,
         ($2::timestamptz AT TIME ZONE 'UTC') - (g * interval '1 minute'),
         now(), now(), 1
       FROM generate_series(0, $3::int - 1) g`,
      DENSE,
      NOW.toISOString(),
      DENSE_ROWS,
      type === "OXYGEN_SATURATION" ? "ds" : "dh",
      type,
      unit,
    );
    // A few readings a night for a month and a half.
    await prisma.measurement.createMany({
      data: Array.from({ length: 45 * 3 }, (_, i) => ({
        id: `sp-${type}-${i}`,
        userId: SPARSE,
        type,
        value: type === "OXYGEN_SATURATION" ? 94 + (i % 5) : 35 + (i % 17),
        unit,
        source: "MANUAL" as const,
        measuredAt: new Date(
          NOW.getTime() - Math.floor(i / 3) * 86_400_000 - (i % 3) * 7_200_000,
        ),
      })),
    });
  }
  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
}, 120_000);

async function series(userId: string, kind: string, days: number) {
  const s = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
  const { GET } = await import("@/app/api/measurements/series/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/measurements/series?kind=${kind}&days=${days}`,
    ),
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      data: {
        unit: string;
        points: Array<Record<string, unknown> & { id: string; value: number }>;
        stats: { count: number; mean: number; min: number; max: number };
      };
    }
  ).data;
}

describe.each(KINDS)("$kind series", ({ kind, type, unit }) => {
  it("sends a dense stream inside 90 days as hour buckets", async () => {
    const data = await series(DENSE, kind, 30);
    expect(data.unit).toBe(unit);
    expect(data.points.length).toBeLessThanOrEqual(12 * 24 + 2);
    expect(data.points.length).toBeGreaterThanOrEqual(12 * 24 - 2);
    expect(data.points.every((p) => p.id.startsWith("hour:"))).toBe(true);
    // A bucket has the shape of a reading of its kind.
    expect(
      data.points.every((p) => !("valueMin" in p) && !("valueMax" in p)),
    ).toBe(true);
    // Statistics stay over every reading.
    const agg = await prisma.measurement.aggregate({
      where: {
        userId: DENSE,
        type,
        measuredAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
      _count: true,
      _min: { value: true },
      _max: { value: true },
    });
    expect(data.stats.count).toBe(agg._count);
    expect(data.stats.min).toBe(agg._min.value);
    expect(data.stats.max).toBe(agg._max.value);
  });

  it("folds the long ranges per local day", async () => {
    const data = await series(SPARSE, kind, 3650);
    expect(data.points.length).toBeGreaterThan(40);
    expect(data.points.length).toBeLessThanOrEqual(46);
    expect(data.points.every((p) => p.id.startsWith("day:"))).toBe(true);
    expect(data.stats.count).toBe(45 * 3);
  });

  it("keeps a sparse series inside 90 days raw", async () => {
    const data = await series(SPARSE, kind, 30);
    const raw = await prisma.measurement.findMany({
      where: {
        userId: SPARSE,
        type,
        measuredAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
      orderBy: { measuredAt: "asc" },
      select: { id: true, value: true, measuredAt: true },
    });
    expect(data.points).toEqual(
      raw.map((r) => ({
        id: r.id,
        at: r.measuredAt.toISOString(),
        value: r.value,
        secondary: null,
      })),
    );
  });
});

describe.each(KINDS)("doctor report $type", ({ type }) => {
  async function report(userId: string, days: number) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    return collectDoctorReportData(
      userId,
      { start, end, days },
      selectionFromLeaves([type]),
    );
  }

  it("folds a dense window to one point per day, statistics exact", async () => {
    const data = await report(DENSE, 30);
    const points = data.measurements[type] ?? [];
    expect(points.length).toBeLessThanOrEqual(14);
    expect(points.length).toBeGreaterThanOrEqual(12);
    const agg = await prisma.measurement.aggregate({
      where: { userId: DENSE, type },
      _count: true,
      _avg: { value: true },
      _min: { value: true },
      _max: { value: true },
    });
    expect(data.stats[type]?.count).toBe(agg._count);
    expect(data.stats[type]?.min).toBe(agg._min.value);
    expect(data.stats[type]?.max).toBe(agg._max.value);
    expect(data.stats[type]?.avg).toBeCloseTo(agg._avg.value ?? 0, 9);
    const newest = await prisma.measurement.findFirstOrThrow({
      where: { userId: DENSE, type },
      orderBy: { measuredAt: "desc" },
      select: { value: true, measuredAt: true },
    });
    expect(latestReading(data, type)).toEqual({
      value: newest.value,
      measuredAt: newest.measuredAt.toISOString(),
    });
  });

  it("keeps a sparse window raw", async () => {
    const data = await report(SPARSE, 30);
    const count = await prisma.measurement.count({
      where: {
        userId: SPARSE,
        type,
        measuredAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
    });
    expect(data.measurements[type]).toHaveLength(count);
    expect(data.stats[type]?.count).toBe(count);
  });

  it("folds a window longer than 90 days per day", async () => {
    const data = await report(SPARSE, 120);
    expect(data.stats[type]?.count).toBe(45 * 3);
    expect((data.measurements[type] ?? []).length).toBeLessThanOrEqual(46);
  });
});
