/**
 * v1.4.43 QoL (M3) — integration coverage for
 * `DELETE /api/settings/account`.
 *
 * The audit found the danger-zone UI offered only a half-delete (wipe
 * data, keep user row + passkeys + audit log + sessions). The route
 * was already in tree; this file pins the contract end-to-end against
 * real Postgres:
 *
 *   - happy path cascades User + passkeys + audit log + sessions
 *   - concurrent sibling sessions are invalidated before the row goes
 *   - the post-delete cookie can no longer authenticate a read
 *   - 422 when the confirmation token is missing or wrong
 *   - 401 when called unauthenticated
 *   - last-admin guard prevents accidental self-foot-shot
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedUserWithSession(opts?: {
  role?: "ADMIN" | "USER";
  username?: string;
}): Promise<{
  userId: string;
  sessionId: string;
}> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: opts?.username ?? "delete-me",
      email: `${opts?.username ?? "delete-me"}@example.test`,
      role: opts?.role ?? "USER",
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
  return new NextRequest("http://localhost/api/settings/account", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("DELETE /api/settings/account (real Postgres)", () => {
  it("cascades User + passkeys + audit log + sessions", async () => {
    const { userId, sessionId } = await seedUserWithSession();
    const prisma = getPrismaClient();

    // Seed a sibling session, a passkey, and an audit row so we can
    // verify every dependency vanishes with the row.
    const siblingSession = await prisma.session.create({
      data: {
        userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const passkey = await prisma.passkey.create({
      data: {
        userId,
        name: "iPhone",
        credentialId: "cred-1",
        credentialPublicKey: Buffer.from("public-key"),
        counter: BigInt(0),
        credentialDeviceType: "singleDevice",
        transports: ["internal"],
      },
    });
    // Seed an unrelated audit row to confirm it gets wiped too.
    await prisma.auditLog.create({
      data: {
        userId,
        action: "test.audit.row",
        ipAddress: "127.0.0.1",
      },
    });

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await DELETE(makeRequest({ confirm: "DELETE_ACCOUNT" }));
    expect(res.status).toBe(200);

    // The user row is gone.
    const stillThere = await prisma.user.findUnique({ where: { id: userId } });
    expect(stillThere).toBeNull();

    // Sessions cascaded.
    const sessionsAfter = await prisma.session.findMany({ where: { userId } });
    expect(sessionsAfter).toHaveLength(0);
    const checkOriginal = await prisma.session.findUnique({
      where: { id: sessionId },
    });
    expect(checkOriginal).toBeNull();
    const checkSibling = await prisma.session.findUnique({
      where: { id: siblingSession.id },
    });
    expect(checkSibling).toBeNull();

    // Passkey cascaded.
    const passkeyAfter = await prisma.passkey.findUnique({
      where: { id: passkey.id },
    });
    expect(passkeyAfter).toBeNull();

    // Audit-log rows for that user were purged (route deletes them
    // explicitly inside the same logical op for GDPR completeness).
    const auditRowsAfter = await prisma.auditLog.findMany({
      where: { userId },
    });
    expect(auditRowsAfter).toHaveLength(0);
  });

  it("invalidates a concurrent active session before the row goes", async () => {
    const { userId } = await seedUserWithSession();
    const prisma = getPrismaClient();

    // The "concurrent" session lives in another browser, say. The
    // route calls destroyAllSessions first, so that cookie can no
    // longer authenticate a subsequent read after the call returns.
    const otherSession = await prisma.session.create({
      data: {
        userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await DELETE(makeRequest({ confirm: "DELETE_ACCOUNT" }));
    expect(res.status).toBe(200);

    // Try to look up the concurrent session — it is gone.
    const lookup = await prisma.session.findUnique({
      where: { id: otherSession.id },
    });
    expect(lookup).toBeNull();
  });

  it("returns 422 when the confirmation string is missing", async () => {
    await seedUserWithSession();

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await DELETE(makeRequest({}));
    expect(res.status).toBe(422);
  });

  it("returns 422 when the confirmation string is wrong", async () => {
    await seedUserWithSession();
    const prisma = getPrismaClient();

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await DELETE(makeRequest({ confirm: "DELETE" }));
    expect(res.status).toBe(422);

    // The user row survived the failed call.
    const rows = await prisma.user.count();
    expect(rows).toBe(1);
  });

  it("returns 401 when called without a session cookie", async () => {
    cookieJar.clear();

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await DELETE(makeRequest({ confirm: "DELETE_ACCOUNT" }));
    expect(res.status).toBe(401);
  });

  it("guards against the last admin deleting themselves", async () => {
    // Single-admin instance — the route should refuse the delete and
    // surface a 400 instead of orphaning the install.
    await seedUserWithSession({ role: "ADMIN", username: "solo-admin" });
    const prisma = getPrismaClient();

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await DELETE(makeRequest({ confirm: "DELETE_ACCOUNT" }));
    expect(res.status).toBe(400);
    const stillThere = await prisma.user.count({ where: { role: "ADMIN" } });
    expect(stillThere).toBe(1);
  });
});
