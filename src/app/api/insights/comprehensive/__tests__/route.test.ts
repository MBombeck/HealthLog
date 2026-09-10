/**
 * v1.4.35 — unit-level shape-parity pin for the comprehensive route.
 *
 * The integration coverage (`tests/integration/insights-comprehensive-cache.test.ts`)
 * exercises the route end-to-end against the real Postgres testcontainer
 * including cache hit/miss. This file mocks the SQL aggregator so the
 * envelope shape — exactly what the /insights page consumes — is
 * pinned without a container.
 *
 * What this test covers:
 *   - Every key the legacy route emitted is still on the response.
 *   - Empty user → bmi=null, every correlation null, scatter arrays
 *     empty, totalMeasurements=0, alerts is an array.
 *   - The route reads from the aggregator (not a 100k-row findMany).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn(), findFirst: vi.fn() },
    moodEntryRollup: { findMany: vi.fn(), findFirst: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

// v1.4.40 — stub the mood-rollup warm-up so test runs don't fire the
// real recompute against the mocked Prisma. The route fires the
// warm-up as fire-and-forget; the return value is irrelevant.
vi.mock("@/lib/rollups/mood-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/mood-rollups")
  >("@/lib/rollups/mood-rollups");
  return {
    ...actual,
    ensureUserMoodRollupsFresh: vi
      .fn()
      .mockResolvedValue({ recomputed: false }),
  };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// v1.15.20 — the route checks the shared analytics-read budget before any
// DB work; the real helper would hit the unmocked `$queryRaw`.
vi.mock("@/lib/rate-limit", () => ({
  checkAnalyticsReadRateLimit: vi.fn(),
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

// Mock the aggregator so we feed a controlled fixture without going
// near Postgres. The route's own assembly logic (correlations,
// classifications, alerts) is what we want to pin.
vi.mock("@/lib/insights/comprehensive-aggregator", () => ({
  buildComprehensiveAggregate: vi.fn(),
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn(async () => ({ type: "none" })),
}));

vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn(async () => ({})),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { buildComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { getMedicationCategories } from "@/lib/medication-category";
import { __resetAllCachesForTests, caches } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-comp-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/comprehensive");
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetAllCachesForTests();
  // v1.15.20 — default to an allowing analytics-read budget.
  vi.mocked(checkAnalyticsReadRateLimit).mockResolvedValue({
    allowed: true,
    limit: 120,
    remaining: 119,
    resetAt: Date.now() + 60_000,
  });
  // Default to assistant-on so the gate doesn't 403 every test.
  (prisma.appSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
    null,
  );
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    heightCm: 180,
    dateOfBirth: new Date("1985-01-01"),
  });
  (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // The resting-pulse pairing (M-CS2) reads RESTING_HEART_RATE rows (and the
  // raw-PULSE proxy only when none exist) straight from the measurement table.
  (prisma.measurement.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  (
    prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  (prisma.medication.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  (
    prisma.medicationIntakeEvent.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
});

describe("GET /api/insights/comprehensive — envelope shape", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });

  it("emits every legacy envelope key for an empty user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        bpRawRows: { sys: [], dia: [] },
        weightRawRows: [],
        dailyByType: {},
        firstMeasurementAt: null,
        totalMeasurements: 0,
      },
    );

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };

    // Every legacy key — the consumer (`/insights` page) reads each of
    // these. If any one disappears the page silently breaks.
    const requiredKeys = [
      "summaries",
      "bmi",
      "bmiClassification",
      "bpClassification",
      "bpPctInTarget",
      "bpTargets",
      "weightBpCorrelation",
      "scatterData",
      "bpMedicationCorrelation",
      "bpMedicationScatterData",
      "moodSummary",
      "moodBpCorrelation",
      "moodBpScatterData",
      "moodWeightCorrelation",
      "moodWeightScatterData",
      "moodPulseCorrelation",
      "moodPulseScatterData",
      "medications",
      "alerts",
      "hasProvider",
      "dataSpanDays",
      "totalMeasurements",
    ];
    for (const key of requiredKeys) {
      expect(body.data).toHaveProperty(key);
    }

    expect(body.data.bmi).toBeNull();
    expect(body.data.bmiClassification).toBeNull();
    expect(body.data.scatterData).toEqual([]);
    expect(body.data.bpMedicationScatterData).toEqual([]);
    expect(body.data.medications).toEqual([]);
    expect(Array.isArray(body.data.alerts)).toBe(true);
    expect(body.data.totalMeasurements).toBe(0);
    expect(body.data.dataSpanDays).toBe(0);
  });

  it("computes BMI from aggregate WEIGHT.latest and user heightCm", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {
          WEIGHT: {
            count: 1,
            latest: 81.0,
            min: 81.0,
            max: 81.0,
            mean: 81.0,
            avg7: 81.0,
            avg30: 81.0,
            slope7: null,
            slope30: null,
            slope90: null,
            anomalyCount: 0,
            avg30LastMonth: null,
            avg30LastYear: null,
          },
        },
        bpRawRows: { sys: [], dia: [] },
        weightRawRows: [],
        dailyByType: {},
        firstMeasurementAt: new Date(),
        totalMeasurements: 1,
      },
    );

    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: { bmi: number | null; bmiClassification: { category: string } };
    };
    // BMI = 81 / (1.80 ^ 2) = 25.0 → "Overweight" in classifyBMI.
    expect(body.data.bmi).toBeCloseTo(25, 1);
    expect(body.data.bmiClassification.category).toBe("Overweight");
  });

  it("pairs sys + dia raw rows with 5-min tolerance for bpPctInTarget", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const at = new Date("2026-05-10T08:00:00Z");
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {
          BLOOD_PRESSURE_SYS: {
            count: 1,
            latest: 125,
            min: 125,
            max: 125,
            mean: 125,
            avg7: 125,
            avg30: 125,
            slope7: null,
            slope30: null,
            slope90: null,
            anomalyCount: 0,
            avg30LastMonth: null,
            avg30LastYear: null,
          },
          BLOOD_PRESSURE_DIA: {
            count: 1,
            latest: 75,
            min: 75,
            max: 75,
            mean: 75,
            avg7: 75,
            avg30: 75,
            slope7: null,
            slope30: null,
            slope90: null,
            anomalyCount: 0,
            avg30LastMonth: null,
            avg30LastYear: null,
          },
        },
        bpRawRows: {
          sys: [{ measuredAt: at, value: 125 }],
          dia: [{ measuredAt: at, value: 75 }],
        },
        weightRawRows: [],
        dailyByType: {},
        firstMeasurementAt: at,
        totalMeasurements: 2,
      },
    );

    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        bpPctInTarget: number | null;
        bpClassification: { category: string } | null;
      };
    };
    // 125/75 sits inside the under-65 target ceiling (sysHigh=129,
    // diaHigh=79) and above the hypotension floor → 100% in target.
    expect(body.data.bpPctInTarget).toBe(100);
    // avg30 sys=125, dia=75 → ESH "Normal" band.
    expect(body.data.bpClassification?.category).toBe("Normal");
  });

  // v1.30.3 (QA F7 — completes the "caller has it" pairing-tz fix across
  // every `computeBpInTargetPct` call site, not just the fast-path).
  it("pairs bpPctInTarget on the session user's own tz, not a hardcoded Berlin day", async () => {
    vi.mocked(getSession).mockResolvedValue({
      ...SESSION_OK,
      user: { ...SESSION_OK.user, timezone: "America/New_York" },
    } as never);
    // 2026-05-14T21:50Z = 23:50 Berlin (05-14) / 17:50 New York (05-14).
    // 2026-05-14T22:10Z = 00:10 Berlin (05-15, the NEXT Berlin day) /
    // 18:10 New York (05-14, the SAME New York day). >5-min gap, so only
    // the same-calendar-day fallback can pair them — and only New York
    // agrees with itself.
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        bpRawRows: {
          sys: [{ measuredAt: new Date("2026-05-14T21:50:00Z"), value: 125 }],
          dia: [{ measuredAt: new Date("2026-05-14T22:10:00Z"), value: 75 }],
        },
        weightRawRows: [],
        dailyByType: {},
        firstMeasurementAt: new Date("2026-05-14T21:50:00Z"),
        totalMeasurements: 2,
      },
    );

    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: { bpPctInTarget: number | null };
    };
    // A Berlin-day pairing would reject this pair (different Berlin
    // calendar days) and read null; the user's own tz accepts it.
    expect(body.data.bpPctInTarget).toBe(100);
  });

  it("consumes the mood-rollup tier and skips the raw findMany when DAY rows exist", async () => {
    // v1.4.40 W-INSIGHTS — rollup-tier read swap parity. Three DAY rows
    // populated → the route reads them directly and never touches the
    // raw `moodEntry.findMany`. `moodSummary` is computed over per-day
    // mean DataPoints, matching the rollup-tier convention shipped by
    // `/api/mood/analytics` post-v1.4.39.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        bpRawRows: { sys: [], dia: [] },
        weightRawRows: [],
        dailyByType: {},
        firstMeasurementAt: new Date(),
        totalMeasurements: 0,
      },
    );
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        userId: "user-comp-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-08T00:00:00.000Z"),
        count: 1,
        mean: 4,
        minScore: 4,
        maxScore: 4,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: "user-comp-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-09T00:00:00.000Z"),
        count: 2,
        mean: 4.5,
        minScore: 4,
        maxScore: 5,
        sd: 0.5,
        computedAt: new Date(),
      },
    ]);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);

    // Raw findMany must not fire on the rollup-tier fast path.
    expect(prisma.moodEntry.findMany).not.toHaveBeenCalled();

    const body = (await res.json()) as {
      data: { moodSummary: { count: number; mean: number | null } | null };
    };
    // `summarize()` is called over two DataPoints (one per day).
    expect(body.data.moodSummary).not.toBeNull();
    expect(body.data.moodSummary?.count).toBe(2);
    // Mean of (4 + 4.5) / 2 = 4.25
    expect(body.data.moodSummary?.mean).toBeCloseTo(4.25, 2);
  });

  it("falls back to the bounded live walk when the rollup tier is empty but raw mood entries exist", async () => {
    // v1.4.40 W-INSIGHTS — coverage-fallback parity. Legacy account
    // with raw entries but no rollup coverage yet. The route runs the
    // legacy bounded walk once; the warm-up helper (stubbed) is
    // supposed to fire fire-and-forget so the next request lands on
    // the rollup tier.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        bpRawRows: { sys: [], dia: [] },
        weightRawRows: [],
        dailyByType: {},
        firstMeasurementAt: new Date(),
        totalMeasurements: 0,
      },
    );
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
    (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        date: "2026-05-08",
        score: 4,
        moodLoggedAt: new Date("2026-05-08T12:00:00.000Z"),
      },
      {
        date: "2026-05-09",
        score: 5,
        moodLoggedAt: new Date("2026-05-09T12:00:00.000Z"),
      },
    ]);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);

    expect(prisma.moodEntry.findMany).toHaveBeenCalledTimes(1);

    const body = (await res.json()) as {
      data: { moodSummary: { count: number } | null };
    };
    expect(body.data.moodSummary).not.toBeNull();
    expect(body.data.moodSummary?.count).toBe(2);
  });

  it("derives weight × BP scatter from daily-bucketed series", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Five day-aligned pairs (n >= 5 unlocks pearsonCorrelation).
    const days = [
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
      "2026-05-05",
    ];
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        bpRawRows: { sys: [], dia: [] },
        weightRawRows: [],
        dailyByType: {
          WEIGHT: days.map((d, i) => ({ day: d, value: 80 + i })),
          BLOOD_PRESSURE_SYS: days.map((d, i) => ({
            day: d,
            value: 120 + i * 2,
          })),
        },
        firstMeasurementAt: new Date(),
        totalMeasurements: 10,
      },
    );

    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        scatterData: Array<{ weight: number; sysBP: number }>;
        weightBpCorrelation: { r: number; n: number } | null;
      };
    };
    expect(body.data.scatterData).toHaveLength(5);
    expect(body.data.scatterData[0]).toEqual({ weight: 80, sysBP: 120 });
    // Perfect linear relationship → r === 1.
    expect(body.data.weightBpCorrelation?.r).toBe(1);
    expect(body.data.weightBpCorrelation?.n).toBe(5);
  });
});

// v1.16.7 — the route serves a marked-stale cache entry immediately
// (stale-while-revalidate) and must mark that body `revalidating: true`
// so the client can poll until the background rebuild lands. A fresh
// (cold or warm) read carries `revalidating: false`.
describe("GET /api/insights/comprehensive — stale-while-revalidate marker", () => {
  const EMPTY_AGGREGATE = {
    summaries: {},
    bpRawRows: { sys: [], dia: [] },
    weightRawRows: [],
    dailyByType: {},
    firstMeasurementAt: null,
    totalMeasurements: 0,
  };

  it("marks a cold (inline-computed) read revalidating: false", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      EMPTY_AGGREGATE,
    );

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { revalidating: boolean } };
    expect(body.data.revalidating).toBe(false);
  });

  it("marks a stale-served read revalidating: true and a converged read false again", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      EMPTY_AGGREGATE,
    );

    // Prime the cache entry (cold compute).
    await callGet(makeReq());

    // A measurement sync marks the bucket stale (the invalidate helper's
    // default posture) — the next read serves the prior body + the flag.
    caches.analytics.markStaleByPrefix(`${SESSION_OK.user.id}|`);
    const staleRes = await callGet(makeReq());
    expect(staleRes.status).toBe(200);
    const staleBody = (await staleRes.json()) as {
      data: { revalidating: boolean };
    };
    expect(staleBody.data.revalidating).toBe(true);

    // The stale read kicked off a background rebuild; once it settles
    // (the cache entry is fresh again) the next read is a plain hit and
    // the flag drops so the poll stops.
    await vi.waitFor(() => {
      const entry = caches.analytics.getAllowStale(
        `${SESSION_OK.user.id}|comprehensive`,
      );
      expect(entry?.stale).toBe(false);
    });
    const freshRes = await callGet(makeReq());
    const freshBody = (await freshRes.json()) as {
      data: { revalidating: boolean };
    };
    expect(freshBody.data.revalidating).toBe(false);
  });
});

// v1.32.17 (R1) — mood × metric correlations must pair on the LOCAL
// logging day. The mood series has been local-day-keyed since v1.32.12;
// the three metric partners (sys BP, weight, resting pulse) were still
// UTC-keyed, so for non-UTC users an evening reading landed a day off and
// paired with the wrong mood entry. These tests run under CI's TZ=UTC and
// carry tz-explicit fixtures so the assertions are host-TZ-independent.
describe("GET /api/insights/comprehensive — mood × metric local-day pairing (v1.32.17)", () => {
  type MoodBody = {
    data: {
      moodBpScatterData: Array<{ mood: number; sysBP: number }>;
      moodWeightScatterData: Array<{ mood: number; weight: number }>;
      moodPulseScatterData: Array<{ mood: number; pulse: number }>;
      scatterData: Array<{ weight: number; sysBP: number }>;
      weightBpCorrelation: unknown;
      bpMedicationCorrelation: unknown;
    };
  };

  function moodRollupDay(midnightZ: string, mean: number, count = 1) {
    return {
      userId: "user-comp-1",
      granularity: "DAY",
      bucketStart: new Date(midnightZ),
      count,
      mean,
      minScore: mean,
      maxScore: mean,
      sd: null,
      computedAt: new Date(),
    };
  }

  function sessionWithTz(tz: string) {
    vi.mocked(getSession).mockResolvedValue({
      ...SESSION_OK,
      user: { ...SESSION_OK.user, timezone: tz },
    } as never);
  }

  it("Berlin: a mood + BP logged the same local evening now pair (previously dropped)", async () => {
    sessionWithTz("Europe/Berlin");
    // Mood logged 00:30 local on 2026-07-10 → rollup bucketStart is the
    // canonical local day at UTC midnight.
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([moodRollupDay("2026-07-10T00:00:00.000Z", 4)]);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        // 22:35Z = 00:35 Berlin on Jul 10 → local day 2026-07-10, but UTC
        // day 2026-07-09. The old UTC `dailyByType` key (below) would never
        // match the mood's local 2026-07-10 → the pair was dropped.
        bpRawRows: {
          sys: [{ measuredAt: new Date("2026-07-09T22:35:00Z"), value: 128 }],
          dia: [],
        },
        weightRawRows: [],
        dailyByType: {
          BLOOD_PRESSURE_SYS: [{ day: "2026-07-09", value: 128 }],
        },
        firstMeasurementAt: new Date("2026-07-09T22:35:00Z"),
        totalMeasurements: 1,
      },
    );

    const res = await callGet(makeReq());
    const body = (await res.json()) as MoodBody;
    // Derived from the raw row in the user's tz → pairs on local 2026-07-10.
    expect(body.data.moodBpScatterData).toEqual([{ mood: 4, sysBP: 128 }]);
  });

  it("New York: the lag-1 offset is gone — each pair couples mood(D) with the metric logged local day D", async () => {
    sessionWithTz("America/New_York");
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      moodRollupDay("2026-07-10T00:00:00.000Z", 2),
      moodRollupDay("2026-07-11T00:00:00.000Z", 3),
      moodRollupDay("2026-07-12T00:00:00.000Z", 4),
    ]);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        // Each sys row is at (D+1)T01:00Z = 21:00 local on day D (EDT UTC-4).
        // Old UTC code keyed each on D+1 and paired it with mood(D+1) — a
        // lag-1 correlation sold as same-day. Local derivation keys on D.
        bpRawRows: {
          sys: [
            { measuredAt: new Date("2026-07-11T01:00:00Z"), value: 120 },
            { measuredAt: new Date("2026-07-12T01:00:00Z"), value: 130 },
            { measuredAt: new Date("2026-07-13T01:00:00Z"), value: 140 },
          ],
          dia: [],
        },
        weightRawRows: [],
        dailyByType: {},
        firstMeasurementAt: new Date("2026-07-11T01:00:00Z"),
        totalMeasurements: 3,
      },
    );

    const res = await callGet(makeReq());
    const body = (await res.json()) as MoodBody;
    // mood(07-10)=2 ↔ 120 (logged local 07-10), not 130 (the old +1 offset).
    expect(body.data.moodBpScatterData).toEqual([
      { mood: 2, sysBP: 120 },
      { mood: 3, sysBP: 130 },
      { mood: 4, sysBP: 140 },
    ]);
  });

  it("Berlin: mood × weight and mood × resting pulse also pair on the local day (all three partners moved)", async () => {
    sessionWithTz("Europe/Berlin");
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([moodRollupDay("2026-07-10T00:00:00.000Z", 4)]);
    // Resting-HR row at 00:30 local Jul 10 (= 22:30Z Jul 9).
    (prisma.measurement.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [{ measuredAt: new Date("2026-07-09T22:30:00Z"), value: 58 }],
    );
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        bpRawRows: { sys: [], dia: [] },
        // Weight row at 00:30 local Jul 10 (= 22:30Z Jul 9).
        weightRawRows: [
          { measuredAt: new Date("2026-07-09T22:30:00Z"), value: 80.5 },
        ],
        dailyByType: {},
        firstMeasurementAt: new Date("2026-07-09T22:30:00Z"),
        totalMeasurements: 2,
      },
    );

    const res = await callGet(makeReq());
    const body = (await res.json()) as MoodBody;
    expect(body.data.moodWeightScatterData).toEqual([
      { mood: 4, weight: 80.5 },
    ]);
    expect(body.data.moodPulseScatterData).toEqual([{ mood: 4, pulse: 58 }]);
  });

  it("UTC user: pairing is byte-identical to the pre-fix UTC-slice join (invariance)", async () => {
    sessionWithTz("UTC");
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([moodRollupDay("2026-07-10T00:00:00.000Z", 4)]);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        // Under UTC, `userDayKey` degenerates to the ISO slice, so the raw
        // derivation reproduces exactly what the old `dailyByType` join gave.
        bpRawRows: {
          sys: [{ measuredAt: new Date("2026-07-10T08:00:00Z"), value: 122 }],
          dia: [],
        },
        weightRawRows: [],
        dailyByType: {
          BLOOD_PRESSURE_SYS: [{ day: "2026-07-10", value: 122 }],
        },
        firstMeasurementAt: new Date("2026-07-10T08:00:00Z"),
        totalMeasurements: 1,
      },
    );

    const res = await callGet(makeReq());
    const body = (await res.json()) as MoodBody;
    expect(body.data.moodBpScatterData).toEqual([{ mood: 4, sysBP: 122 }]);
  });

  it("metric × metric guard: weight × BP and BP-med continuity are byte-identical across timezones (UTC joins untouched)", async () => {
    // R1 must NOT re-key the two internally-consistent UTC joins
    // (weight × BP, BP-med continuity) — those migrate with the rollup
    // tier in R12. Both read the UTC `dailyByType` / UTC `scheduledFor`
    // slice, so their output must be invariant to the caller's timezone.
    // Run the SAME fixture under UTC then America/New_York and deep-equal.
    const days = [
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
      "2026-05-05",
    ];
    const aggregate = {
      summaries: {},
      bpRawRows: { sys: [], dia: [] },
      weightRawRows: [],
      dailyByType: {
        WEIGHT: days.map((d, i) => ({ day: d, value: 80 + i })),
        BLOOD_PRESSURE_SYS: days.map((d, i) => ({
          day: d,
          value: 120 + i * 2,
        })),
      },
      firstMeasurementAt: new Date(),
      totalMeasurements: 10,
    };
    const medication = {
      id: "med-bp",
      name: "Amlodipine",
      dose: "5mg",
      active: true,
      asNeeded: false,
      createdAt: new Date("2026-04-01T00:00:00Z"),
      schedules: [
        {
          id: "sch-1",
          windowStart: "07:00",
          windowEnd: "08:00",
          timesOfDay: ["07:00"],
          daysOfWeek: null,
          rrule: null,
          rollingIntervalDays: null,
          reminderGraceMinutes: null,
          scheduleType: "SCHEDULED",
          cyclicOnWeeks: null,
          cyclicOffWeeks: null,
          doseWindows: [],
        },
      ],
      scheduleRevisions: [],
      pauseEras: [],
    };
    // Intake taken on the first three days, logged as skipped on the last
    // two → a non-degenerate continuity series. The skips used to be absent
    // rows: a day with no record read as a measured 0 % continuity, which is
    // the fabrication the route no longer makes, and a fixture that relies on
    // it would be pinning the defect rather than the timezone question this
    // test asks. Recording the two days as skips keeps five paired days AND
    // keeps every one of them a thing the person actually logged.
    const intakeEvents = days.map((d, i) => ({
      medicationId: "med-bp",
      userId: "user-comp-1",
      deletedAt: null,
      scheduledFor: new Date(`${d}T07:00:00Z`),
      takenAt: i < 3 ? new Date(`${d}T07:05:00Z`) : null,
      skipped: i >= 3,
    }));

    function primeMocks() {
      (
        buildComprehensiveAggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue(aggregate);
      (
        prisma.medication.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([medication]);
      (
        prisma.medicationIntakeEvent.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue(intakeEvents);
      vi.mocked(getMedicationCategories).mockResolvedValue({
        "med-bp": "BLOOD_PRESSURE",
      });
    }

    sessionWithTz("UTC");
    primeMocks();
    const utcBody = (await (await callGet(makeReq())).json()) as MoodBody;

    // Fresh cache so the second run recomputes rather than serving the
    // cached UTC body under the same user id.
    __resetAllCachesForTests();

    sessionWithTz("America/New_York");
    primeMocks();
    const nyBody = (await (await callGet(makeReq())).json()) as MoodBody;

    expect(nyBody.data.scatterData).toEqual(utcBody.data.scatterData);
    expect(nyBody.data.weightBpCorrelation).toEqual(
      utcBody.data.weightBpCorrelation,
    );
    expect(nyBody.data.bpMedicationCorrelation).toEqual(
      utcBody.data.bpMedicationCorrelation,
    );
    // And the guard is meaningful only if these joins actually produced
    // output to compare.
    expect(utcBody.data.scatterData).toHaveLength(5);
    expect(utcBody.data.bpMedicationCorrelation).not.toBeNull();
  });
});

// A medication with no schedule expects no dose, so it has no adherence to
// report. `calculateCompliance` answers `rate: 100, totalExpected: 0` for that
// case — arithmetically true and a lie on a surface that reads the number as
// adherence. The doctor report has excluded both the PRN arm and the empty
// schedule since it was written, with the reason beside it; this envelope
// filtered only PRN, so a scheduled medication saved without a schedule (which
// `POST /api/medications` accepts) reported perfect adherence to the reader and
// to the prompt built from the same array.
describe("GET /api/insights/comprehensive — no adherence without an expectation", () => {
  const EMPTY_AGGREGATE = {
    summaries: {},
    bpRawRows: { sys: [], dia: [] },
    weightRawRows: [],
    dailyByType: {},
    firstMeasurementAt: null,
    totalMeasurements: 0,
  };

  type MedBody = {
    data: {
      medications: Array<{
        id: string;
        name: string;
        compliance7: number;
        compliance30: number;
      }>;
    };
  };

  function scheduledMed(id: string, name: string, schedules: unknown[]) {
    return {
      id,
      name,
      dose: "5mg",
      active: true,
      asNeeded: false,
      createdAt: new Date("2026-04-01T00:00:00Z"),
      schedules,
      scheduleRevisions: [],
      pauseEras: [],
    };
  }

  const SCHEDULE = {
    id: "sch-1",
    windowStart: "07:00",
    windowEnd: "08:00",
    timesOfDay: ["07:00"],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    doseWindows: [],
  };

  it("leaves a scheduled medication with no schedule out of the compliance list", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      EMPTY_AGGREGATE,
    );
    (prisma.medication.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      scheduledMed("med-none", "Unscheduled", []),
      scheduledMed("med-real", "Amlodipine", [SCHEDULE]),
    ]);

    const body = (await (await callGet(makeReq())).json()) as MedBody;

    const names = body.data.medications.map((m) => m.name);
    expect(names).not.toContain("Unscheduled");
    // The medication that DOES expect a dose still reports, so this is a
    // filter and not a blanket suppression.
    expect(names).toContain("Amlodipine");
  });

  it("never reports 100 % for a medication with nothing expected of it", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      EMPTY_AGGREGATE,
    );
    (prisma.medication.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      scheduledMed("med-none", "Unscheduled", []),
    ]);

    const body = (await (await callGet(makeReq())).json()) as MedBody;

    expect(body.data.medications).toEqual([]);
  });
});

// The medication-continuity correlation joined every day that had a systolic
// reading against `takenByDay.get(day) ?? 0`. A day the reader simply never
// logged an intake for therefore entered the scatter and the coefficient as a
// measured 0 % continuity. Absence is not zero anywhere else in this project
// and it is not zero here: a day with a logged skip is a real zero and stays,
// a day with no record at all drops out.
describe("GET /api/insights/comprehensive — an unlogged day is not a zero", () => {
  type BpBody = {
    data: {
      bpMedicationScatterData: Array<{ continuityPct: number; sysBP: number }>;
      bpMedicationCorrelation: { n: number } | null;
    };
  };

  const DAYS = [
    "2026-05-01",
    "2026-05-02",
    "2026-05-03",
    "2026-05-04",
    "2026-05-05",
  ];

  const MEDICATION = {
    id: "med-bp",
    name: "Amlodipine",
    dose: "5mg",
    active: true,
    asNeeded: false,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    schedules: [
      {
        id: "sch-1",
        windowStart: "07:00",
        windowEnd: "08:00",
        timesOfDay: ["07:00"],
        daysOfWeek: null,
        rrule: null,
        rollingIntervalDays: null,
        reminderGraceMinutes: null,
        scheduleType: "SCHEDULED",
        cyclicOnWeeks: null,
        cyclicOffWeeks: null,
        doseWindows: [],
      },
    ],
    scheduleRevisions: [],
    pauseEras: [],
  };

  function primeBp(
    events: Array<{ day: string; takenAt: Date | null; skipped: boolean }>,
  ) {
    (buildComprehensiveAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        summaries: {},
        bpRawRows: { sys: [], dia: [] },
        weightRawRows: [],
        dailyByType: {
          BLOOD_PRESSURE_SYS: DAYS.map((d, i) => ({
            day: d,
            value: 120 + i * 2,
          })),
        },
        firstMeasurementAt: new Date(),
        totalMeasurements: 10,
      },
    );
    (prisma.medication.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      MEDICATION,
    ]);
    (
      prisma.medicationIntakeEvent.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue(
      events.map((e) => ({
        medicationId: "med-bp",
        userId: "user-comp-1",
        deletedAt: null,
        scheduledFor: new Date(`${e.day}T07:00:00Z`),
        takenAt: e.takenAt,
        skipped: e.skipped,
      })),
    );
    vi.mocked(getMedicationCategories).mockResolvedValue({
      "med-bp": "BLOOD_PRESSURE",
    });
  }

  it("keeps only the days that carry an intake record", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Three days logged; the last two were never touched.
    primeBp(
      DAYS.slice(0, 3).map((day) => ({
        day,
        takenAt: new Date(`${day}T07:05:00Z`),
        skipped: false,
      })),
    );

    const body = (await (await callGet(makeReq())).json()) as BpBody;

    expect(body.data.bpMedicationScatterData).toHaveLength(3);
    // The two unlogged days would have entered as 0 % against their own
    // systolic reading; both are gone.
    expect(body.data.bpMedicationScatterData.map((p) => p.sysBP)).not.toContain(
      126,
    );
    expect(
      body.data.bpMedicationScatterData.every((p) => p.continuityPct === 100),
    ).toBe(true);
  });

  it("keeps a logged skip, which is a real zero", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeBp([
      ...DAYS.slice(0, 3).map((day) => ({
        day,
        takenAt: new Date(`${day}T07:05:00Z`),
        skipped: false,
      })),
      { day: DAYS[3], takenAt: null, skipped: true },
    ]);

    const body = (await (await callGet(makeReq())).json()) as BpBody;

    expect(body.data.bpMedicationScatterData).toHaveLength(4);
    expect(body.data.bpMedicationScatterData).toContainEqual({
      continuityPct: 0,
      sysBP: 126,
    });
  });
});
