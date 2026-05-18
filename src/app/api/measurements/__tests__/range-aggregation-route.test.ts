import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.4.28 R4-CODE-C1 / C2 — the `/api/measurements` route must
 * aggregate via Postgres `date_trunc` BEFORE applying the bucket cap.
 * The legacy code path `findMany({ take: limit })` then in-memory
 * bucketised — a 1-year `aggregate=daily` window would silently truncate
 * to the first N raw rows and surface only a handful of buckets.
 *
 * The route now runs a `$queryRaw` with `GROUP BY type, date_trunc(...)`
 * so the cap (`BUCKET_CAP[grain]`) applies after the bucket count is
 * known. C2 — the aggregation must NOT auto-fire on iOS callers; the
 * `aggregate` param is required to opt in.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    measurementRollup: {
      findMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "test-user", role: "USER" as const },
};

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements?${query}`, {
    method: "GET",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/measurements — aggregation gate (C2)", () => {
  it("returns raw rows when `aggregate` is omitted, even on a wide window", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "m-1",
        userId: "user-1",
        type: "PULSE",
        value: 60,
        measuredAt: new Date("2026-01-01T10:00:00.000Z"),
        source: "MANUAL",
        notes: null,
        unit: "bpm",
      },
    ] as never);
    vi.mocked(prisma.measurement.count).mockResolvedValue(1 as never);

    // A 1-year window with no `aggregate` must NOT trigger the
    // aggregation branch — iOS contract safety (R4-CODE-C2).
    const res = await GET(
      getRequest(
        "type=PULSE&from=2025-05-15T00:00:00Z&to=2026-05-15T00:00:00Z&limit=500",
      ),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { measurements: Array<unknown>; meta: { aggregate?: string } };
    };
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
    expect(json.data.meta.aggregate).toBeUndefined();
  });

  it("runs SQL aggregation when `aggregate=daily` is set and returns bucketed rows", async () => {
    // Simulate 365 daily buckets returned from the date_trunc query.
    const buckets = Array.from({ length: 365 }, (_, i) => ({
      type: "PULSE",
      bucket_start: new Date(
        Date.UTC(2025, 4, 15 + i, 0, 0, 0) - i * 0, // placeholder, monotonic
      ),
      avg: 60 + (i % 10),
      cnt: 1440, // a minute-by-minute pulse account
    }));
    vi.mocked(prisma.$queryRaw).mockResolvedValue(buckets as never);

    const res = await GET(
      getRequest(
        "type=PULSE&from=2025-05-15T00:00:00Z&to=2026-05-15T00:00:00Z&aggregate=daily&limit=5000",
      ),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        measurements: Array<{ type: string; value: number; count: number }>;
        meta: { aggregate?: string; limit: number };
      };
    };
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    // C1 — the response carries one bucket per calendar day, NOT
    // `min(limit, count)/grain`. The raw-data density (1440 rows/day)
    // is summarised in the `count` field.
    expect(json.data.measurements.length).toBe(365);
    expect(json.data.measurements[0].count).toBe(1440);
    expect(json.data.meta.aggregate).toBe("daily");
    // Bucket cap for daily is 365.
    expect(json.data.meta.limit).toBe(365);
  });

  it("caps monthly grain at the BUCKET_CAP ceiling", async () => {
    const buckets = Array.from({ length: 24 }, (_, i) => ({
      type: "WEIGHT",
      bucket_start: new Date(Date.UTC(2024, i, 1, 0, 0, 0)),
      avg: 75 + i * 0.1,
      cnt: 30,
    }));
    vi.mocked(prisma.$queryRaw).mockResolvedValue(buckets as never);

    const res = await GET(
      getRequest(
        "type=WEIGHT&from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z&aggregate=monthly&limit=5000",
      ),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { meta: { limit: number; aggregate?: string } };
    };
    expect(json.data.meta.limit).toBe(24);
    expect(json.data.meta.aggregate).toBe("monthly");
  });
});

describe("GET /api/measurements — all-time semantics (SD-H1)", () => {
  it("returns a sensible monthly series for a multi-year all-time window", async () => {
    // Simulate four years of monthly weight rollups. The fixture mirrors
    // what `date_trunc('month', measured_at)` produces server-side and
    // proves the route hands back the full history (capped at the
    // monthly BUCKET_CAP of 24 — the chart paints the most recent 24
    // months when "All time" exceeds the cap).
    const buckets = Array.from({ length: 24 }, (_, i) => ({
      type: "WEIGHT",
      bucket_start: new Date(Date.UTC(2024, i, 1, 0, 0, 0)),
      avg: 80 - i * 0.05,
      cnt: 30,
    }));
    vi.mocked(prisma.$queryRaw).mockResolvedValue(buckets as never);

    // "All time" client call: oldest measurement → today, monthly grain.
    const res = await GET(
      getRequest(
        "type=WEIGHT&from=2020-01-01T00:00:00Z&to=2026-05-15T00:00:00Z&aggregate=monthly&limit=5000",
      ),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        measurements: Array<{ measuredAt: string; count: number }>;
        meta: { aggregate?: string; total: number };
      };
    };
    // The response is monthly-bucketed (NOT a truncated 365-day slice).
    expect(json.data.meta.aggregate).toBe("monthly");
    expect(json.data.measurements.length).toBe(24);
    // Buckets cover distinct calendar months — a 365-day slice could
    // not span more than 13 months.
    const months = new Set(
      json.data.measurements.map((m) => m.measuredAt.slice(0, 7)),
    );
    expect(months.size).toBe(24);
  });

  it("source=rollup + aggregate=daily reads measurement_rollups without firing the heavy date_trunc query", async () => {
    // v1.4.36 W1 — Insights trends row routes the three daily chart
    // fetches through the persistent DAY buckets via `source=rollup`.
    // The heavy `date_trunc` $queryRaw must NOT fire on the happy
    // path where the rollup has rows for the requested window.
    const buckets = Array.from({ length: 30 }, (_, i) => ({
      type: "WEIGHT",
      bucketStart: new Date(Date.UTC(2026, 3, 16 + i, 0, 0, 0)),
      mean: 81 + i * 0.05,
      count: 5,
    }));
    vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue(
      buckets as never,
    );

    const res = await GET(
      getRequest(
        "type=WEIGHT&from=2026-04-15T00:00:00Z&to=2026-05-15T00:00:00Z&aggregate=daily&source=rollup&limit=5000",
      ),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        measurements: Array<{ type: string; value: number; count: number }>;
        meta: { aggregate?: string };
      };
    };
    expect(prisma.measurementRollup.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(json.data.measurements.length).toBe(30);
    // First bucket reflects the rollup mean — round-trip-stable.
    expect(json.data.measurements[0].type).toBe("WEIGHT");
    expect(json.data.measurements[0].value).toBeCloseTo(81, 5);
    expect(json.data.measurements[0].count).toBe(5);
    expect(json.data.meta.aggregate).toBe("daily");
  });

  it("source=rollup cumulative path reads sum_value directly (v1.4.39 W-SUM)", async () => {
    // ACTIVITY_STEPS rollup row with sum_value populated. The route
    // must consume sumValue directly — NOT reconstruct from mean *
    // count. Use a sum that is NOT mean × count so the test
    // distinguishes the two paths.
    const buckets = Array.from({ length: 3 }, (_, i) => ({
      type: "ACTIVITY_STEPS",
      bucketStart: new Date(Date.UTC(2026, 4, 1 + i, 0, 0, 0)),
      mean: 2000, // would yield 10000 if multiplied by count=5
      count: 5,
      sumValue: 11000 + i * 250, // distinct from mean × count
    }));
    vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue(
      buckets as never,
    );

    const res = await GET(
      getRequest(
        "type=ACTIVITY_STEPS&from=2026-05-01T00:00:00Z&to=2026-05-05T00:00:00Z&aggregate=daily&source=rollup&limit=5000",
      ),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { measurements: Array<{ value: number }> };
    };
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(json.data.measurements.map((m) => m.value)).toEqual([
      11000, 11250, 11500,
    ]);
  });

  it("source=rollup cumulative path falls back to mean*count when sum_value is NULL (v1.4.39 W-SUM)", async () => {
    // Pre-v1.4.39 row — boot-backfill hasn't converged yet. The
    // route falls back to mean × count so the chart never paints
    // a hole during the convergence window.
    const buckets = [
      {
        type: "ACTIVITY_STEPS",
        bucketStart: new Date(Date.UTC(2026, 4, 1)),
        mean: 2000,
        count: 5,
        sumValue: null,
      },
    ];
    vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue(
      buckets as never,
    );

    const res = await GET(
      getRequest(
        "type=ACTIVITY_STEPS&from=2026-05-01T00:00:00Z&to=2026-05-05T00:00:00Z&aggregate=daily&source=rollup&limit=5000",
      ),
    );
    const json = (await res.json()) as {
      data: { measurements: Array<{ value: number }> };
    };
    expect(json.data.measurements[0].value).toBe(10000);
  });

  it("falls back to live date_trunc when source=rollup returns zero buckets", async () => {
    // Empty rollup ⇒ heavy aggregate runs so brand-new accounts still
    // see a correct chart on their first render.
    vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue(
      [] as never,
    );
    const liveBuckets = Array.from({ length: 7 }, (_, i) => ({
      type: "WEIGHT",
      bucket_start: new Date(Date.UTC(2026, 4, 8 + i, 0, 0, 0)),
      avg: 81 + i * 0.05,
      cnt: 2,
    }));
    vi.mocked(prisma.$queryRaw).mockResolvedValue(liveBuckets as never);

    const res = await GET(
      getRequest(
        "type=WEIGHT&from=2026-05-08T00:00:00Z&to=2026-05-15T00:00:00Z&aggregate=daily&source=rollup&limit=5000",
      ),
    );
    expect(res.status).toBe(200);
    expect(prisma.measurementRollup.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const json = (await res.json()) as {
      data: { measurements: Array<unknown> };
    };
    expect(json.data.measurements.length).toBe(7);
  });

  it("returns a weekly series when the all-time window is under two years", async () => {
    // Three months past one year → falls in the weekly grain band.
    const weeks = Array.from({ length: 60 }, (_, i) => ({
      type: "PULSE",
      bucket_start: new Date(Date.UTC(2025, 0, 6 + i * 7, 0, 0, 0)),
      avg: 60 + (i % 5),
      cnt: 7 * 24 * 60,
    }));
    vi.mocked(prisma.$queryRaw).mockResolvedValue(weeks as never);

    const res = await GET(
      getRequest(
        "type=PULSE&from=2024-12-15T00:00:00Z&to=2026-05-15T00:00:00Z&aggregate=weekly&limit=5000",
      ),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { meta: { aggregate?: string }; measurements: Array<unknown> };
    };
    expect(json.data.meta.aggregate).toBe("weekly");
    expect(json.data.measurements.length).toBe(60);
  });
});
