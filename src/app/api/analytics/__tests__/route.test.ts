/**
 * v1.4.33 P0 regression coverage for `GET /api/analytics`.
 *
 * Production stacktrace 2026-05-16 14:39:51 UTC (cf-ray 9fcb223c…):
 *   `RangeError: Maximum call stack size exceeded`
 *   at Promise.all (index 3 — `PULSE`)
 *
 * Root cause was in `summarize()` (`src/lib/analytics/trends.ts`) — the
 * `Math.min(...values)` / `Math.max(...values)` spread blew V8's
 * ~125 000-arg function-arity ceiling once an Apple-Health-synced PULSE
 * series for a multi-year power user grew past it.
 *
 * The fix folds min/max into the single sum/mean pass; this test pins
 * the contract from the route entry-point so a future refactor (e.g.
 * the v1.4.33 C1 SQL-side aggregation rewrite) can't silently
 * reintroduce a spread anywhere along the call chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    // v1.4.37 W2 — `ensureUserRollupsFresh` pokes `measurement.findFirst`
    // for the newest-measurement watermark; mock both shapes.
    measurement: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    moodEntry: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    // v1.4.33 C1 — slim summaries slice runs through `$queryRaw`. The
    // v1.4.36 per-type coverage probe and the v1.4.37 default-slice
    // probe also ride `$queryRaw`. Default to an empty coverage map so
    // the route falls back to the live aggregator branches and the
    // assertions stay byte-shape stable.
    $queryRaw: vi.fn().mockResolvedValue([]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    // v1.4.35 — slim slice also reads DAY buckets; the freshness
    // watermark inside `ensureUserRollupsFresh` pokes `findFirst`.
    // Default both to empty so the parity check falls back to live
    // SQL and the slim slice assertions stay byte-shape stable.
    measurementRollup: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(async (queries: unknown[]) => {
      if (Array.isArray(queries)) return Promise.all(queries);
      return undefined;
    }),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

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
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_USER = {
  id: "user-1",
  username: "test",
  role: "USER" as const,
  timezone: "Europe/Berlin",
  heightCm: 180,
  dateOfBirth: new Date("1980-01-01T00:00:00Z"),
  sourcePriorityJson: null,
};

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: SESSION_USER as never,
};

beforeEach(() => {
  vi.resetAllMocks();
  // v1.4.34 IW-G — reset the analytics LRU between tests so each case
  // observes a cold cache (otherwise tests sharing a userId would land
  // on the prior test's cached response).
  __resetAllCachesForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  // v1.4.35 — rollup table defaults. `resetAllMocks` clears the
  // module-level implementations, so we re-seed both per test. Empty
  // findMany + null findFirst means the slim slice's parity check
  // diverges and falls back to live SQL (preserves the pre-v1.4.35
  // assertions in this file).
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.measurementRollup.findFirst).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.measurementRollup.deleteMany).mockResolvedValue(
    { count: 0 } as never,
  );
  vi.mocked(prisma.measurementRollup.upsert).mockResolvedValue(
    {} as never,
  );
  // v1.4.37 W2 — `ensureUserRollupsFresh` reads `measurement.findFirst`;
  // the per-type coverage probe + the rollup-recompute aggregator ride
  // `$queryRaw` / `$queryRawUnsafe`. Default to empty so the route
  // falls back to the live fast-path branches and the assertions stay
  // byte-shape stable.
  vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null as never);
  // v1.4.49.1 — `computeSleepStageBreakdown` + the glucose 30-day
  // window both call `prisma.measurement.findMany`; the per-type
  // chunked fan-out that used to override this mock per test is gone
  // (folded into `computeSummariesSlice` $queryRaw), so the default
  // needs to be a safe empty array — undefined would crash
  // `rows.length` inside the sleep-stage builder.
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(prisma.$queryRaw as any).mockResolvedValue([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(prisma.$queryRawUnsafe as any).mockResolvedValue([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(prisma.$transaction as any).mockImplementation(
    async (queries: unknown) => {
      if (Array.isArray(queries)) return Promise.all(queries);
      return undefined;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/analytics", () => {
  // v1.4.49.1 — the default slice no longer fans out 15 per-type
  // `prisma.measurement.findMany` walks; it delegates to
  // `computeSummariesSlice`, which feeds entirely from `$queryRaw`
  // against `measurement_rollups` (DAY buckets + a 90-day narrow
  // aggregate). Tests now exercise the rollup-tier path. The slim
  // slice's own test file (`summaries-slice.test.ts`) covers the per-
  // type SQL contract; the route tests below verify the wiring + the
  // shape of the default-slice response.

  it("returns a 200 envelope for a brand-new user with zero rows", async () => {
    // v1.4.49.1 — slim slice's `probeRollupCoverage` (one `$queryRaw`)
    // returns an empty coverage set so `isFullyCovered` is false; the
    // path falls through to `computeFromLiveAggregate`, which fires
    // three `$queryRaw`s (allTime, windowed, latests) — all empty for
    // a brand-new user. The default-slice handler chains a few more
    // `$queryRaw`s through the BP / health-score / correlations fast
    // paths; the shared empty-`[]` default seeded in `beforeEach`
    // satisfies every one.

    const res = await (
      GET as unknown as (...args: never[]) => Promise<Response>
    )();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        summaries: Record<string, { count: number }>;
        bmi: number | null;
        healthScore: unknown;
      };
    };
    expect(body.data.summaries.PULSE.count).toBe(0);
    expect(body.data.summaries.WEIGHT.count).toBe(0);
    expect(body.data.bmi).toBeNull();
    expect(body.data.healthScore).toBeNull();
    // v1.4.49.1 — the legacy 15-way per-type live walk used a chunked
    // pagination select `(id, measuredAt, value, source, deviceType)`
    // unique to `fetchMeasurementSeriesChunked`. Other `findMany` calls
    // (sleep-stage breakdown, glucose 30-day window, BP fallback) all
    // use different select shapes, so this negative check pins the
    // deleted fan-out without false-positiving on legitimate reads.
    expect(prisma.measurement.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          id: true,
          source: true,
          deviceType: true,
        }),
        take: 5000,
      }),
    );
  });

  // v1.4.49.1 — the dashboard tile-strip's `lastSeenByType[type]?.daysAgo`
  // contract is now produced entirely by the slim slice
  // (`computeSummariesSlice` → `latests` `$queryRaw`). The shape +
  // freshness math is covered by `summaries-slice.test.ts`. This route
  // test only pins that the field reaches the response envelope and
  // that the GET wrapper's `enrichLastSeenDaysAgo` re-derives `daysAgo`
  // from the cached `lastSeenAt` ISO so a slice straddling midnight
  // still surfaces a wall-clock-truthful caption.
  it("includes lastSeenByType + bfcache Cache-Control on the default slice", async () => {
    const res = await (
      GET as unknown as (...args: never[]) => Promise<Response>
    )();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=0, must-revalidate",
    );

    const body = (await res.json()) as {
      data: {
        lastSeenByType: Record<
          string,
          { lastSeenAt: string; daysAgo: number } | null
        >;
        summaries: Record<
          string,
          { avg30LastMonth: number | null; avg30LastYear: number | null }
        >;
      };
    };
    // Types the user never logged report `null` — the tile-strip helper
    // falls through without painting a freshness caption.
    expect(body.data.lastSeenByType.BLOOD_GLUCOSE).toBeNull();
    // v1.4.49.1 — `avg30LastMonth` plumbs through the default slice
    // now that the slim narrow query carries it. The empty-mocks
    // fixture produces null; the field must still EXIST on the shape
    // so the dashboard's `tileCompareDelta` helper can `?? null`.
    expect("avg30LastMonth" in (body.data.summaries.WEIGHT ?? {})).toBe(true);
  });

  // v1.4.33 C1 — slim summaries slice. The route branches on
  // `?slice=summaries` BEFORE any chunked findMany; the two `$queryRaw`
  // passes carry the per-type DataSummary shape with the same
  // contract the dashboard tile strip reads.
  it("returns the slim summaries slice when ?slice=summaries is set", async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    // v1.4.36 — slim slice opens with a cheap `SELECT COUNT(*) FROM
    // measurement_rollups` probe; `n: 0` forces the cold-fallback
    // path. v1.4.48 M0 split that path's single aggregate query into
    // two parallel ones (all-time + windowed), so the cold fixture
    // now mocks 4 `$queryRaw` calls: coverage + allTime + windowed +
    // latest.
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ n: BigInt(0) }] as never)
      .mockResolvedValueOnce([
        {
          type: "WEIGHT",
          count: BigInt(12),
          min_value: 80.0,
          max_value: 84.5,
          mean_value: 82.1,
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          type: "WEIGHT",
          avg7: 82.0,
          avg30: 82.2,
          slope7: -0.05,
          r2_7: 0.4,
          slope30: -0.02,
          r2_30: 0.3,
          slope90: -0.01,
          r2_90: 0.2,
        },
      ] as never)
      .mockResolvedValueOnce([
        { type: "WEIGHT", value: 81.8, measured_at: fiveDaysAgo },
      ] as never);

    const req = new Request(
      "http://localhost/api/analytics?slice=summaries",
    );
    const res = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(req);
    expect(res.status).toBe(200);
    // v1.4.34 IW-B — bfcache-friendly directive rides on the slim
    // slice too.
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=0, must-revalidate",
    );
    const body = (await res.json()) as {
      data: {
        summaries: Record<
          string,
          {
            count: number;
            latest: number | null;
            slope30: { slope: number; direction: string } | null;
          }
        >;
        bmi: number | null;
        lastSeenByType: Record<
          string,
          { lastSeenAt: string; daysAgo: number } | null
        >;
      };
    };
    // The slim slice produced WEIGHT from the SQL pass; no chunked
    // findMany was called.
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    expect(body.data.summaries.WEIGHT.count).toBe(12);
    expect(body.data.summaries.WEIGHT.latest).toBe(81.8);
    expect(body.data.summaries.WEIGHT.slope30?.direction).toBe("down");
    // Slim slice never carries BMI — the consumer re-derives.
    expect(body.data.bmi).toBeNull();
    // v1.4.34 IW-B — slim slice surfaces lastSeenByType too so the
    // tile-strip caption works regardless of which slice the client
    // read.
    expect(body.data.lastSeenByType.WEIGHT?.daysAgo).toBeGreaterThanOrEqual(4);
    expect(body.data.lastSeenByType.WEIGHT?.daysAgo).toBeLessThanOrEqual(6);
    expect(body.data.lastSeenByType.PULSE).toBeNull();
  });

  // v1.4.49.1 — the 15-way per-type `fetchMeasurementSeriesChunked`
  // fan-out was removed entirely; the default slice now delegates to
  // `computeSummariesSlice` which runs three rollup-tier `$queryRaw`
  // passes regardless of the type count. The pre-v1.4.49.1 "caps
  // per-type Prisma fan-out at ANALYTICS_TYPE_FETCH_CONCURRENCY" test
  // belonged to a code path that no longer exists; the no-fan-out
  // assertion in the "brand-new user" test above pins the negative
  // contract (the chunked findMany must never re-appear on the default
  // slice critical path).
});
