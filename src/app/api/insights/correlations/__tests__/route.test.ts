import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ timezone: "Europe/Berlin" }),
    },
    measurement: { findMany: vi.fn().mockResolvedValue([]) },
    // Rollup read-swap — the tiered measurement fetch probes DAY-bucket
    // coverage ($queryRaw) and reads `measurement_rollups`. Default both
    // empty so every channel takes the raw fallback path and the existing
    // assertions ride through unchanged.
    measurementRollup: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
    // FDREXTEND — the route now folds two non-measurement channels in (built by
    // the shared `correlation-channel-series` helpers). Default to empty corpora
    // so neither channel produces a point and the discovery stays trivially
    // pair-less for the existing assertions.
    medication: { findMany: vi.fn().mockResolvedValue([]) },
    medicationIntakeEvent: { findMany: vi.fn().mockResolvedValue([]) },
    illnessEpisode: { findMany: vi.fn().mockResolvedValue([]) },
    illnessDayLog: { findMany: vi.fn().mockResolvedValue([]) },
    // v1.22 — labs ↔ outcome pass fetches lab draws; default empty.
    labResult: { findMany: vi.fn().mockResolvedValue([]) },
    // v1.25 (W-ENV) — the route folds the environmental-exposure behaviour
    // channels in (read from EnvironmentContext); default empty so no env
    // channel produces a point.
    environmentContext: { findMany: vi.fn().mockResolvedValue([]) },
    customMetric: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

// v1.18.0 — the route now resolves the `insights` module gate after
// `requireAuth()`. Mock it default-enabled so the existing assertions
// ride through; the off → 403 coverage lives in the route-gate
// inventory test.
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
// DB work; the real helper would hit the unmocked `$queryRaw`.
vi.mock("@/lib/rate-limit", () => ({
  checkAnalyticsReadRateLimit: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/insights/correlation-patterns", () => ({
  PATTERN_FAMILIES: {
    discoveryRetrospective: "DISCOVERY_RETROSPECTIVE",
    discoveryRecent: "DISCOVERY_RECENT",
  },
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

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { apiError } from "@/lib/api-response";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { syncAcceptedPatterns } from "@/lib/insights/correlation-patterns";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  // The route reads through the SWR analytics cache now; a warm cell from a
  // prior test would serve a hit and skip the builder every assertion spies on.
  __resetAllCachesForTests();
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  // v1.15.20 — default to an allowing analytics-read budget.
  vi.mocked(checkAnalyticsReadRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 119,
    resetAt: Date.now() + 60_000,
  });
  // v1.4.31 — default to an all-on flag set so existing assertions
  // ride through unchanged. Tests that need the gate-off path set
  // their own findUnique resolution.
  (prisma.appSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
    null,
  );
  // v1.10.0 — the discovery engine reads the profile timezone + the
  // measurement / mood series. Default to an empty corpus so the engine
  // returns no discovered pairs (the n ≥ 20 gate trivially fails).
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    timezone: "Europe/Berlin",
  });
  (prisma.measurement.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  // Rollup read-swap — empty coverage probe + bucket read keep every
  // measurement channel on the raw fallback path.
  (
    prisma.measurementRollup.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // FDREXTEND — the two non-measurement channels read their own models; default
  // them empty so neither channel produces a point.
  (prisma.medication.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  (
    prisma.medicationIntakeEvent.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  (
    prisma.illnessEpisode.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  (prisma.illnessDayLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  // v1.22 — labs ↔ outcome pass reads lab draws; default empty.
  (prisma.labResult.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (
    prisma.environmentContext.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
});

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/correlations");
}

describe("GET /api/insights/correlations", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns the discovery result shape (no pairs on an empty corpus)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { discovered: unknown[]; pairsTested: number; fdrQ: number };
    };
    expect(body.data.discovered).toEqual([]);
    expect(body.data.pairsTested).toBe(0);
    expect(body.data.fdrQ).toBeGreaterThan(0);
  });

  it("serves a cache hit without re-running the discovery reads or the pattern-sync writes", async () => {
    // The SWR cell caches the built body for 60 s; the second GET inside that
    // window must neither re-read the measurement window nor re-run the two
    // `syncAcceptedPatterns` DB writes — writes on the read path were the
    // pre-cache defect, and a hit that still wrote would reintroduce it.
    // Watched red: with the assertion counts set to 2 (i.e. asserting the
    // builder re-ran) this test fails, so the cache path is proven live.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const first = await callGet(makeReq());
    expect(first.status).toBe(200);
    const second = await callGet(makeReq());
    expect(second.status).toBe(200);
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
    expect(syncAcceptedPatterns).toHaveBeenCalledTimes(2);
    const firstBody = (await first.json()) as { data: unknown };
    const secondBody = (await second.json()) as { data: unknown };
    expect(secondBody.data).toEqual(firstBody.data);
  });

  it("returns 403 + errorCode when the correlations flag is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (
      prisma.appSettings.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: false,
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("assistant.disabled.correlations");
  });

  it("returns 403 when the master flag is off (sub-flag forced)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    (
      prisma.appSettings.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      assistantEnabled: false,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
  });

  it("returns 429 when the shared analytics-read budget is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkAnalyticsReadRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(429);
    expect(vi.mocked(checkAnalyticsReadRateLimit)).toHaveBeenCalledWith(
      "user-1",
    );
    // The limited request never reaches the series reads.
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  // v1.30 (DATAINT M1) — `asc` + `take` truncated the RECENT end of the
  // 180-day window on a dense account; the read must order `desc` so the
  // cap keeps the newest rows (re-sorted `asc` in JS before series-building).
  it("reads the measurement + mood window ordered desc so the cap keeps the newest rows", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq());

    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { measuredAt: "desc" },
        take: 20000,
      }),
    );
    expect(prisma.moodEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { moodLoggedAt: "desc" },
        take: 5000,
      }),
    );
  });

  // v1.18.0 (B2) — the route now also requires the `insights` module.
  it("returns 403 + module.disabled when the insights module is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(requireModuleEnabled).mockResolvedValueOnce({
      enabled: false,
      response: apiError('Module "insights" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "insights",
      }),
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      meta?: { errorCode?: string; module?: string };
    };
    expect(body.meta?.errorCode).toBe("module.disabled");
    expect(body.meta?.module).toBe("insights");
    // The disabled-module request never reaches the series reads.
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });
});
