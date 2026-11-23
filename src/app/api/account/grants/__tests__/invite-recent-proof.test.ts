/**
 * Offering access to the record asks for a fresh proof.
 *
 * An invitation outlives the session that sent it, so a live session alone
 * was enough for a stolen one to leave a standing way into the record in the
 * thief's own account. The real gate runs here; only the session, the
 * database and the headers are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    webauthnMfaCredential: { count: vi.fn(async () => 0) },
    passkey: { count: vi.fn(async () => 0) },
    user: {
      // The stored row: the password hash is not on the session user.
      findUnique: vi.fn(async () => ({ passwordHash: "argon" })),
    },
    accountGrant: { create: vi.fn(), findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/auth/identity-lookup", () => ({
  findUserIdBySignInName: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  recordDelegatedAccess: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/sharing/grants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sharing/grants")>()),
  inviteGrant: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { inviteGrant } from "@/lib/sharing/grants";
import { findUserIdBySignInName } from "@/lib/auth/identity-lookup";

const OWNER = {
  id: "owner-1",
  role: "USER",
  username: "owner",
  totpConfirmedAt: null,
};

function invite(): NextRequest {
  return new NextRequest("http://localhost/api/account/grants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "housemate", access: "READ" }),
  });
}

function signedIn(createdAt: Date) {
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 1e6) },
    user: OWNER,
  } as never);
  vi.mocked(prisma.session.findUnique).mockResolvedValue({
    createdAt,
    mfaVerifiedAt: null,
    reproofAt: null,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/account/grants — fresh proof", () => {
  it("a session that signed in an hour ago is asked to confirm, and nothing is offered", async () => {
    signedIn(new Date(Date.now() - 60 * 60 * 1000));
    const res = await POST(invite());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.meta.errorCode).toBe("auth.reproof.required");
    expect(body.meta.methods).toEqual(["password"]);
    expect(findUserIdBySignInName).not.toHaveBeenCalled();
    expect(inviteGrant).not.toHaveBeenCalled();
  });

  it("a session that signed in a minute ago offers the invitation", async () => {
    signedIn(new Date(Date.now() - 60 * 1000));
    vi.mocked(findUserIdBySignInName).mockResolvedValue("invitee-1");
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
      where: { id: string };
    }) =>
      args.where.id === "invitee-1"
        ? { id: "invitee-1", username: "housemate", displayName: null }
        : { passwordHash: "argon" }) as never);
    vi.mocked(inviteGrant).mockResolvedValue({
      id: "grant-1",
      access: "READ",
      scopeJson: null,
      invitedAt: new Date(),
      acceptedAt: null,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    } as never);
    const res = await POST(invite());
    expect(res.status).toBe(201);
    expect(inviteGrant).toHaveBeenCalled();
  });
});
