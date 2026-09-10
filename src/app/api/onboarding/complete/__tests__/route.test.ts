import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    prisma: {
      user: { update: vi.fn(), findUnique: vi.fn() },
      auditLog: { create: vi.fn() },
      // v1.39 (C1) — the needs half of the route looks for a setup row before
      // it does anything. These cases are the LEGACY caller, which has none,
      // so the lookup answers null and the route falls straight through to the
      // acknowledgement it always returned.
      onboardingRecord: { findUnique: vi.fn(), update: vi.fn() },
    },
  };
});

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    getSession: vi.fn(),
    setOnboardingPendingCookie: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/onboarding/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(prisma.onboardingRecord.findUnique).mockResolvedValue(null);
});

describe("POST /api/onboarding/complete", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(req({}));
    expect(res.status).toBe(401);
  });

  /**
   * Onboarding validated gender against a narrower enum than the profile
   * schema, so a value the account is allowed to hold rejected the whole
   * submission — height, date of birth and display name included.
   */
  it("accepts every gender the profile stores, including OTHER", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(req({ gender: "OTHER", heightCm: 180 }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({ gender: "OTHER", heightCm: 180 }),
      }),
    );
  });

  it("still refuses an unsupported gender", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(req({ gender: "diverse" }));
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
