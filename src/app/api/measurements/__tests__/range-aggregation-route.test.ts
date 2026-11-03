import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.4.28 — the `/api/measurements` route must
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
    // v1.11.1 — the rollup path calls `loadUserSourcePriority`
    // (prisma.user.findUnique) to build the source-rank ladders before
    // `collapseRollupRowsBySource` runs. This is a separate read from the
    // date_trunc `$queryRaw`; `null` → default ladders.
    user: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
    recomputeUserRollups: vi
      .fn()
      .mockResolvedValue({ rowsUpserted: 0, durationMs: 0 }),
  };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
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
import { invalidateUserTimezone } from "@/lib/tz/resolver";

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
  // v1.11.1 — null source-priority blob → default rank ladders for the
  // rollup-path source collapse.
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
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
    // The response carries one bucket per calendar day, NOT
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

  it("source=rollup + aggregate=daily folds live in the user's zone, never the UTC-day rollup (#1026)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "Asia/Kolkata",
      sourcePriorityJson: null,
    } as never);
    // The resolver caches per user; drop what earlier cases left behind.
    invalidateUserTimezone("user-1");
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        type: "ACTIVITY_STEPS",
        bucket_start: new Date("2026-05-09T18:30:00.000Z"),
        avg: 8123,
        cnt: 96,
        min_value: 0,
        max_value: 400,
      },
    ] as never);

    const res = await GET(
      getRequest(
        "type=ACTIVITY_STEPS&from=2026-04-15T00:00:00Z&to=2026-05-15T00:00:00Z&aggregate=daily&source=rollup&limit=5000",
      ),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        measurements: Array<{
          measuredAt: string;
          value: number;
          minValue?: number;
        }>;
      };
    };
    expect(prisma.measurementRollup.findMany).not.toHaveBeenCalled();
    // The zone travels as a bound parameter of the fold.
    const call = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown[];
    expect(call.slice(1)).toContain("Asia/Kolkata");
    // Local midnight of 10 May in Kolkata; a SUM carries no spread band.
    expect(json.data.measurements[0]).toMatchObject({
      measuredAt: "2026-05-09T18:30:00.000Z",
      value: 8123,
    });
    expect(json.data.measurements[0].minValue).toBeUndefined();
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
