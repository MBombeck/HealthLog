import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
// The `statusText` capability decides whether the note is served; the
// unavailable body's provider-presence probe is stubbed.
vi.mock("@/lib/ai/capabilities/gate", () => ({ aiCapabilityToServe: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({
  probeProviderPresence: vi.fn(async () => true),
}));

// The route resolves the `insights` module gate after `requireAuth()`. Mock
// it default-enabled so the assertions ride through; the off → 403 coverage
// lives in the route-gate inventory test.
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

// Stub the heavy generator so the route test stays isolated from the real
// status pipeline.
vi.mock("@/lib/insights/biomarker-status", () => ({
  generateBiomarkerStatus: vi.fn(async () => ({
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
import { generateBiomarkerStatus } from "@/lib/insights/biomarker-status";
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
function makeReq(biomarkerId?: string): NextRequest {
  const url = new URL("http://localhost/api/insights/biomarker-assessment");
  if (biomarkerId !== undefined)
    url.searchParams.set("biomarkerId", biomarkerId);
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
  vi.mocked(generateBiomarkerStatus).mockResolvedValue({
    hasProvider: true,
    text: "ok",
    cached: true,
    updatedAt: new Date().toISOString(),
  });
});

describe("GET /api/insights/biomarker-assessment", () => {
  it("returns 200 + envelope and calls the generator read-only", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("bm-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { text: string; hasProvider: boolean } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.text).toBe("ok");
    expect(generateBiomarkerStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        biomarkerId: "bm-1",
        userId: "user-1",
        readOnly: true,
      }),
    );
  });

  it("422s on a missing biomarkerId without calling the generator", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(422);
    expect(generateBiomarkerStatus).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq("bm-1"));
    expect(res.status).toBe(401);
  });

  it("answers 200 with no note while statusText is unavailable, calling no generator", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(aiCapabilityToServe).mockResolvedValue({
      available: false,
      reason: "user_disabled",
      onDeviceAllowed: false,
    });
    const res = await callGet(makeReq("bm-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      text: null,
      preparing: false,
      ai: { available: false, reason: "user_disabled" },
    });
    expect(generateBiomarkerStatus).not.toHaveBeenCalled();
  });

  it("preserves the safe terminal fallback produced when a causal claim is screened", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(generateBiomarkerStatus).mockResolvedValueOnce({
      hasProvider: false,
      text: "The assessment could not be completed safely. Your recorded measurements remain available.",
      cached: true,
      updatedAt: null,
    });

    const res = await callGet(makeReq("bm-screened"));
    const body = (await res.json()) as {
      data: {
        hasProvider: boolean;
        text: string | null;
        cached: boolean;
        updatedAt: string | null;
      };
    };

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      hasProvider: false,
      text: "The assessment could not be completed safely. Your recorded measurements remain available.",
      cached: true,
      updatedAt: null,
      ai: { available: true, reason: null, onDeviceAllowed: true },
    });
    expect(JSON.stringify(body)).not.toContain("medication caused");
    expect(JSON.stringify(body)).not.toContain("causal_claim");
  });

  it("keeps a preparing cache miss distinct from a terminal negative cache", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(generateBiomarkerStatus)
      .mockResolvedValueOnce({
        hasProvider: true,
        text: null,
        cached: false,
        updatedAt: null,
        preparing: true,
      })
      .mockResolvedValueOnce({
        hasProvider: false,
        text: "Assessment temporarily unavailable. Your recorded measurements remain available.",
        cached: true,
        updatedAt: null,
      });

    const preparing = await (await callGet(makeReq("bm-preparing"))).json();
    const negativeCache = await (await callGet(makeReq("bm-negative"))).json();

    expect(preparing.data).toMatchObject({
      hasProvider: true,
      text: null,
      cached: false,
      preparing: true,
    });
    expect(negativeCache.data).toMatchObject({
      hasProvider: false,
      cached: true,
      text: expect.stringContaining("temporarily unavailable"),
    });
    expect(negativeCache.data).not.toHaveProperty("preparing", true);
  });
});
