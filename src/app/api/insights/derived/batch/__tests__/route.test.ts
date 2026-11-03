import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        dateOfBirth: new Date("1986-01-01"),
        gender: "MALE",
        heightCm: 180,
      }),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// Stub the compute layer; keep the real registry + loadBaselineProfile.
vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived")>();
  return {
    ...actual,
    computeDerivedMetric: vi.fn(async (args: { metric: string }) => ({
      status: "ok",
      value: { metric: args.metric, n: 1 },
      coverage: {
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 30,
        missing: [],
      },
      confidence: { score: 100, band: "high" },
      provenance: {
        inputs: [],
        source: "DAY",
        windowDays: 30,
        computedAt: "2026-06-02T07:00:00+02:00",
      },
    })),
  };
});

// v1.18.0 — the route resolves the per-user module map to drop disabled-
// module derived scores; stub it so the batch tests stay focused (default:
// every module enabled) and the profile-read count isn't perturbed.
vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(),
    // v1.18.0 — the route gates on the `insights` module after
    // `requireAuth()`. Default-enabled so the existing per-metric
    // resolveModuleMap assertions ride through; the off → 403 coverage
    // lives in the route-gate inventory test.
    requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  };
});

import { GET } from "../route";
import { resolveModuleMap, requireModuleEnabled } from "@/lib/modules/gate";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { computeDerivedMetric } from "@/lib/insights/derived";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import {
  invalidateUserMeasurements,
  invalidateUserMood,
} from "@/lib/cache/invalidate";

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
function makeReq(metrics?: string): NextRequest {
  const url = new URL("http://localhost/api/insights/derived/batch");
  if (metrics !== undefined) url.searchParams.set("metrics", metrics);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  // v1.16.8 — the route reads through the module-scope `insightsDerived`
  // server cache; reset it so every test starts on a cold cell.
  __resetAllCachesForTests();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(resolveModuleMap).mockResolvedValue({} as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    dateOfBirth: new Date("1986-01-01"),
    gender: "MALE",
    heightCm: 180,
  } as never);
});

describe("GET /api/insights/derived/batch", () => {
  it("resolves several metrics into one keyed map", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("READINESS,BMI,VITALS_BASELINE:WEIGHT"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { metrics: Record<string, { metric: string; status: string }> };
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(Object.keys(body.data.metrics).sort()).toEqual([
      "BMI",
      "READINESS",
      "VITALS_BASELINE:WEIGHT",
    ]);
    expect(body.data.metrics["VITALS_BASELINE:WEIGHT"].status).toBe("ok");
    expect(body.data.metrics.READINESS.metric).toBe("READINESS");
  });

  it("loads the profile once regardless of metric count", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("READINESS,BMI,FITNESS_AGE,HRV_BALANCE"));
    // One User read for the whole batch — the pool-contention mitigation.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(computeDerivedMetric).toHaveBeenCalledTimes(4);
  });

  it("narrows userId from the session into every compute call", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("READINESS"));
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", metric: "READINESS" }),
    );
  });

  it("collapses a duplicate token so it cannot inflate the fan-out", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("BMI,BMI,BMI"));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(1);
  });

  it("422s when any token is an unknown metric id", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("READINESS,NOT_A_METRIC"));
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("422s when a sub-target type is outside the MeasurementType enum", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // The colon sub-target must be a closed-enum member BEFORE it joins
    // the compute dispatch and the cache key — an arbitrary token would
    // mint unbounded cache cells and echo through coverage / provenance.
    const res = await callGet(makeReq("VITALS_BASELINE:NOT_A_TYPE"));
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("accepts a valid MeasurementType sub-target", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("VITALS_BASELINE:RESTING_HEART_RATE"));
    expect(res.status).toBe(200);
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RESTING_HEART_RATE" }),
    );
  });

  it("429s when the per-user rate limit is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await callGet(makeReq("BMI"));
    expect(res.status).toBe(429);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
    expect(checkRateLimit).toHaveBeenCalledWith(
      "insights-derived-batch:user-1",
      30,
      60_000,
    );
  });

  it("422s on a missing metrics param", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("422s on an empty metrics list", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq(" , , "));
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq("READINESS"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/insights/derived/batch — server cache (v1.16.8)", () => {
  it("serves a warm repeat from the per-user cache without recomputing", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const first = await callGet(makeReq("READINESS,BMI"));
    expect(first.status).toBe(200);
    expect(computeDerivedMetric).toHaveBeenCalledTimes(2);

    const second = await callGet(makeReq("READINESS,BMI"));
    expect(second.status).toBe(200);
    // Cache hit — no second profile read, no second compute fan-out.
    expect(computeDerivedMetric).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);

    const body = (await second.json()) as {
      data: { metrics: Record<string, { status: string }> };
    };
    expect(Object.keys(body.data.metrics).sort()).toEqual(["BMI", "READINESS"]);
  });

  it("hits the same cell regardless of token order", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("READINESS,BMI"));
    await callGet(makeReq("BMI,READINESS"));
    // The key sorts the tokens, so the reordered request is a hit.
    expect(computeDerivedMetric).toHaveBeenCalledTimes(2);
  });

  it("never serves one user's cell to another user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("BMI"));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(1);

    vi.mocked(getSession).mockResolvedValue({
      ...SESSION_OK,
      user: { ...SESSION_OK.user, id: "user-2" },
    } as never);
    await callGet(makeReq("BMI"));
    // Different userId prefix → cold cell → fresh compute.
    expect(computeDerivedMetric).toHaveBeenCalledTimes(2);
  });

  it("recomputes after an interactive measurement write evicts the bucket", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("BMI"));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(1);

    invalidateUserMeasurements("user-1", { evict: true });
    await callGet(makeReq("BMI"));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(2);
  });

  it("serves stale-while-revalidate after a background write marks the bucket stale", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("BMI"));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(1);

    // Background sync posture (no evict): the entry is marked stale, so
    // the next read serves the prior body immediately AND kicks off one
    // background recompute.
    invalidateUserMood("user-1");
    const res = await callGet(makeReq("BMI"));
    expect(res.status).toBe(200);
    // The background rebuild runs detached; give the microtask queue a
    // tick so the recompute lands before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(2);
  });
});
