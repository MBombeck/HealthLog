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
    moodEntry: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
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
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-comp-1",
    username: "marc",
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
  // Default to assistant-on so the gate doesn't 403 every test.
  (
    prisma.appSettings.findUnique as ReturnType<typeof vi.fn>
  ).mockResolvedValue(null);
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    heightCm: 180,
    dateOfBirth: new Date("1985-01-01"),
  });
  (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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
    (
      buildComprehensiveAggregate as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      summaries: {},
      bpRawRows: { sys: [], dia: [] },
      dailyByType: {},
      firstMeasurementAt: null,
      totalMeasurements: 0,
    });

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
    (
      buildComprehensiveAggregate as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
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
      dailyByType: {},
      firstMeasurementAt: new Date(),
      totalMeasurements: 1,
    });

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
    (
      buildComprehensiveAggregate as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
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
      dailyByType: {},
      firstMeasurementAt: at,
      totalMeasurements: 2,
    });

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
    (
      buildComprehensiveAggregate as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      summaries: {},
      bpRawRows: { sys: [], dia: [] },
      dailyByType: {
        WEIGHT: days.map((d, i) => ({ day: d, value: 80 + i })),
        BLOOD_PRESSURE_SYS: days.map((d, i) => ({ day: d, value: 120 + i * 2 })),
      },
      firstMeasurementAt: new Date(),
      totalMeasurements: 10,
    });

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
