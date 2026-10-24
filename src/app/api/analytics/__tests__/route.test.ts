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
    // v1.4.37 — `ensureUserRollupsFresh` pokes `measurement.findFirst`
    // for the newest-measurement watermark; mock both shapes.
    measurement: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    moodEntry: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    // v1.34 — the versioned reference score reads these three models
    // directly (not through the shared measurement/rollup path); default
    // to empty/null so a brand-new-user response doesn't throw before the
    // route can even decide the composite is ungraded.
    mentalHealthAssessment: { findMany: vi.fn().mockResolvedValue([]) },
    labResult: { findMany: vi.fn().mockResolvedValue([]) },
    dismissedPriorityItem: { findUnique: vi.fn().mockResolvedValue(null) },
    // v1.38 — the composition note reads the account's last stored score
    // day. Nothing stored in these fixtures, so no note is raised.
    healthScoreRecord: { findFirst: vi.fn().mockResolvedValue(null) },
    // v1.4.33 — slim summaries slice runs through `$queryRaw`. The
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
      // v1.11.1 — the writer now delete-then-inserts via createMany.
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // v1.11.1 — the source-aware rollup readers load the user's
    // source-priority blob; null → default ladders.
    user: { findUnique: vi.fn().mockResolvedValue(null) },
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

vi.mock("@/lib/insights/correlation-patterns", () => ({
  PATTERN_FAMILIES: { fixed: "FIXED" },
  syncAcceptedPatterns: vi.fn().mockResolvedValue(new Map()),
  decisionForEvidence: vi.fn().mockReturnValue(null),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// v1.18.0 — the health-score fast path resolves the per-user module map to
// drop disabled-module pillars; stub the gate so analytics tests don't need
// the real DB-backed resolver (default: every module enabled).
vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(),
    isModuleEnabled: vi.fn(),
    requireModuleEnabled: vi.fn(),
  };
});

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import {
  resolveModuleMap,
  isModuleEnabled,
  requireModuleEnabled,
} from "@/lib/modules/gate";

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
  // v1.4.34 — reset the analytics LRU between tests so each case
  // observes a cold cache (otherwise tests sharing a userId would land
  // on the prior test's cached response).
  __resetAllCachesForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(resolveModuleMap).mockResolvedValue({} as never);
  vi.mocked(isModuleEnabled).mockResolvedValue(true as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({
    enabled: true,
  } as never);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.mentalHealthAssessment.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.dismissedPriorityItem.findUnique).mockResolvedValue(
    null as never,
  );
  // v1.4.35 — rollup table defaults. `resetAllMocks` clears the
  // module-level implementations, so we re-seed both per test. Empty
  // findMany + null findFirst means the slim slice's parity check
  // diverges and falls back to live SQL (preserves the pre-v1.4.35
  // assertions in this file).
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurementRollup.findFirst).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.measurementRollup.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.measurementRollup.upsert).mockResolvedValue({} as never);
  // v1.4.37 — `ensureUserRollupsFresh` reads `measurement.findFirst`;
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
        healthScore: { composite: { status: string } } | null;
      };
    };
    expect(body.data.summaries.PULSE.count).toBe(0);
    expect(body.data.summaries.WEIGHT.count).toBe(0);
    expect(body.data.bmi).toBeNull();
    // v1.34 — the versioned reference score always returns a structured
    // report, even with zero data; a brand-new user reads as an explicit
    // "insufficient" composite, never a bare null.
    expect(body.data.healthScore?.composite.status).toBe("insufficient");
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

  // v1.4.33 — slim summaries slice. The route branches on
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
    // The coverage probe rides `$queryRaw` (n:0 → cold path). v1.11.1 — the
    // cold path's data aggregates (allTime + windowed + latest) now run via
    // `$queryRawUnsafe` (the source-aware collapse splices a whitelisted CASE).
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { n: BigInt(0) },
    ] as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(prisma.$queryRawUnsafe as any)
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
          r2_90: 0.2,
          // Twelve readings on twelve days across the month.
          days7: 3,
          span7: 5,
          days30: 12,
          span30: 27,
        },
      ] as never)
      .mockResolvedValueOnce([
        { type: "WEIGHT", value: 81.8, measured_at: fiveDaysAgo },
      ] as never);

    const req = new Request("http://localhost/api/analytics?slice=summaries");
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      req,
    );
    expect(res.status).toBe(200);
    // v1.4.34 — bfcache-friendly directive rides on the slim
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
        recoveryEmpty: string | null;
      };
    };
    // A weight-only account without Oura: the recovery page's empty reason
    // is resolved here, not by the client.
    expect(body.data.recoveryEmpty).toBe("general");
    // The slim slice produced WEIGHT from the SQL pass; no chunked
    // findMany was called.
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    expect(body.data.summaries.WEIGHT.count).toBe(12);
    expect(body.data.summaries.WEIGHT.latest).toBe(81.8);
    expect(body.data.summaries.WEIGHT.slope30?.direction).toBe("down");
    // Slim slice never carries BMI — the consumer re-derives.
    expect(body.data.bmi).toBeNull();
    // v1.4.34 — slim slice surfaces lastSeenByType too so the
    // tile-strip caption works regardless of which slice the client
    // read.
    expect(body.data.lastSeenByType.WEIGHT?.daysAgo).toBeGreaterThanOrEqual(4);
    expect(body.data.lastSeenByType.WEIGHT?.daysAgo).toBeLessThanOrEqual(6);
    expect(body.data.lastSeenByType.PULSE).toBeNull();
  });

  // v1.18.0 — the default slice serves the glucose-only surfaces
  // (per-context summaries + the TIR/GMI/eA1C clinical panel) only when
  // the `glucose` module is enabled. A disabled-glucose account nulls
  // both fields rather than 403-ing the whole core-metrics payload.
  function seedGlucoseRows() {
    const measuredAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.measurement.findMany).mockImplementation((async (args: {
      where?: { type?: string };
    }) => {
      if (args?.where?.type === "BLOOD_GLUCOSE") {
        return [
          { value: 95, measuredAt, glucoseContext: "FASTING" },
          { value: 140, measuredAt, glucoseContext: "POSTPRANDIAL" },
        ];
      }
      return [];
    }) as never);
  }

  it("serves glucose clinical + per-context when glucose enabled", async () => {
    seedGlucoseRows();
    vi.mocked(isModuleEnabled).mockResolvedValue(true as never);
    const res = await (
      GET as unknown as (...args: never[]) => Promise<Response>
    )();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        glucoseByContext: Record<string, unknown> | null;
        glucoseClinical: unknown | null;
      };
    };
    expect(body.data.glucoseClinical).not.toBeNull();
    expect(body.data.glucoseByContext).not.toBeNull();
    expect(body.data.glucoseByContext?.FASTING).toBeDefined();
  });

  it("nulls glucose clinical + per-context when glucose disabled", async () => {
    seedGlucoseRows();
    vi.mocked(isModuleEnabled).mockImplementation(
      (async (_userId: string, key: string) => key !== "glucose") as never,
    );
    const res = await (
      GET as unknown as (...args: never[]) => Promise<Response>
    )();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        glucoseByContext: Record<string, unknown> | null;
        glucoseClinical: unknown | null;
        summaries: Record<string, { count: number }>;
      };
    };
    // Core metrics still served — the route did NOT 403.
    expect(body.data.summaries.WEIGHT.count).toBe(0);
    // Glucose-only surfaces are nulled.
    expect(body.data.glucoseClinical).toBeNull();
    expect(body.data.glucoseByContext).toBeNull();
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

/**
 * `?slice=` is a closed set, and the cost of it not being one was the point.
 *
 * The route compared the raw string against `"summaries"` and fell through to
 * the DEFAULT body on anything else, so `?slice=summary` answered 200 after
 * running the heaviest chain on the surface. A client could sit on that typo
 * indefinitely and see nothing but a slow, correct-looking response — the
 * failure mode was invisible and expensive at the same time.
 */
describe("GET /api/analytics — the slice parameter is a closed set", () => {
  const call = (url: string) =>
    (GET as unknown as (request: Request) => Promise<Response>)(
      new Request(url),
    );

  it.each(["summary", "SUMMARIES", "default", ""])(
    "refuses ?slice=%s rather than serving the expensive default body",
    async (value) => {
      const res = await call(
        `http://localhost/api/analytics?slice=${encodeURIComponent(value)}`,
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        meta?: { errorCode?: string };
        details?: { issues?: Array<{ path: string }> };
      };
      expect(body.meta?.errorCode).toBe("analytics.invalid_query");
      expect(body.details?.issues?.map((i) => i.path)).toContain("slice");
    },
  );

  it("still serves the default body when the parameter is absent", async () => {
    const res = await call("http://localhost/api/analytics");
    expect(res.status).toBe(200);
  });

  it("still serves the slim body for the one legal value", async () => {
    const res = await call("http://localhost/api/analytics?slice=summaries");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    // The slim slice is recognisable by what it does NOT carry.
    expect(body.data).not.toHaveProperty("healthScore");
    expect(body.data).toHaveProperty("summaries");
  });
});

/**
 * v1.34.5 — the blood-pressure score's basis has to ARRIVE, not merely exist.
 *
 * The grader returns `{ score, basis }` and the pillar builder copies the
 * basis onto the pillar value, and both of those ends have their own unit
 * tests. Neither of them sees the assembly in between: the route's envelope
 * hand-off, the score reader's envelope narrowing, the pillar list, the JSON
 * envelope. A field can be produced correctly, consumed correctly, and still
 * never reach a client, which is precisely how v1.33.1 shipped a payload
 * field that nothing on the wire ever carried.
 *
 * So these drive the REAL route. Nothing about the score is stubbed — the
 * fixture seeds raw blood-pressure rows on the same `$queryRawUnsafe` the
 * live BP path issues, and the route does its own pairing, its own
 * recency-weighting, its own grading and its own serialisation. The whole
 * payload is read back off `res.json()`.
 */
describe("GET /api/analytics — blood-pressure score basis on the wire", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * ESH 2023 band for the fixture's date of birth (age < 65).
   */
  const CLINICAL = { sysHigh: 129, diaHigh: 79 } as const;

  interface WirePillar {
    id: string;
    result: {
      status: string;
      value?: {
        score: number;
        scoreBasis?: {
          axis: string;
          relation: string;
          offsetMmHg: number;
          boundaryMmHg: number;
        };
        observed: { label: string };
        reference: { label: string };
        personalReference?: { label: string };
      };
    };
  }

  /**
   * Seed one blood-pressure pair per day over the trailing `pairs` days.
   * Every pair carries the same reading, so the recency-weighted
   * representative is that reading exactly and the expected score can be
   * stated as a literal instead of a tolerance.
   */
  function seedBpSeries(input: { sys: number; dia: number; pairs: number }) {
    const seriesOf = (value: number) =>
      Array.from({ length: input.pairs }, (_, i) => ({
        measured_at: new Date(Date.now() - (i + 1) * DAY_MS),
        value,
      }));
    const sysRows = seriesOf(input.sys);
    const diaRows = seriesOf(input.dia);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(prisma.$queryRawUnsafe as any).mockImplementation(
      async (sql: unknown) => {
        if (typeof sql !== "string") return [];
        if (sql.includes(`m."type" = 'BLOOD_PRESSURE_SYS'`)) return sysRows;
        if (sql.includes(`m."type" = 'BLOOD_PRESSURE_DIA'`)) return diaRows;
        return [];
      },
    );
  }

  function signInWith(thresholdsJson: unknown) {
    vi.mocked(getSession).mockResolvedValue({
      session: SESSION_OK.session,
      user: { ...SESSION_USER, thresholdsJson },
    } as never);
  }

  async function readBloodPressurePillar(): Promise<WirePillar> {
    const res = await (
      GET as unknown as (...args: never[]) => Promise<Response>
    )();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { healthScore: { pillars: WirePillar[] } | null };
    };
    const pillar = body.data.healthScore?.pillars.find(
      (p) => p.id === "BLOOD_PRESSURE",
    );
    if (!pillar) throw new Error("no BLOOD_PRESSURE pillar in the payload");
    return pillar;
  }

  it("carries the basis onto the pillar the client actually receives", async () => {
    // 137/91 against the 129/79 band: systolic sits 8 over its ceiling and
    // grades 57, diastolic sits 12 over and grades 50. The pillar takes the
    // worse of the two, so diastolic is the axis that set the number.
    seedBpSeries({ sys: 137, dia: 91, pairs: 14 });
    const pillar = await readBloodPressurePillar();

    expect(pillar.result.status).toBe("ok");
    expect(pillar.result.value?.observed.label).toBe("137/91 mmHg");
    expect(pillar.result.value?.score).toBe(50);
    expect(pillar.result.value?.scoreBasis).toEqual({
      axis: "diastolic",
      relation: "above_ceiling",
      offsetMmHg: 12,
      boundaryMmHg: CLINICAL.diaHigh,
    });
  });

  it("says the reading is in band when it is", async () => {
    // 126/68 clears both ceilings, so no axis is over anything and the
    // relation has to say so rather than reporting a distance from a ceiling
    // the reading never reached. Systolic is the nearer of the two to its
    // own ceiling here, so this also puts the other axis on the wire.
    seedBpSeries({ sys: 126, dia: 68, pairs: 14 });
    const pillar = await readBloodPressurePillar();

    expect(pillar.result.value?.observed.label).toBe("126/68 mmHg");
    expect(pillar.result.value?.scoreBasis).toEqual({
      axis: "systolic",
      relation: "in_band",
      offsetMmHg: 3,
      boundaryMmHg: CLINICAL.sysHigh,
    });
  });

  it("omits the basis entirely when the pillar has no score to explain", async () => {
    // Eleven pairs is one short of the floor, so the pillar is insufficient
    // and carries no value at all — the popover must fall back to the
    // shipped lines rather than to an explanation of a number nobody has.
    seedBpSeries({ sys: 137, dia: 91, pairs: 11 });
    const pillar = await readBloodPressurePillar();

    expect(pillar.result.status).toBe("insufficient");
    expect(pillar.result.value).toBeUndefined();
  });

  /**
   * The coupling the two-ended tests cannot see.
   *
   * A user with a personal target gets the whole BP helper run twice: once
   * against their own band for the in-target percentages on the dashboard,
   * once against the clinical band for the score. The score comes from the
   * second run. So does the basis, and it has to, because the two runs
   * disagree on every field of it — different binding axis, different
   * ceiling, different distance. Picking the score off one run and the
   * basis off the other reads as correct in review and produces a popover
   * that explains a number the user is not looking at.
   *
   * The fixture is chosen so the two runs share NOTHING: 137/91 against the
   * personal 135/95 band binds on systolic 2 over 135 and scores 77; against
   * the clinical 129/79 band it binds on diastolic 12 over 79 and scores 50.
   */
  it("takes the basis from the same run as the score when a personal target differs", async () => {
    signInWith({
      BLOOD_PRESSURE_SYS: { min: 110, max: 135 },
      BLOOD_PRESSURE_DIA: { min: 65, max: 95 },
    });
    seedBpSeries({ sys: 137, dia: 91, pairs: 14 });
    const pillar = await readBloodPressurePillar();

    // The personal band is genuinely in play — this account really does take
    // the route's second-run branch, so the assertions below are about the
    // coupling and not about a user who has no personal target at all.
    expect(pillar.result.value?.personalReference?.label).toBe(
      "110–135/65–95 mmHg",
    );

    expect(pillar.result.value?.score).toBe(50);
    expect(pillar.result.value?.scoreBasis).toEqual({
      axis: "diastolic",
      relation: "above_ceiling",
      offsetMmHg: 12,
      boundaryMmHg: CLINICAL.diaHigh,
    });
    // Stated negatively as well: nothing from the personal run may leak in.
    expect(pillar.result.value?.scoreBasis?.boundaryMmHg).not.toBe(135);
  });
});
