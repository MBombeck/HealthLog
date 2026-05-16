/**
 * v1.4.35 — integration coverage for `POST /api/auth/password`.
 *
 * The v1.4.34.3 token-wipe directive routed every password rotation
 * through `destroyAllSessions(userId)`, which now revokes web sessions,
 * API tokens, and refresh tokens in a single transaction. The route had
 * zero route-level coverage despite that change — F-1 in the test
 * coverage audit. This file pins the contract end-to-end against real
 * Postgres:
 *
 *   - happy path with a strong new password returns 200, rotates the
 *     session cookie, and wipes every sibling credential on the user
 *   - wrong current password returns 401 and leaves credentials intact
 *   - identical current + new password returns 422
 *   - weak new password returns 422 and does not touch the hash
 *   - a stale session cookie carried by a second request returns 401
 *     on a session-protected endpoint after the rotation
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

const STRONG_CURRENT = "OldStrongP@ssw0rd!123abc";
const STRONG_NEW = "NewStrongP@ssw0rd!456xyz";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedUserWithSession(): Promise<{
  userId: string;
  sessionId: string;
}> {
  const { hashPassword } = await import("@/lib/auth/password");
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "pw-change",
      email: "pw-change@example.test",
      role: "USER",
      passwordHash: await hashPassword(STRONG_CURRENT),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return { userId: user.id, sessionId: session.id };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/password (real Postgres)", () => {
  it("rotates the session cookie and wipes every sibling credential", async () => {
    const { userId, sessionId } = await seedUserWithSession();
    const prisma = getPrismaClient();

    // Seed a sibling web session, a long-lived API token, and a refresh
    // token — the rotation must invalidate all three.
    const siblingSession = await prisma.session.create({
      data: {
        userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const apiToken = await prisma.apiToken.create({
      data: {
        userId,
        name: "iOS app",
        tokenHash: "hashed-token-1",
        revoked: false,
      },
    });
    const refreshToken = await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: "hashed-refresh-1",
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        revokedAt: null,
      },
    });

    const { POST } = await import("@/app/api/auth/password/route");
    const res = await POST(
      makeRequest({
        currentPassword: STRONG_CURRENT,
        newPassword: STRONG_NEW,
        confirmPassword: STRONG_NEW,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { changed: boolean } };
    expect(body.data.changed).toBe(true);

    // Every prior web session is gone — including the one we logged in
    // with — and a brand-new session row exists with the cookie pointing
    // at it (the route calls createSession after destroyAllSessions).
    const remainingSessions = await prisma.session.findMany({
      where: { userId },
    });
    expect(remainingSessions).toHaveLength(1);
    expect(remainingSessions[0].id).not.toBe(sessionId);
    expect(remainingSessions[0].id).not.toBe(siblingSession.id);
    expect(cookieJar.get("healthlog_session")).toBe(remainingSessions[0].id);

    // The API token is flipped to revoked rather than deleted so the
    // audit trail survives.
    const refreshedToken = await prisma.apiToken.findUnique({
      where: { id: apiToken.id },
    });
    expect(refreshedToken?.revoked).toBe(true);

    const refreshedRefresh = await prisma.refreshToken.findUnique({
      where: { id: refreshToken.id },
    });
    expect(refreshedRefresh?.revokedAt).not.toBeNull();

    // The password hash on disk is actually a fresh hash for the new
    // value — verifyPassword roundtrips.
    const { verifyPassword } = await import("@/lib/auth/password");
    const dbUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(dbUser?.passwordHash).toBeTruthy();
    expect(await verifyPassword(dbUser!.passwordHash!, STRONG_NEW)).toBe(true);

    // An audit row was written for the change action.
    const audit = await prisma.auditLog.findFirst({
      where: { userId, action: "auth.password.change" },
    });
    expect(audit).not.toBeNull();
  });

  it("returns 401 and leaves credentials intact on a wrong current password", async () => {
    const { userId } = await seedUserWithSession();
    const prisma = getPrismaClient();

    const apiToken = await prisma.apiToken.create({
      data: {
        userId,
        name: "iOS app",
        tokenHash: "hashed-token-2",
        revoked: false,
      },
    });

    const { POST } = await import("@/app/api/auth/password/route");
    const res = await POST(
      makeRequest({
        currentPassword: "WrongPasswordValue!1",
        newPassword: STRONG_NEW,
        confirmPassword: STRONG_NEW,
      }),
    );

    expect(res.status).toBe(401);

    // Sibling credentials are intact.
    const stillActive = await prisma.apiToken.findUnique({
      where: { id: apiToken.id },
    });
    expect(stillActive?.revoked).toBe(false);

    // The password hash is unchanged — the old password still verifies.
    const { verifyPassword } = await import("@/lib/auth/password");
    const dbUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(await verifyPassword(dbUser!.passwordHash!, STRONG_CURRENT)).toBe(
      true,
    );
  });

  it("returns 422 when the new password matches the current password", async () => {
    await seedUserWithSession();

    const { POST } = await import("@/app/api/auth/password/route");
    const res = await POST(
      makeRequest({
        currentPassword: STRONG_CURRENT,
        newPassword: STRONG_CURRENT,
        confirmPassword: STRONG_CURRENT,
      }),
    );

    expect(res.status).toBe(422);
  });

  it("returns 422 on a weak new password and does not touch the hash", async () => {
    const { userId } = await seedUserWithSession();
    const prisma = getPrismaClient();

    const before = await prisma.user.findUnique({ where: { id: userId } });
    const beforeHash = before!.passwordHash;

    const { POST } = await import("@/app/api/auth/password/route");
    // 12 chars but trivially weak — zxcvbn scores 0/1.
    const res = await POST(
      makeRequest({
        currentPassword: STRONG_CURRENT,
        newPassword: "password1234",
        confirmPassword: "password1234",
      }),
    );

    expect(res.status).toBe(422);

    const after = await prisma.user.findUnique({ where: { id: userId } });
    expect(after!.passwordHash).toBe(beforeHash);
  });

  it("stale cookie carried in a second request lands unauthenticated on a protected endpoint", async () => {
    const { sessionId } = await seedUserWithSession();

    const { POST } = await import("@/app/api/auth/password/route");
    const rotateRes = await POST(
      makeRequest({
        currentPassword: STRONG_CURRENT,
        newPassword: STRONG_NEW,
        confirmPassword: STRONG_NEW,
      }),
    );
    expect(rotateRes.status).toBe(200);

    // Reset the cookie jar to the stolen / stale cookie value the
    // attacker would still hold after the legitimate user changed
    // their password. The route handler must see no session.
    cookieJar.clear();
    cookieJar.set("healthlog_session", sessionId);

    // Hit a session-protected endpoint — `apiHandler` raises HttpError(401)
    // which the wrapper converts to a 401 JSON response.
    const { GET } = await import("@/app/api/auth/me/route");
    const meRes = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/auth/me"));
    expect(meRes.status).toBe(401);
  });
});
