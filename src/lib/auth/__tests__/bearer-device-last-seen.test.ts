/**
 * The Bearer arm of `requireAuth` stamps the token's device (#179), and a
 * stamp that fails, however it fails, never fails the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiToken } from "@/generated/prisma/client";

// The second-factor policy is not this file's subject: no policy applies.
vi.mock("@/lib/auth/mfa-confinement", () => ({
  refuseConfinedBearer: vi.fn(async () => {}),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn(() => "hash") }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

const headersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

import { requireAuth } from "../../api-handler";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { resetDeviceLastSeenThrottle } from "../device-last-seen";

/** The columns `SESSION_USER_SELECT` reads off the user row. */
type SessionUserRow = Awaited<ReturnType<typeof prisma.user.findUnique>>;

function token(permissions: string[]): ApiToken {
  return {
    id: "tok-1",
    userId: "user-1",
    name: "iPhone",
    tokenHash: "hash",
    permissions,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    revoked: false,
    mcpConnectionId: null,
    mirrorToAppleHealth: false,
    mirrorChangedAt: null,
  };
}

function bearer(permissions: string[]): void {
  vi.mocked(getSession).mockResolvedValue(null);
  headersGet.mockImplementation((n) =>
    n.toLowerCase() === "authorization" ? "Bearer hlk_xyz" : null,
  );
  vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(token(permissions));
  vi.mocked(prisma.apiToken.update).mockResolvedValue(token(permissions));
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: "user-1",
    role: "USER",
    username: "u",
    totpConfirmedAt: null,
    deletionRequestedAt: null,
  } as SessionUserRow);
}

beforeEach(() => {
  vi.mocked(prisma.$executeRaw).mockReset();
  resetDeviceLastSeenThrottle();
});

describe("requireAuth on a Bearer token — device lastSeen", () => {
  it("stamps the app token's device", async () => {
    bearer(["*"]);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
    const auth = await requireAuth();
    expect(auth.authMethod).toBe("bearer");
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("still answers when the stamp is refused by the database", async () => {
    bearer(["*"]);
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error("db down"));
    await expect(requireAuth()).resolves.toMatchObject({
      authMethod: "bearer",
    });
    await new Promise((r) => setTimeout(r, 0));
  });

  it("still answers when the stamp throws before it starts", async () => {
    bearer(["*"]);
    vi.mocked(prisma.$executeRaw).mockImplementation(() => {
      throw new Error("client gone");
    });
    await expect(requireAuth()).resolves.toMatchObject({
      authMethod: "bearer",
    });
  });

  it("leaves a narrow token alone: it belongs to no device", async () => {
    bearer(["measurements:write"]);
    await requireAuth("measurements:write");
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
