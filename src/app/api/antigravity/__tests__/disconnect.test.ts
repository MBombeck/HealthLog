import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkRecordWriteRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/ai/antigravity-auth-session", () => ({
  cancelAntigravityLogin: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-capability-cache", () => ({
  forgetAntigravityCapabilities: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-profile-cleanup", () => ({
  removeAntigravityProfile: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { cancelAntigravityLogin } from "@/lib/ai/antigravity-auth-session";
import { forgetAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";
import { removeAntigravityProfile } from "@/lib/ai/antigravity-profile-cleanup";
import { POST } from "../disconnect/route";

const USER_ID = "usr-1";
const PROFILE_ID = "0123456789abcdef0123456789abcdef";

describe("POST /api/antigravity/disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(prisma.user, "findUnique").mockImplementation(vi.fn());
    vi.spyOn(prisma.user, "updateMany").mockImplementation(vi.fn());
    vi.mocked(getSession).mockResolvedValue({
      user: { id: USER_ID, email: "user@example.com", role: "USER" },
      session: { id: "sess-1", actingAsUserId: null },
    } as unknown as Awaited<ReturnType<typeof getSession>>);
  });

  it("deletes directory successfully before clearing profile pointer in DB", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: PROFILE_ID,
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    vi.mocked(removeAntigravityProfile).mockResolvedValue(true);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({
      count: 1,
    } as Prisma.BatchPayload);

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: {
        success: true,
        loginRemoved: true,
      },
      error: null,
    });

    expect(removeAntigravityProfile).toHaveBeenCalledWith(PROFILE_ID);
    expect(cancelAntigravityLogin).toHaveBeenCalledWith(USER_ID);
    expect(forgetAntigravityCapabilities).toHaveBeenCalledWith(USER_ID);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        antigravityProfileId: PROFILE_ID,
      },
      data: {
        antigravityProfileId: null,
        antigravityModel: null,
        antigravityConnectionStatus: "disconnected",
        antigravityConnectedAt: null,
        antigravityCapabilitiesJson: expect.anything(),
      },
    });
  });

  it("does not clear profile pointer in DB when directory removal fails, retaining retry path", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: PROFILE_ID,
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    vi.mocked(removeAntigravityProfile).mockResolvedValue(false);

    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to remove Antigravity profile directory");

    expect(removeAntigravityProfile).toHaveBeenCalledWith(PROFILE_ID);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        antigravityProfileId: PROFILE_ID,
      },
      data: {
        antigravityModel: null,
        antigravityConnectionStatus: "error",
        antigravityConnectedAt: null,
        antigravityCapabilitiesJson: expect.anything(),
      },
    });
  });

  it("succeeds cleanly when user has no profile configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: null,
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({
      count: 1,
    } as Prisma.BatchPayload);

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: {
        success: true,
        loginRemoved: true,
      },
      error: null,
    });

    expect(removeAntigravityProfile).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        antigravityProfileId: null,
      },
      data: expect.objectContaining({
        antigravityProfileId: null,
        antigravityConnectionStatus: "disconnected",
      }),
    });
  });
});
