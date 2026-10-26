import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The status family is a mixed read. The note is model text: served only
 * while the `statusText` capability is available. Otherwise the route
 * answers 200 with `text: null`, `preparing: false`, `hasProvider` as provider
 * presence and an `ai` state, and the generator (the cache read and the warm
 * enqueue behind it) is never called. The `insights` module is folded into
 * the capability and no longer refuses the route.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn(),
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

vi.mock("@/lib/insights/blood-pressure-status", () => ({
  generateBloodPressureStatusForUser: vi.fn(),
}));

// The `statusText` capability decides whether the note is served; the
// unavailable body's provider-presence probe is stubbed.
vi.mock("@/lib/ai/capabilities/gate", () => ({ aiCapabilityToServe: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({
  probeProviderPresence: vi.fn(async () => true),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { probeProviderPresence } from "@/lib/ai/provider";
import { generateBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

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
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/blood-pressure-status");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(aiCapabilityToServe).mockResolvedValue(AI_AVAILABLE);
  vi.mocked(probeProviderPresence).mockResolvedValue(true);
  vi.mocked(generateBloodPressureStatusForUser).mockResolvedValue({
    hasProvider: true,
    text: "ok",
    cached: true,
    updatedAt: "2026-09-20T06:00:00.000Z",
  });
});

describe("GET /api/insights/blood-pressure-status", () => {
  it("serves the note and the state while statusText is available", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.text).toBe("ok");
    expect(body.data.ai).toEqual(AI_AVAILABLE);
    expect(aiCapabilityToServe).toHaveBeenCalledWith("user-1", "statusText");
    expect(requireModuleEnabled).not.toHaveBeenCalled();
  });

  it.each([
    "operator_disabled",
    "user_disabled",
    "consent_required",
    "check_failed",
  ] as const)(
    "answers 200 with no note for %s, reading and warming nothing",
    async (reason) => {
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      vi.mocked(aiCapabilityToServe).mockResolvedValue(aiUnavailable(reason));
      const res = await callGet(makeReq());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).toEqual({
        hasProvider: true,
        text: null,
        cached: false,
        updatedAt: null,
        preparing: false,
        ai: aiUnavailable(reason),
      });
      expect(generateBloodPressureStatusForUser).not.toHaveBeenCalled();
    },
  );

  it("reports hasProvider as presence only: false for a missing provider", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(aiCapabilityToServe).mockResolvedValue(
      aiUnavailable("no_provider"),
    );
    vi.mocked(probeProviderPresence).mockResolvedValue(false);
    const res = await callGet(makeReq());
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.hasProvider).toBe(false);
    expect(body.data.text).toBeNull();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });
});
