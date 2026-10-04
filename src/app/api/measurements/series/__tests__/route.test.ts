import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn(), count: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    // v1.28.25 — dense kinds (glucose / pulse) day-bucket in SQL for
    // windows beyond the 90-day raw cap.
    $queryRaw: vi.fn(),
    // The series reads go through the ladder-winning source per day (see
    // `seriesRowsFrom`), which is raw SQL with the user id as `$1`.
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

// v1.11.4 — the sleep branch resolves the user's tz to bucket per-night;
// pin it so the night grouping is deterministic.
vi.mock("@/lib/tz/resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tz/resolver")>();
  return { ...actual, resolveUserTimezone: vi.fn(async () => "UTC") };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

// v1.11.4 — the sleep branch loads the user's source-priority ladder to
// collapse a dual-source night; pin it to the defaults so the test stays
// hermetic (no DB user read).
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn(),
  };
});

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
import { annotate } from "@/lib/logging/context";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements/series?${query}`);
}

/**
 * The route reads its series through `$queryRawUnsafe` (the ladder-winning
 * source per day). This file's fixtures are written as rows per type and as the
 * two aggregate results, so the adapter routes each statement back to them:
 * the day/hour bucket and the stats aggregate take the next `$queryRaw` result,
 * and a raw read asks `findMany` for the type named in the SQL and returns the
 * rows in the column names the statement selects. The SQL itself (which source
 * wins, which rows count) is covered against a real database in
 * `tests/integration/series-source-ladder.test.ts`.
 */
function adaptSeriesSql(sql: string): Promise<unknown> {
  if (/GROUP BY local_day|STDDEV_POP/.test(sql)) {
    return (prisma.$queryRaw as unknown as () => Promise<unknown>)();
  }
  const type = /'([A-Z0-9_]+)'::"measurement_type"/.exec(sql)?.[1];
  const find = prisma.measurement.findMany as unknown as (
    a: unknown,
  ) => Promise<
    Array<{
      id: string;
      value: number;
      measuredAt: Date;
      source?: string;
      valueMin?: number | null;
      valueMax?: number | null;
    }>
  >;
  // The blood-pressure read selects both halves in one statement, each row
  // carrying its type and source.
  if (sql.includes(`'BLOOD_PRESSURE_DIA'::"measurement_type"`)) {
    return Promise.all(
      (["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] as const).map((t) =>
        find({ where: { type: t } }).then((rows) =>
          rows.map((r) => ({
            id: r.id,
            type: t,
            source: r.source ?? "MANUAL",
            value: r.value,
            measured_at: r.measuredAt,
          })),
        ),
      ),
    ).then(([sys, dia]) =>
      [...sys, ...dia].sort(
        (a, b) => a.measured_at.getTime() - b.measured_at.getTime(),
      ),
    );
  }
  return find({ where: { type } }).then((rows) =>
    rows.map((r) => ({
      id: r.id,
      value: r.value,
      measured_at: r.measuredAt,
      value_min: r.valueMin ?? null,
      value_max: r.valueMax ?? null,
    })),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.$queryRawUnsafe).mockImplementation(((sql: string) =>
    adaptSeriesSql(sql)) as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    glucoseUnit: "mg/dL",
  } as never);
});

describe("GET /api/measurements/series", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req("kind=weight"));
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=garbage"));
    expect(res.status).toBe(422);
  });

  it("returns paired BP series with sys + dia", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const t = new Date("2026-05-01T10:00:00.000Z");
    const findManyMock = vi.mocked(prisma.measurement.findMany);
    findManyMock.mockImplementation(((args: unknown) => {
      const a = args as { where: { type: string } };
      if (a.where.type === "BLOOD_PRESSURE_SYS") {
        return Promise.resolve([
          { id: "s1", value: 126, measuredAt: t },
        ]) as never;
      }
      if (a.where.type === "BLOOD_PRESSURE_DIA") {
        return Promise.resolve([
          {
            id: "d1",
            value: 82,
            measuredAt: new Date(t.getTime() + 60_000),
          },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    }) as never);
    const res = await GET(req("kind=bloodPressure&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        kind: string;
        points: Array<{ value: number; secondary: number | null }>;
        stats: { count: number };
      };
    };
    expect(body.data.kind).toBe("bloodPressure");
    expect(body.data.points).toHaveLength(1);
    expect(body.data.points[0].value).toBe(126);
    expect(body.data.points[0].secondary).toBe(82);
    expect(body.data.stats.count).toBe(1);
  });

  it("pairs BP via the sorted two-pointer merge exactly like the old scan (v1.28.25)", async () => {
    // Pins the O(sys + dia) merge against the previous per-systolic full
    // rescan: nearest diastolic within ±5 min wins, a tie keeps the
    // EARLIER diastolic row, an out-of-window systolic pairs null.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const at = (iso: string) => new Date(iso);
    const findManyMock = vi.mocked(prisma.measurement.findMany);
    findManyMock.mockImplementation(((args: unknown) => {
      const a = args as { where: { type: string } };
      if (a.where.type === "BLOOD_PRESSURE_SYS") {
        return Promise.resolve([
          { id: "s1", value: 120, measuredAt: at("2026-05-01T10:00:00Z") },
          // Equidistant (±2 min) between the 10:03 and 10:07 dia rows.
          { id: "s2", value: 124, measuredAt: at("2026-05-01T10:05:00Z") },
          { id: "s3", value: 130, measuredAt: at("2026-05-01T10:10:00Z") },
          // > 5 min from every diastolic row — stays unpaired.
          { id: "s4", value: 140, measuredAt: at("2026-05-01T11:00:00Z") },
        ]) as never;
      }
      if (a.where.type === "BLOOD_PRESSURE_DIA") {
        return Promise.resolve([
          { id: "d1", value: 80, measuredAt: at("2026-05-01T10:01:00Z") },
          { id: "d2", value: 82, measuredAt: at("2026-05-01T10:03:00Z") },
          { id: "d3", value: 84, measuredAt: at("2026-05-01T10:07:00Z") },
          { id: "d4", value: 86, measuredAt: at("2026-05-01T10:11:00Z") },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    }) as never);
    const res = await GET(req("kind=bloodPressure&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { points: Array<{ id: string; secondary: number | null }> };
    };
    expect(body.data.points.map((p) => [p.id, p.secondary])).toEqual([
      ["s1", 80], // nearest is d1 (1 min)
      ["s2", 82], // d2/d3 tie at 2 min — earlier row wins
      ["s3", 86], // nearest is d4 (1 min)
      ["s4", null], // nothing within ±5 min
    ]);
  });

  it("pairs a systolic only with a diastolic from its own source", async () => {
    // Across midnight the two days may have picked different sources; the
    // nearest diastolic then belongs to another source and must not be used.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const at = (iso: string) => new Date(iso);
    vi.mocked(prisma.measurement.findMany).mockImplementation(((
      args: unknown,
    ) => {
      const a = args as { where: { type: string } };
      if (a.where.type === "BLOOD_PRESSURE_SYS") {
        return Promise.resolve([
          {
            id: "s1",
            value: 150,
            source: "WITHINGS",
            measuredAt: at("2026-05-01T23:59:00Z"),
          },
          {
            id: "s2",
            value: 125,
            source: "APPLE_HEALTH",
            measuredAt: at("2026-05-02T00:01:00Z"),
          },
        ]) as never;
      }
      if (a.where.type === "BLOOD_PRESSURE_DIA") {
        return Promise.resolve([
          {
            id: "d2",
            value: 85,
            source: "APPLE_HEALTH",
            measuredAt: at("2026-05-02T00:01:00Z"),
          },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    }) as never);
    const res = await GET(req("kind=bloodPressure&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { points: Array<{ id: string; secondary: number | null }> };
    };
    expect(body.data.points.map((p) => [p.id, p.secondary])).toEqual([
      ["s1", null],
      ["s2", 85],
    ]);
  });

  it("returns single-value series for kind=weight", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "w1", value: 78.4, measuredAt: new Date() },
    ] as never);
    const res = await GET(req("kind=weight&days=7"));
    const body = (await res.json()) as {
      data: { points: Array<{ secondary: number | null }> };
    };
    expect(body.data.points[0].secondary).toBeNull();
  });

  it("surfaces per-point min/max for kind=pulse (iOS #34 ext)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      // hourly HR bucket — average + spread
      {
        id: "p1",
        value: 72,
        measuredAt: new Date("2026-06-21T14:00:00.000Z"),
        valueMin: 58,
        valueMax: 96,
      },
      // per-sample PULSE row — no spread
      {
        id: "p2",
        value: 64,
        measuredAt: new Date("2026-06-21T15:00:00.000Z"),
        valueMin: null,
        valueMax: null,
      },
    ] as never);
    const res = await GET(req("kind=pulse&days=7"));
    const body = (await res.json()) as {
      data: {
        points: Array<{
          value: number;
          valueMin: number | null;
          valueMax: number | null;
        }>;
      };
    };
    expect(body.data.points[0].valueMin).toBe(58);
    expect(body.data.points[0].valueMax).toBe(96);
    expect(body.data.points[1].valueMin).toBeNull();
    expect(body.data.points[1].valueMax).toBeNull();

    // The pulse read selects the spread columns, and reads the pulse rows of
    // this person's ladder-winning source (the user id is the first parameter).
    const [sql, userId] = vi.mocked(prisma.$queryRawUnsafe).mock
      .calls[0] as unknown as [string, string];
    expect(sql).toContain('m."value_min"');
    expect(sql).toContain('m."value_max"');
    expect(sql).toContain(`'PULSE'::"measurement_type"`);
    expect(userId).toBe("user-1");
  });

  it("collapses sleep stage rows into one night point in hours (v1.11.4)", async () => {
    // SLEEP_DURATION is stored one row per STAGE per night (minutes). The
    // series must return ONE point per night carrying the TIME-ASLEEP
    // total in hours, not a point per stage.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "s1",
        value: 240,
        measuredAt: new Date("2026-06-04T00:00:00.000Z"),
        sleepStage: "CORE",
      },
      {
        id: "s2",
        value: 90,
        measuredAt: new Date("2026-06-04T02:00:00.000Z"),
        sleepStage: "DEEP",
      },
      {
        id: "s3",
        value: 80,
        measuredAt: new Date("2026-06-04T04:00:00.000Z"),
        sleepStage: "REM",
      },
      {
        id: "s4",
        value: 60,
        measuredAt: new Date("2026-06-04T05:00:00.000Z"),
        sleepStage: "AWAKE",
      },
      {
        id: "s5",
        value: 480,
        measuredAt: new Date("2026-06-03T23:00:00.000Z"),
        sleepStage: "IN_BED",
      },
    ] as never);
    const res = await GET(req("kind=sleep&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        unit: string;
        points: Array<{
          value: number;
          sleepStages: Record<string, number> | null;
        }>;
      };
    };
    expect(body.data.unit).toBe("h");
    // One point for the single night.
    expect(body.data.points).toHaveLength(1);
    // Time asleep = CORE + DEEP + REM = 410 min → 6.83 h (IN_BED + AWAKE
    // excluded).
    expect(body.data.points[0].value).toBeCloseTo(410 / 60, 2);
    expect(body.data.points[0].sleepStages?.CORE).toBeCloseTo(4, 2);
  });

  it("returns an explicit unit for a non-sleep kind (v1.11.4)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "w1", value: 78.4, measuredAt: new Date() },
    ] as never);
    const res = await GET(req("kind=weight&days=7"));
    const body = (await res.json()) as { data: { unit: string } };
    expect(body.data.unit).toBe("kg");
  });

  it("returns glucose in mg/dL with raw values for a mg/dL-preference user (v1.16.16)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mg/dL",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
      { id: "g2", value: 126, measuredAt: new Date("2026-06-02T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { unit: string; points: Array<{ value: number }> };
    };
    expect(body.data.unit).toBe("mg/dL");
    expect(body.data.points.map((p) => p.value)).toEqual([100, 126]);
  });

  it("converts glucose to mmol/L (value + unit) for a mmol/L-preference user (v1.16.16)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
      { id: "g2", value: 126, measuredAt: new Date("2026-06-02T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        unit: string;
        points: Array<{ value: number }>;
        stats: { min: number; max: number };
      };
    };
    expect(body.data.unit).toBe("mmol/L");
    // 100 mg/dL → 5.5 mmol/L, 126 mg/dL → 7.0 mmol/L (1-decimal).
    expect(body.data.points[0].value).toBe(5.5);
    expect(body.data.points[1].value).toBe(7);
    // Stats are derived from the converted points → also in mmol/L.
    expect(body.data.stats.min).toBe(5.5);
    expect(body.data.stats.max).toBe(7);
  });

  it("computes mmol/L stats over raw mg/dL then converts once (v1.16.16 parity)", async () => {
    // Parity with the detail page + FHIR convention: aggregate the raw mg/dL
    // values, then convert each stat figure ONCE. Deriving the mean from the
    // already-converted points (5.5, 7.0 → 6.25) double-rounds; the raw path
    // (mean 113 mg/dL → 6.3 mmol/L) matches the detail page.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
      { id: "g2", value: 126, measuredAt: new Date("2026-06-02T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    const body = (await res.json()) as {
      data: { stats: { mean: number } };
    };
    // mean(100,126) = 113 mg/dL → 6.3 mmol/L (NOT mean(5.5,7.0) = 6.25).
    expect(body.data.stats.mean).toBe(6.3);
  });

  it("keeps a single mmol/L reading's stats identical to its point (v1.16.16)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    const body = (await res.json()) as {
      data: { points: Array<{ value: number }>; stats: { mean: number } };
    };
    expect(body.data.points[0].value).toBe(5.5);
    expect(body.data.stats.mean).toBe(5.5);
  });

  it("defaults glucose to mg/dL when the user has no preference (v1.16.16)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    const body = (await res.json()) as {
      data: { unit: string; points: Array<{ value: number }> };
    };
    expect(body.data.unit).toBe("mg/dL");
    expect(body.data.points[0].value).toBe(100);
  });

  it("accepts the ten-year window (days=3650 — iOS 'Alle'-range)", async () => {
    // v1.5.5 — the previous 365-day cap rejected the iOS app's
    // "Alle"-range request with a 422, painting an error banner on
    // every metric tile. Ten years matches the recurrence engine's
    // hard cap and the medication course-window upper bound.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    const res = await GET(req("kind=weight&days=3650"));
    expect(res.status).toBe(200);
  });

  it("rejects a days value above the ten-year cap", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=weight&days=3651"));
    expect(res.status).toBe(422);
  });

  it.each(["restingHeartRate", "heartRateVariability", "vo2Max"])(
    "accepts kind=%s (v1.5.5)",
    async (kind) => {
      // v1.5.5 — the iOS app surfaces these as series-capable; the
      // previous enum rejected them with 422 even though the
      // underlying MeasurementType already carried the values.
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
      const res = await GET(req(`kind=${kind}&days=30`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { kind: string } };
      expect(body.data.kind).toBe(kind);
    },
  );
});

describe("GET /api/measurements/series — dense-kind day-bucketing (v1.28.25)", () => {
  it("day-buckets glucose in SQL beyond the 90-day raw window", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.$queryRaw)
      // 1st query — day buckets.
      .mockResolvedValueOnce([
        {
          bucket_start: new Date("2025-01-01T00:00:00Z"),
          mean: 100,
          min_value: 70,
          max_value: 180,
        },
        {
          bucket_start: new Date("2025-01-02T00:00:00Z"),
          mean: 126,
          min_value: 80,
          max_value: 200,
        },
      ] as never)
      // 2nd query — raw-row aggregate for the stats strip.
      .mockResolvedValueOnce([
        { n: 576, mean: 113.04, min: 70, max: 200, sd: 22.34 },
      ] as never);

    const res = await GET(req("kind=glucose&days=365"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        unit: string;
        points: Array<{
          id: string;
          at: string;
          value: number;
          secondary: number | null;
        }>;
        stats: {
          mean: number;
          min: number;
          max: number;
          stdDev: number;
          count: number;
        };
      };
    };
    // No raw row walk — the read is SQL-aggregate only.
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(body.data.unit).toBe("mg/dL");
    expect(body.data.points).toEqual([
      {
        id: "day:2025-01-01",
        at: "2025-01-01T00:00:00.000Z",
        value: 100,
        secondary: null,
      },
      {
        id: "day:2025-01-02",
        at: "2025-01-02T00:00:00.000Z",
        value: 126,
        secondary: null,
      },
    ]);
    // Stats come from the RAW-row aggregate (count = raw samples, not
    // day buckets), matching the raw path's mg/dL parity convention.
    expect(body.data.stats).toEqual({
      mean: 113,
      min: 70,
      max: 200,
      stdDev: 22,
      count: 576,
    });
  });

  it("converts day-bucketed glucose for a mmol/L-preference user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          bucket_start: new Date("2025-01-01T00:00:00Z"),
          mean: 100,
          min_value: 70,
          max_value: 180,
        },
      ] as never)
      .mockResolvedValueOnce([
        { n: 288, mean: 100, min: 70, max: 180, sd: 18 },
      ] as never);

    const res = await GET(req("kind=glucose&days=3650"));
    const body = (await res.json()) as {
      data: {
        unit: string;
        points: Array<{ value: number }>;
        stats: { mean: number };
      };
    };
    expect(body.data.unit).toBe("mmol/L");
    expect(body.data.points[0].value).toBe(5.5); // 100 mg/dL → 5.5 mmol/L
    expect(body.data.stats.mean).toBe(5.5);
  });

  it("day-buckets pulse beyond 90 days with the day's min/max band", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          bucket_start: new Date("2025-06-01T00:00:00Z"),
          mean: 71.666,
          min_value: 52,
          max_value: 143,
        },
      ] as never)
      .mockResolvedValueOnce([
        { n: 24, mean: 71.666, min: 58, max: 132, sd: 9.876 },
      ] as never);

    const res = await GET(req("kind=pulse&days=365"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        points: Array<{
          id: string;
          value: number;
          valueMin: number | null;
          valueMax: number | null;
        }>;
        stats: { mean: number; stdDev: number; count: number };
      };
    };
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    expect(body.data.points).toEqual([
      {
        id: "day:2025-06-01",
        at: "2025-06-01T00:00:00.000Z",
        value: 71.67,
        secondary: null,
        valueMin: 52,
        valueMax: 143,
      },
    ]);
    expect(body.data.stats.mean).toBe(71.67);
    expect(body.data.stats.stdDev).toBe(9.88);
    expect(body.data.stats.count).toBe(24);
  });

  it("keeps the 90-day window on the raw path (byte-identical short ranges)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=90"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { points: Array<{ id: string }> };
    };
    // Raw read, individual row ids — the SQL bucket path never fires.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(body.data.points[0].id).toBe("g1");
  });

  it("hour-buckets a pulse window too dense to send raw (#1023)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // One reading a minute for 30 days.
    vi.mocked(prisma.measurement.count).mockResolvedValue(43_200 as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          bucket_start: new Date("2026-06-01T08:00:00Z"),
          mean: 71.666,
          min_value: 58,
          max_value: 96,
        },
      ] as never)
      .mockResolvedValueOnce([
        { n: 43_200, mean: 72.1, min: 50, max: 150, sd: 11.5 },
      ] as never);

    const res = await GET(req("kind=pulse&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        points: Array<Record<string, unknown>>;
        stats: { count: number; mean: number };
      };
    };
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    expect(body.data.points).toEqual([
      {
        id: "hour:2026-06-01T08:00:00.000Z",
        at: "2026-06-01T08:00:00.000Z",
        value: 71.67,
        secondary: null,
        valueMin: 58,
        valueMax: 96,
      },
    ]);
    // Stats describe the readings, not the buckets.
    expect(body.data.stats.count).toBe(43_200);
    expect(body.data.stats.mean).toBe(72.1);
    // The bucket read folds per hour, not per day.
    const bucketCall = vi
      .mocked(prisma.$queryRawUnsafe)
      .mock.calls.find(([sql]) =>
        /GROUP BY local_day/.test(sql as string),
      ) as unknown[];
    expect(bucketCall.slice(1)).toContain("hour");
  });

  it("hour-buckets a CGM glucose window too dense to send raw, in the user's unit", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    // A sensor reading every five minutes for 90 days.
    vi.mocked(prisma.measurement.count).mockResolvedValue(25_920 as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          bucket_start: new Date("2026-06-01T08:00:00Z"),
          mean: 100,
          min_value: 90,
          max_value: 112,
        },
      ] as never)
      .mockResolvedValueOnce([
        { n: 25_920, mean: 118.004, min: 48, max: 260, sd: 36.004 },
      ] as never);

    const res = await GET(req("kind=glucose&days=90"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        unit: string;
        points: Array<Record<string, unknown>>;
        stats: {
          count: number;
          mean: number;
          min: number;
          max: number;
          stdDev: number;
        };
      };
    };
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.measurement.count).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ type: "BLOOD_GLUCOSE" }),
      }),
    );
    expect(body.data.unit).toBe("mmol/L");
    // Converted once at serialization; no band on a glucose point.
    expect(body.data.points).toEqual([
      {
        id: "hour:2026-06-01T08:00:00.000Z",
        at: "2026-06-01T08:00:00.000Z",
        value: 5.5,
        secondary: null,
      },
    ]);
    // Stats describe every reading (mg/dL aggregate, converted once).
    expect(body.data.stats).toEqual({
      count: 25_920,
      mean: 6.5,
      min: 2.7,
      max: 14.4,
      stdDev: 2,
    });
    const bucketCall = vi
      .mocked(prisma.$queryRawUnsafe)
      .mock.calls.find(([sql]) =>
        /GROUP BY local_day/.test(sql as string),
      ) as unknown[];
    expect(bucketCall.slice(1)).toContain("hour");
  });

  it("keeps fingerstick glucose at or under the row cap raw", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.count).mockResolvedValue(360 as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 104, measuredAt: new Date("2026-06-01T07:12:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=90"));
    const body = (await res.json()) as {
      data: { points: Array<Record<string, unknown>> };
    };
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(body.data.points).toEqual([
      { id: "g1", at: "2026-06-01T07:12:00.000Z", value: 104, secondary: null },
    ]);
  });

  it("keeps a pulse window at or under the row cap raw", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.count).mockResolvedValue(10_000 as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "p1",
        value: 64,
        measuredAt: new Date("2026-06-01T08:03:00Z"),
        valueMin: null,
        valueMax: null,
      },
    ] as never);
    const res = await GET(req("kind=pulse&days=90"));
    const body = (await res.json()) as {
      data: { points: Array<{ id: string; at: string }> };
    };
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(body.data.points).toEqual([
      expect.objectContaining({ id: "p1", at: "2026-06-01T08:03:00.000Z" }),
    ]);
  });

  it("keeps sparse kinds raw even on the ten-year window", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "w1", value: 78.4, measuredAt: new Date() },
    ] as never);
    const res = await GET(req("kind=weight&days=3650"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { points: Array<{ id: string }> };
    };
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(body.data.points[0].id).toBe("w1");
  });
});

describe("GET /api/measurements/series — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // bad `kind` (invalid enum) + `days=0` (below min 1).
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces multiple simultaneous validation errors (≥2)", async () => {
    // The series schema has only two knobs (kind + days), so a strict
    // 3-issue case is not natural. We pin the multi-issue contract on
    // ≥ 2 here — the helper's 3-issue path is exhaustively covered by
    // `src/lib/__tests__/api-response-zod.test.ts` and the routes with
    // wider schemas (measurements, devices, mood-entries).
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=junk&days=-999"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("writes a measurements.series.validation-failed audit row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("measurements.series.validation-failed");
  });

  it("surfaces received_keys + received_shape_excerpt + zod_issues in the wide-event meta (v1.4.48 H-iOS-2)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=garbage&days=0&extraGarbage=fromIos"));
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "measurements.series.validation-failed",
      );
    expect(annotated, "validation-failed annotate call").toBeTruthy();
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;

    expect(meta.received_keys).toEqual(
      expect.arrayContaining(["kind", "days", "extraGarbage"]),
    );
    expect(typeof meta.received_shape_excerpt).toBe("string");
    expect((meta.received_shape_excerpt as string).length).toBeLessThanOrEqual(
      256,
    );
    expect(meta.received_shape_excerpt as string).toContain('"kind":"garbage"');

    const issues = meta.zod_issues as Array<{ path: string; code: string }>;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("caps received_shape_excerpt at 256 chars even for a long iOS query", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const long = "x".repeat(500);
    const res = await GET(req(`kind=garbage&days=0&junk=${long}`));
    expect(res.status).toBe(422);
    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "measurements.series.validation-failed",
      );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    expect((meta.received_shape_excerpt as string).length).toBe(256);
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
  });

  it("redacts sensitive query keys before writing the wide-event received_shape_excerpt (v1.4.49)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // An attacker-shaped query that mixes a valid `kind` with a
    // credential-shaped `token` param. The excerpt must keep `kind`
    // readable for operator debug but redact the token verbatim.
    const res = await GET(
      req("kind=garbage&days=0&token=hlk_secret_value&apiKey=sk_live_xxx"),
    );
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "measurements.series.validation-failed",
      );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    const excerpt = meta.received_shape_excerpt as string;

    expect(excerpt).not.toContain("hlk_secret_value");
    expect(excerpt).not.toContain("sk_live_xxx");
    expect(excerpt).toContain("[redacted]");
    // The key inventory still surfaces so operators see the shape.
    expect(meta.received_keys).toEqual(
      expect.arrayContaining(["kind", "days", "token", "apiKey"]),
    );
  });

  it("strips `message` from the audit-ledger issues row (v1.4.49)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await GET(req("kind=garbage&days=0"));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { details: string };
    };
    const parsed = JSON.parse(call.data.details) as {
      issues: Array<Record<string, unknown>>;
    };
    for (const issue of parsed.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });
});
