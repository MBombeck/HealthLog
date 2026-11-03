/**
 * The per-kind glucose series inside the 90-day raw window, on a continuous
 * sensor stream.
 *
 * Past 90 days glucose already folded per day in SQL. Inside it, a sensor
 * reading every five minutes sent every row raw: 26 000 points in 90 days,
 * the same class as the per-minute heart-rate stream in
 * `dense-pulse-raw-window-reads.test.ts`. Over the row cap the series now
 * folds per local hour; a fingerstick meter stays far under it and keeps its
 * exact old shape.
 *
 * The doctor report deliberately keeps glucose raw inside 90 days: its
 * clinical panel (time in range, GMI, CV and the risk indices) is computed
 * from the raw readings of every source, and the day path computes it from
 * canonical-source day buckets, which is not the same figure when a meter and
 * a sensor overlap. The last case pins that the panel is still the raw
 * engine's answer.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { convertGlucose } from "@/lib/glucose";
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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const prisma = getPrismaClient();
const TZ = "America/New_York";
const DENSE = "dense-glucose-owner";
const SPARSE = "sparse-glucose-owner";
/** Forty days of one reading every five minutes: over the raw-window cap. */
const DENSE_ROWS = 40 * 288;
const NOW = new Date(Math.floor(Date.now() / 300_000) * 300_000 - 300_000);

/** A fingerstick meter: a handful of readings a day at irregular times. */
function sparseReadings(): Array<{ at: Date; value: number }> {
  const out: Array<{ at: Date; value: number }> = [];
  for (let day = 1; day <= 30; day++) {
    const perDay = 2 + (day % 4);
    for (let i = 0; i < perDay; i++) {
      out.push({
        at: new Date(
          NOW.getTime() - day * 86_400_000 + (i * 211 + day * 17) * 60_000,
        ),
        value: 78 + ((day * 13 + i * 29) % 120),
      });
    }
  }
  return out;
}

async function session(userId: string): Promise<void> {
  const s = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: DENSE, username: DENSE, timezone: TZ, glucoseUnit: "mmol/L" },
  });
  await prisma.user.create({
    data: { id: SPARSE, username: SPARSE, timezone: TZ },
  });
  invalidateUserTimezone(DENSE);
  invalidateUserTimezone(SPARSE);
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at,
       created_at, updated_at, sync_version)
     SELECT 'cg' || lpad(g::text, 7, '0'), $1, 'BLOOD_GLUCOSE'::measurement_type,
       62 + ((g * 37) % 170), 'mg/dL', 'NIGHTSCOUT'::measurement_source,
       ($2::timestamptz AT TIME ZONE 'UTC') - (g * interval '5 minutes'),
       now(), now(), 1
     FROM generate_series(0, $3::int - 1) g`,
    DENSE,
    NOW.toISOString(),
    DENSE_ROWS,
  );
  await prisma.measurement.createMany({
    data: sparseReadings().map((r, i) => ({
      id: `fs${String(i).padStart(4, "0")}`,
      userId: SPARSE,
      type: "BLOOD_GLUCOSE" as const,
      value: r.value,
      unit: "mg/dL",
      source: "MANUAL" as const,
      measuredAt: r.at,
    })),
  });
  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
}, 120_000);

async function series(userId: string, days: number) {
  await session(userId);
  const { GET } = await import("@/app/api/measurements/series/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/measurements/series?kind=glucose&days=${days}`,
    ),
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      data: {
        unit: string;
        points: Array<Record<string, unknown> & { id: string; at: string }>;
        stats: {
          count: number;
          mean: number;
          min: number;
          max: number;
          stdDev: number;
        };
      };
    }
  ).data;
}

describe("per-kind glucose series inside the raw window", () => {
  it("sends a sensor stream as hour buckets in the user's unit, statistics over every reading", async () => {
    const data = await series(DENSE, 90);
    const rows = await prisma.measurement.findMany({
      where: { userId: DENSE, type: "BLOOD_GLUCOSE" },
      select: { value: true, measuredAt: true },
    });
    expect(rows).toHaveLength(DENSE_ROWS);

    // Forty days of hours, give or take the partial hours at either end.
    expect(data.points.length).toBeLessThanOrEqual(40 * 24 + 2);
    expect(data.points.length).toBeGreaterThanOrEqual(40 * 24 - 2);
    expect(data.points.every((p) => p.id.startsWith("hour:"))).toBe(true);
    expect(data.unit).toBe("mmol/L");

    // Every bucket is the mean of its hour's readings, converted once. New
    // York sits a whole number of hours off UTC, so its local hours are UTC
    // hours.
    const byHour = new Map<number, number[]>();
    for (const r of rows) {
      const hour = Math.floor(r.measuredAt.getTime() / 3_600_000) * 3_600_000;
      (byHour.get(hour) ?? byHour.set(hour, []).get(hour)!).push(r.value);
    }
    for (const p of data.points) {
      const values = byHour.get(new Date(p.at).getTime());
      expect(values, p.at).toBeDefined();
      const mean = values!.reduce((a, b) => a + b, 0) / values!.length;
      expect(p).toEqual({
        id: `hour:${p.at}`,
        at: p.at,
        value: convertGlucose(mean, "mmol/L"),
        secondary: null,
      });
    }

    const values = rows.map((r) => r.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(data.stats.count).toBe(DENSE_ROWS);
    expect(data.stats.min).toBe(convertGlucose(Math.min(...values), "mmol/L"));
    expect(data.stats.max).toBe(convertGlucose(Math.max(...values), "mmol/L"));
    expect(data.stats.mean).toBe(
      convertGlucose(Math.round(mean * 100) / 100, "mmol/L"),
    );
  });

  it("keeps fingerstick readings raw, one point per reading", async () => {
    const data = await series(SPARSE, 90);
    const expected = sparseReadings()
      .map((r, i) => ({
        id: `fs${String(i).padStart(4, "0")}`,
        at: r.at.toISOString(),
        value: r.value,
        secondary: null,
      }))
      .sort((a, b) => a.at.localeCompare(b.at));
    expect(data.unit).toBe("mg/dL");
    expect(data.points).toEqual(expected);
    expect(data.stats.count).toBe(expected.length);
  });
});

describe("doctor report keeps glucose raw inside the raw window", () => {
  it("computes the clinical panel from every raw reading", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 86_400_000);
    const data = await collectDoctorReportData(
      DENSE,
      { start, end, days: 60 },
      selectionFromLeaves(["BLOOD_GLUCOSE", "GLUCOSE_PANEL"]),
    );
    const rows = await prisma.measurement.findMany({
      where: {
        userId: DENSE,
        type: "BLOOD_GLUCOSE",
        measuredAt: { gte: start, lte: end },
      },
      orderBy: { measuredAt: "asc" },
      select: { value: true, measuredAt: true },
    });
    expect(data.measurements.BLOOD_GLUCOSE).toHaveLength(rows.length);
    expect(data.glucoseClinical).toEqual(
      computeGlucoseClinicalMetrics(
        rows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
        { windowDays: 60, now: end },
      ),
    );
  });
});
