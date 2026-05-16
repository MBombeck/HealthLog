/**
 * v1.4.35 — integration coverage for
 * `POST /api/admin/users/[id]/reset-password`.
 *
 * The admin reset-password path runs through the same `destroyAllSessions`
 * helper as the self-serve change route, but acts on a different user's
 * credentials. F-1 in the test coverage audit flagged it alongside the
 * self-serve route as a critical-path gap. This file pins:
 *
 *   - 403 when the caller is not an admin (and credentials stay intact)
 *   - 401 when the caller is unauthenticated
 *   - 404 when the target user does not exist
 *   - 422 when the new password is weak
 *   - happy path wipes the target user's sessions, API tokens, refresh
 *     tokens and writes an `admin.user.reset-password` audit row
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const STRONG_NEW_PW = "Adm1nReset!P@ssw0rd789";

async function seedCaller(role: "ADMIN" | "USER"): Promise<{
  callerId: string;
  sessionId: string;
}> {
  const prisma = getPrismaClient();
  const caller = await prisma.user.create({
    data: {
      username: role === "ADMIN" ? "admin-caller" : "regular-caller",
      email: `${role.toLowerCase()}-caller@example.test`,
      role,
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: caller.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return { callerId: caller.id, sessionId: session.id };
}

async function seedTargetUser(): Promise<string> {
  const { hashPassword } = await import("@/lib/auth/password");
  const prisma = getPrismaClient();
  const target = await prisma.user.create({
    data: {
      username: "reset-target",
      email: "target@example.test",
      role: "USER",
      passwordHash: await hashPassword("OldTargetPassword!12345"),
    },
  });
  return target.id;
}

function makeRequest(targetId: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/users/${targetId}/reset-password`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("POST /api/admin/users/[id]/reset-password (real Postgres)", () => {
  it("returns 401 when the caller is unauthenticated", async () => {
    const targetId = await seedTargetUser();

    const { POST } = await import(
      "@/app/api/admin/users/[id]/reset-password/route"
    );
    const res = await POST(
      makeRequest(targetId, { password: STRONG_NEW_PW }),
      paramsFor(targetId),
    );

    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not an admin", async () => {
    await seedCaller("USER");
    const targetId = await seedTargetUser();
    const prisma = getPrismaClient();

    const targetSession = await prisma.session.create({
      data: {
        userId: targetId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const { POST } = await import(
      "@/app/api/admin/users/[id]/reset-password/route"
    );
    const res = await POST(
      makeRequest(targetId, { password: STRONG_NEW_PW }),
      paramsFor(targetId),
    );

    expect(res.status).toBe(403);

    // Target session must NOT have been wiped on a denied call.
    const stillThere = await prisma.session.findUnique({
      where: { id: targetSession.id },
    });
    expect(stillThere).not.toBeNull();
  });

  it("returns 404 when the target user does not exist", async () => {
    await seedCaller("ADMIN");

    const { POST } = await import(
      "@/app/api/admin/users/[id]/reset-password/route"
    );
    const res = await POST(
      makeRequest("user-does-not-exist", { password: STRONG_NEW_PW }),
      paramsFor("user-does-not-exist"),
    );

    expect(res.status).toBe(404);
  });

  it("returns 422 on a weak new password and does not touch the hash", async () => {
    await seedCaller("ADMIN");
    const targetId = await seedTargetUser();
    const prisma = getPrismaClient();

    const before = await prisma.user.findUnique({ where: { id: targetId } });

    const { POST } = await import(
      "@/app/api/admin/users/[id]/reset-password/route"
    );
    const res = await POST(
      makeRequest(targetId, { password: "password1234" }),
      paramsFor(targetId),
    );

    expect(res.status).toBe(422);

    const after = await prisma.user.findUnique({ where: { id: targetId } });
    expect(after!.passwordHash).toBe(before!.passwordHash);
  });

  it("wipes the target user's sessions, API tokens and refresh tokens and writes an audit row", async () => {
    const { callerId } = await seedCaller("ADMIN");
    const targetId = await seedTargetUser();
    const prisma = getPrismaClient();

    const targetSession = await prisma.session.create({
      data: {
        userId: targetId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const targetApiToken = await prisma.apiToken.create({
      data: {
        userId: targetId,
        name: "iOS",
        tokenHash: "hashed-target-token",
        revoked: false,
      },
    });
    const targetRefresh = await prisma.refreshToken.create({
      data: {
        userId: targetId,
        tokenHash: "hashed-target-refresh",
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        revokedAt: null,
      },
    });

    const { POST } = await import(
      "@/app/api/admin/users/[id]/reset-password/route"
    );
    const res = await POST(
      makeRequest(targetId, { password: STRONG_NEW_PW }),
      paramsFor(targetId),
    );

    expect(res.status).toBe(200);

    // Target web session deleted.
    const stillThere = await prisma.session.findUnique({
      where: { id: targetSession.id },
    });
    expect(stillThere).toBeNull();

    // API token revoked in place — audit trail survives.
    const refreshedToken = await prisma.apiToken.findUnique({
      where: { id: targetApiToken.id },
    });
    expect(refreshedToken?.revoked).toBe(true);

    // Refresh token revoked in place.
    const refreshedRefresh = await prisma.refreshToken.findUnique({
      where: { id: targetRefresh.id },
    });
    expect(refreshedRefresh?.revokedAt).not.toBeNull();

    // Audit row exists and is attributed to the admin caller.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "admin.user.reset-password" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(callerId);
    expect(audit?.details).toContain(targetId);

    // New password verifies against the persisted hash.
    const { verifyPassword } = await import("@/lib/auth/password");
    const dbUser = await prisma.user.findUnique({ where: { id: targetId } });
    expect(dbUser?.passwordHash).toBeTruthy();
    expect(await verifyPassword(dbUser!.passwordHash!, STRONG_NEW_PW)).toBe(
      true,
    );
  });
});
