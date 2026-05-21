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

import { ANALYTICS_TYPE_FETCH_CONCURRENCY, GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

interface MeasurementRow {
  id: string;
  measuredAt: Date;
  value: number;
  source: "MANUAL" | "WITHINGS" | "IMPORT" | "APPLE_HEALTH";
  deviceType: string | null;
  sleepStage?: string | null;
}

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

function pulseRow(measuredAt: Date, value: number, id: string): MeasurementRow {
  return {
    id,
    measuredAt,
    value,
    source: "APPLE_HEALTH",
    deviceType: "watch",
  };
}

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
  it("survives a 130 000-row PULSE series without blowing the stack", async () => {
    // The chunked reader pages 5 000 at a time. Simulate one full page
    // for PULSE so the route's per-type aggregator hits the failing
    // `summarize()` codepath with a 5 000-point series, then stop. We
    // intentionally don't seed every single Apple Watch sample in the
    // mock — V8's spread-arg ceiling is repeatable with a far smaller
    // array than production (see `trends.test.ts` for the 250 000-row
    // direct regression). This test pins the route-entry contract.
    const N = 5_000;
    const now = Date.now();
    const pulseSeries: MeasurementRow[] = new Array(N);
    for (let i = 0; i < N; i++) {
      pulseSeries[i] = pulseRow(
        new Date(now - (N - i) * 1000),
        40 + (i % 160),
        `pulse-${i}`,
      );
    }

    // Return the PULSE rows on the second page-of-5000-empty for every
    // other type; the chunked reader walks `take=5000` then exits on
    // any short page.
    vi.mocked(prisma.measurement.findMany).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        if (args.where?.type === "PULSE" && !args.cursor) {
          return pulseSeries as never;
        }
        return [] as never;
      }) as never,
    );

    // GET is wrapped by `apiHandler` which tolerates direct-invoke
    // with no request (see `safeRequestProp` in `src/lib/api-handler.ts`).
    // Cast through `unknown` so the TS signature `(...args: never[])`
    // doesn't fight the vitest direct-invoke pattern.
    const res = await (
      GET as unknown as (...args: never[]) => Promise<Response>
    )();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { summaries: Record<string, { count: number; min: number | null; max: number | null }> };
    };
    expect(body.data.summaries.PULSE.count).toBe(N);
    // 40 + (N-1) % 160 → wave around (40..199).
    expect(body.data.summaries.PULSE.min).toBeGreaterThanOrEqual(40);
    expect(body.data.summaries.PULSE.max).toBeLessThanOrEqual(199);
  });

  it("returns a 200 envelope for a brand-new user with zero rows", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

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
    // Empty series should not crash on the new fold path either.
    expect(body.data.summaries.PULSE.count).toBe(0);
    expect(body.data.summaries.WEIGHT.count).toBe(0);
    expect(body.data.bmi).toBeNull();
    expect(body.data.healthScore).toBeNull();
  });

  // v1.4.34 IW-B — the dashboard tile strip reads `lastSeenByType[type]?.daysAgo`
  // and forwards it to each `<TrendCard>` so a metric the user hasn't
  // logged in a while keeps its tile visible with an "Letzter Wert vor
  // Xd" caption instead of disappearing.
  it("emits lastSeenByType keyed on the freshest measuredAt per type", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

    vi.mocked(prisma.measurement.findMany).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        if (args.where?.type === "WEIGHT" && !args.cursor) {
          return [
            {
              id: "w-old",
              measuredAt: eightDaysAgo,
              value: 80.5,
              source: "MANUAL",
              deviceType: null,
            },
          ] as never;
        }
        if (args.where?.type === "PULSE" && !args.cursor) {
          return [
            {
              id: "p-fresh",
              measuredAt: oneDayAgo,
              value: 72,
              source: "APPLE_HEALTH",
              deviceType: "watch",
            },
          ] as never;
        }
        return [] as never;
      }) as never,
    );

    const res = await (
      GET as unknown as (...args: never[]) => Promise<Response>
    )();
    expect(res.status).toBe(200);
    // bfcache-friendly Cache-Control — verifies the IW-B header
    // posture is on the wire.
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=0, must-revalidate",
    );

    const body = (await res.json()) as {
      data: {
        lastSeenByType: Record<
          string,
          { lastSeenAt: string; daysAgo: number } | null
        >;
      };
    };
    expect(body.data.lastSeenByType.WEIGHT?.daysAgo).toBeGreaterThanOrEqual(7);
    expect(body.data.lastSeenByType.WEIGHT?.daysAgo).toBeLessThanOrEqual(9);
    expect(body.data.lastSeenByType.PULSE?.daysAgo).toBeGreaterThanOrEqual(0);
    expect(body.data.lastSeenByType.PULSE?.daysAgo).toBeLessThanOrEqual(2);
    // Types the user never logged report `null` so the tile-strip
    // helper falls through without painting a caption.
    expect(body.data.lastSeenByType.BLOOD_GLUCOSE).toBeNull();
  });

  // v1.4.33 C1 — slim summaries slice. The route branches on
  // `?slice=summaries` BEFORE any chunked findMany; the two `$queryRaw`
  // passes carry the per-type DataSummary shape with the same
  // contract the dashboard tile strip reads.
  it("returns the slim summaries slice when ?slice=summaries is set", async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    // v1.4.36 — slim slice now opens with a cheap `SELECT COUNT(*) FROM
    // measurement_rollups` probe. Force `n: 0` so the route takes the
    // legacy heavy-aggregate fallback path that this test's fixtures
    // expect (aggregate + latest, two `$queryRaw` passes).
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ n: BigInt(0) }] as never)
      .mockResolvedValueOnce([
        {
          type: "WEIGHT",
          count: BigInt(12),
          min_value: 80.0,
          max_value: 84.5,
          mean_value: 82.1,
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

  // v1.4.40 W-POOL — pin the bounded-concurrency cap on the per-type
  // fan-out inside `buildAnalyticsResponse`. The v1.4.39 empirical
  // trace (`.planning/round-v1439-empirical-trace.md` §B1) showed the
  // raw `Promise.all` over `fetchMeasurementSeriesChunked` holding
  // ≥8 of the default-10 pg.Pool slots for 6.5 s on a power-user cold
  // mount. The p-limit(4) wrapper keeps the same total work but caps
  // inflight Prisma round-trips for this branch at 4.
  //
  // The assertion instruments the `prisma.measurement.findMany` mock
  // to track peak inflight count + total batches. With N≥15 types and
  // a 20 ms per-call delay, an unbounded `Promise.all` would peak at
  // ~15 and finish in ~20 ms; the bounded version peaks at exactly 4
  // and finishes in ~80 ms (4 batches × 20 ms ceiling).
  it("caps per-type Prisma fan-out at ANALYTICS_TYPE_FETCH_CONCURRENCY", async () => {
    // Default-slice path requires no coverage so the route falls into
    // the live per-type loop where the fan-out lives.
    vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);

    let inflight = 0;
    let peak = 0;
    let calls = 0;

    vi.mocked(prisma.measurement.findMany).mockImplementation(
      (async () => {
        // Only count the per-type chunked fan-out calls (not the
        // narrower glucose / sleep-stage `findMany` reads inside the
        // same route; those run sequentially AFTER the fan-out
        // completes so they never overlap with peak inflight).
        calls += 1;
        inflight += 1;
        peak = Math.max(peak, inflight);
        // 20 ms is large enough to make the bounded vs unbounded
        // distinction observable but small enough to keep the suite
        // under a second.
        await new Promise((resolve) => setTimeout(resolve, 20));
        inflight -= 1;
        // Return an empty page so the chunked reader exits after one
        // round-trip per type.
        return [] as never;
      }) as never,
    );

    const t0 = Date.now();
    const res = await (
      GET as unknown as (...args: never[]) => Promise<Response>
    )();
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);

    // The cap itself — peak inflight Prisma reads against
    // `measurements` never crosses the configured ceiling.
    expect(ANALYTICS_TYPE_FETCH_CONCURRENCY).toBe(4);
    expect(peak).toBeLessThanOrEqual(ANALYTICS_TYPE_FETCH_CONCURRENCY);

    // Sanity: more than one type was actually walked, otherwise the
    // bound is unfalsifiable.
    expect(calls).toBeGreaterThanOrEqual(8);

    // Wall-clock proves the lanes are saturated rather than serialised
    // by accident. 4 lanes × 20 ms × ⌈calls/4⌉ ≈ 60-100 ms; an
    // unbounded fan-out would finish in ~25-40 ms; a fully serial
    // walk would take calls × 20 ms ≈ 300+ ms. The window catches
    // both regressions.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(calls * 20);
  });
});
