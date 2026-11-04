/**
 * #1023 — three reads inside the 90-day raw window, on a dense pulse stream.
 *
 * Past 90 days every pulse reader already folded in SQL. Inside it, three
 * still read every raw heart-rate row: the insights page's resting-pulse
 * proxy, the per-kind series the iOS chart draws, and the doctor report. On
 * a watch that records a reading a minute that is 130 000 rows per read; on
 * the reproduction fixture (1.3 M rows) the insights page blocked the event
 * loop for 1.3 s, the 90-day series answered with 14.7 MB of JSON and the
 * 90-day report held 6.9 MB of pulse points it would draw as one sparkline.
 *
 * Each case here runs on real Postgres against two accounts: a dense one (one
 * reading a minute) and a sparse one (a cuff and a few readings a day), so
 * the tests pin both that the dense stream folds and that sparse data keeps
 * exactly its old shape.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { deriveRestingProxyFromPulse } from "@/lib/analytics/resting-pulse";
import { readRestingPulseProxy } from "@/lib/analytics/resting-pulse-read";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { latestReading } from "@/lib/fhir/resources/common";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
import { userDayKey } from "@/lib/tz/format";
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
const DENSE = "dense-raw-window-owner";
const SPARSE = "sparse-raw-window-owner";
/** Ten days of one reading a minute: over every raw-window row cap. */
const DENSE_ROWS = 10 * 24 * 60;
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);

/**
 * A cuff and a watch that samples a few times a day: irregular times, values
 * with fractional percentiles, one day with too few readings for the proxy,
 * and days that straddle the New York midnight in UTC.
 */
function sparseReadings(): Array<{ at: Date; value: number }> {
  const out: Array<{ at: Date; value: number }> = [];
  for (let day = 1; day <= 20; day++) {
    const perDay = day === 7 ? 2 : 3 + (day % 5);
    for (let i = 0; i < perDay; i++) {
      out.push({
        at: new Date(
          NOW.getTime() - day * 86_400_000 + (i * 197 + day * 13) * 60_000,
        ),
        value: 52 + ((day * 7 + i * 11) % 41) + (i % 2 ? 0.5 : 0),
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
  for (const id of [DENSE, SPARSE]) {
    await prisma.user.create({ data: { id, username: id, timezone: TZ } });
    invalidateUserTimezone(id);
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at,
       created_at, updated_at, sync_version)
     SELECT 'dr' || lpad(g::text, 7, '0'), $1, 'PULSE'::measurement_type,
       55 + (g % 50), 'bpm', 'GOOGLE_HEALTH'::measurement_source,
       ($2::timestamptz AT TIME ZONE 'UTC') - (g * interval '1 minute'),
       now(), now(), 1
     FROM generate_series(0, $3::int - 1) g`,
    DENSE,
    NOW.toISOString(),
    DENSE_ROWS,
  );
  await prisma.measurement.createMany({
    data: sparseReadings().map((r, i) => ({
      id: `sp${String(i).padStart(4, "0")}`,
      userId: SPARSE,
      type: "PULSE" as const,
      value: r.value,
      unit: "bpm",
      source: "MANUAL" as const,
      measuredAt: r.at,
    })),
  });
  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
}, 120_000);

describe("resting-pulse proxy folded in Postgres", () => {
  it("returns the in-memory derivation's series exactly", async () => {
    const since = new Date(NOW.getTime() - 90 * 86_400_000);
    for (const userId of [SPARSE, DENSE]) {
      const raw = await prisma.measurement.findMany({
        where: { userId, type: "PULSE", measuredAt: { gte: since } },
        select: { measuredAt: true, value: true },
      });
      const expected = deriveRestingProxyFromPulse(raw, (d) =>
        userDayKey(d, TZ),
      );
      const actual = await readRestingPulseProxy({
        userId,
        since,
        timeZone: TZ,
      });
      expect(actual.length).toBeGreaterThan(0);
      expect(actual).toEqual(expected);
    }
  });

  it("is what the insights page reads, not the raw stream", async () => {
    await session(DENSE);
    const spy = vi.spyOn(prisma.measurement, "findMany");
    try {
      const { GET } = await import("@/app/api/insights/comprehensive/route");
      // The route reads no request field, so its handler is typed without one.
      const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
      const res = await callGet(
        new NextRequest("http://localhost/api/insights/comprehensive"),
      );
      expect(res.status).toBe(200);
      const pulseReads = spy.mock.calls.filter(
        ([args]) =>
          (args as { where?: { type?: unknown } } | undefined)?.where?.type ===
          "PULSE",
      );
      expect(pulseReads).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("per-kind pulse series inside the raw window", () => {
  async function series(userId: string, days: number) {
    await session(userId);
    const { GET } = await import("@/app/api/measurements/series/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/measurements/series?kind=pulse&days=${days}`,
      ),
    );
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        data: {
          points: Array<{
            id: string;
            at: string;
            value: number;
            valueMin?: number | null;
            valueMax?: number | null;
          }>;
          stats: { count: number; min: number; max: number };
        };
      }
    ).data;
  }

  it("sends a dense stream as hour buckets with its full range", async () => {
    const data = await series(DENSE, 30);
    // Ten days of hours, give or take the partial hours at either end.
    expect(data.points.length).toBeLessThanOrEqual(10 * 24 + 2);
    expect(data.points.length).toBeGreaterThanOrEqual(10 * 24 - 2);
    expect(data.points.every((p) => p.id.startsWith("hour:"))).toBe(true);
    expect(data.stats.count).toBe(DENSE_ROWS);
    expect(Math.min(...data.points.map((p) => p.valueMin ?? Infinity))).toBe(
      data.stats.min,
    );
    expect(Math.max(...data.points.map((p) => p.valueMax ?? -Infinity))).toBe(
      data.stats.max,
    );
  });

  it("keeps sparse readings raw, one point per reading", async () => {
    const data = await series(SPARSE, 30);
    expect(data.points).toHaveLength(sparseReadings().length);
    expect(data.points.every((p) => p.id.startsWith("sp"))).toBe(true);
  });
});

describe("doctor report inside the raw window", () => {
  async function report(userId: string, days: number) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    return collectDoctorReportData(
      userId,
      { start, end, days },
      selectionFromLeaves(["PULSE"]),
    );
  }

  it("folds a dense pulse stream to one point per day, statistics exact", async () => {
    const data = await report(DENSE, 30);
    const points = data.measurements.PULSE ?? [];
    expect(points.length).toBeLessThanOrEqual(12);
    expect(points.length).toBeGreaterThanOrEqual(10);
    expect(data.stats.PULSE?.count).toBe(DENSE_ROWS);
    // The export's latest observation is the newest reading itself.
    const newest = await prisma.measurement.findFirstOrThrow({
      where: { userId: DENSE, type: "PULSE" },
      orderBy: { measuredAt: "desc" },
      select: { value: true, measuredAt: true },
    });
    expect(latestReading(data, "PULSE")).toEqual({
      value: newest.value,
      measuredAt: newest.measuredAt.toISOString(),
    });
  });

  it("keeps sparse readings raw", async () => {
    const data = await report(SPARSE, 30);
    expect(data.measurements.PULSE).toHaveLength(sparseReadings().length);
    expect(data.stats.PULSE?.count).toBe(sparseReadings().length);
  });
});
