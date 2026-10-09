import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        dateOfBirth: new Date("1986-01-01"),
        gender: "MALE",
      }),
    },
  },
}));

// v1.18.0 — the route now resolves the `insights` module gate after
// `requireAuth()` (in addition to the existing per-metric sleep/recovery
// gate). Mock it default-enabled so the existing assertions ride through;
// the off → 403 coverage lives in the route-gate inventory test.
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
// v1.15.20 — the route checks the shared analytics-read budget before any
// DB work; the real helper would hit the unmocked `$queryRaw`. This file
// uses `clearAllMocks` (implementations survive), so the factory default
// is enough.
vi.mock("@/lib/rate-limit", () => ({
  checkAnalyticsReadRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 119,
    resetAt: 0,
  }),
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

// Stub the compute layer so the route test stays isolated.
vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived")>();
  return {
    ...actual,
    computeDerivedMetric: vi.fn(async () => ({
      status: "ok",
      value: {
        type: "RESTING_HEART_RATE",
        center: 55,
        low: 48,
        high: 62,
        spread: 7,
        sampleDays: 30,
        k: 3,
      },
      coverage: {
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 30,
        missing: [],
      },
      confidence: { score: 100, band: "high" },
      provenance: {
        inputs: ["RESTING_HEART_RATE"],
        source: "DAY",
        windowDays: 30,
        computedAt: "2026-06-02T07:00:00+02:00",
      },
    })),
  };
});

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { computeDerivedMetric } from "@/lib/insights/derived";
import { DERIVED_MAX_WINDOW_DAYS } from "@/lib/insights/derived/types";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(metric?: string, type?: string): NextRequest {
  const url = new URL("http://localhost/api/insights/derived");
  if (metric !== undefined) url.searchParams.set("metric", metric);
  if (type !== undefined) url.searchParams.set("type", type);
  return new NextRequest(url);
}

function makeReqWith(params: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/insights/derived");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  // v1.42 — the route reads through the derived cache now.
  __resetAllCachesForTests();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    dateOfBirth: new Date("1986-01-01"),
    gender: "MALE",
  } as never);
});

describe("GET /api/insights/derived", () => {
  it("returns 200 + a flat Derived envelope for a valid metric", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("VITALS_BASELINE", "RESTING_HEART_RATE"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        metric: string;
        status: string;
        value: { center: number } | null;
        coverage: { historyDays: number };
        confidence: { band: string } | null;
        provenance: { source: string };
        reason: string | null;
      } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.metric).toBe("VITALS_BASELINE");
    expect(body.data?.status).toBe("ok");
    expect(body.data?.value?.center).toBe(55);
    expect(body.data?.confidence?.band).toBe("high");
    expect(body.data?.provenance.source).toBe("DAY");
    expect(body.data?.reason).toBeNull();
  });

  it("narrows userId from the session into the compute call (never a query field)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("VITALS_BASELINE"));
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", metric: "VITALS_BASELINE" }),
    );
  });

  it("422s on an unknown metric without calling compute", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("NOT_A_METRIC"));
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("422s on a missing metric param", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq("VITALS_BASELINE"));
    expect(res.status).toBe(401);
  });

  it("flattens an insufficient result with a null value + reason", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(computeDerivedMetric).mockResolvedValueOnce({
      status: "insufficient",
      coverage: {
        requiredInputs: 1,
        presentInputs: 0,
        historyDays: 0,
        missing: ["RESTING_HEART_RATE"],
      },
      provenance: {
        inputs: ["RESTING_HEART_RATE"],
        source: "none",
        windowDays: 30,
        computedAt: "2026-06-02T07:00:00+02:00",
      },
      reason: "no_readings_in_window",
    } as never);
    const res = await callGet(makeReq("VITALS_BASELINE"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        status: string;
        value: unknown;
        confidence: unknown;
        reason: string;
      } | null;
    };
    expect(body.data?.status).toBe("insufficient");
    expect(body.data?.value).toBeNull();
    expect(body.data?.confidence).toBeNull();
    expect(body.data?.reason).toBe("no_readings_in_window");
  });
});

describe("GET /api/insights/derived — windowDays", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  });

  it("threads a caller-supplied window into the compute call", async () => {
    await callGet(makeReqWith({ metric: "VITALS_BASELINE", windowDays: "30" }));
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ metric: "VITALS_BASELINE", windowDays: 30 }),
    );
  });

  it("leaves the window undefined when the caller omits it, so each engine keeps its own default", async () => {
    await callGet(makeReq("VITALS_BASELINE"));
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: undefined }),
    );
  });

  it("accepts the ceiling exactly", async () => {
    const res = await callGet(
      makeReqWith({
        metric: "VITALS_BASELINE",
        windowDays: String(DERIVED_MAX_WINDOW_DAYS),
      }),
    );
    expect(res.status).toBe(200);
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: DERIVED_MAX_WINDOW_DAYS }),
    );
  });

  it("422s one day past the ceiling without touching the compute layer", async () => {
    const res = await callGet(
      makeReqWith({
        metric: "VITALS_BASELINE",
        windowDays: String(DERIVED_MAX_WINDOW_DAYS + 1),
      }),
    );
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("422s on a zero, negative, fractional or non-numeric window", async () => {
    for (const windowDays of ["0", "-7", "1.5", "thirty", ""]) {
      vi.clearAllMocks();
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      const res = await callGet(
        makeReqWith({ metric: "VITALS_BASELINE", windowDays }),
      );
      expect(res.status, `windowDays=${windowDays}`).toBe(422);
      expect(computeDerivedMetric).not.toHaveBeenCalled();
    }
  });
});

// v1.42 — the single-score read was the one derived surface with no cache:
// every open of a score's detail recomputed it over the rollup tier.
describe("GET /api/insights/derived — read-through cache (v1.42)", () => {
  it("serves a repeat read from the cache, per metric, type and window", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("VITALS_BASELINE", "RESTING_HEART_RATE"));
    await callGet(makeReq("VITALS_BASELINE", "RESTING_HEART_RATE"));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(1);

    await callGet(makeReq("VITALS_BASELINE", "WEIGHT"));
    await callGet(
      makeReqWith({
        metric: "VITALS_BASELINE",
        type: "RESTING_HEART_RATE",
        windowDays: "7",
      }),
    );
    expect(computeDerivedMetric).toHaveBeenCalledTimes(3);
  });

  it("recomputes after the account's measurements change", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const { invalidateUserMeasurements } =
      await import("@/lib/cache/invalidate");
    await callGet(makeReq("VITALS_BASELINE", "RESTING_HEART_RATE"));
    invalidateUserMeasurements("user-1");
    await callGet(makeReq("VITALS_BASELINE", "RESTING_HEART_RATE"));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(2);
  });
});
