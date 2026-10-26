import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    measurement: { count: vi.fn() },
  },
}));
// The `statusText` capability decides whether the note is served; the
// unavailable body's provider-presence probe is stubbed.
vi.mock("@/lib/ai/capabilities/gate", () => ({ aiCapabilityToServe: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({
  probeProviderPresence: vi.fn(async () => true),
}));

// v1.18.0 — the route now resolves the `insights` module gate after
// `requireAuth()` (in addition to the existing per-metric sleep/glucose/
// recovery gate). Mock it default-enabled so the existing assertions ride
// through; the off → 403 coverage lives in the route-gate inventory test.
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
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

// Stub the heavy generator so the route test stays isolated from the
// real status pipeline.
vi.mock("@/lib/insights/metric-status", () => ({
  generateMetricStatus: vi.fn(async () => ({
    hasProvider: true,
    text: "ok",
    cached: true,
    updatedAt: new Date().toISOString(),
  })),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { generateMetricStatus } from "@/lib/insights/metric-status";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";

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
function makeReq(metric?: string): NextRequest {
  const url = new URL("http://localhost/api/insights/metric-status");
  if (metric !== undefined) url.searchParams.set("metric", metric);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(aiCapabilityToServe).mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
});

describe("GET /api/insights/metric-status", () => {
  it("returns 200 + envelope for a valid registered metric", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("RESTING_HEART_RATE"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { text: string; hasProvider: boolean } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.text).toBe("ok");
    expect(generateMetricStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "RESTING_HEART_RATE",
        userId: "user-1",
        readOnly: true,
      }),
    );
  });

  it("422s on an unknown metric without calling the generator", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("NOT_A_METRIC"));
    expect(res.status).toBe(422);
    expect(generateMetricStatus).not.toHaveBeenCalled();
  });

  it("422s on a missing metric param", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(422);
    expect(generateMetricStatus).not.toHaveBeenCalled();
  });

  it("422s when a specialised metric is requested through the generic route", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("WEIGHT"));
    expect(res.status).toBe(422);
    expect(generateMetricStatus).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq("SLEEP_DURATION"));
    expect(res.status).toBe(401);
  });

  it.each([
    [0, true],
    [3, false],
  ] as const)(
    "answers 200 with no note while statusText is unavailable (%i readings → insufficient %s)",
    async (readings, insufficient) => {
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      vi.mocked(aiCapabilityToServe).mockResolvedValue({
        available: false,
        reason: "operator_disabled",
        onDeviceAllowed: false,
      });
      vi.mocked(prisma.measurement.count).mockResolvedValue(readings as never);
      const res = await callGet(makeReq("RESTING_HEART_RATE"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).toMatchObject({
        text: null,
        preparing: false,
        insufficient,
        ai: { available: false, reason: "operator_disabled" },
      });
      expect(generateMetricStatus).not.toHaveBeenCalled();
    },
  );
});
