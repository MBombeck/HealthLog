/**
 * Integration test — v1.23 active-session management + known-device ledger
 * against a real Postgres (migration 0203 applied by the container harness).
 *
 * Covers the DB-layer contracts the unit mocks can't pin:
 *   - destroyOtherSessions keeps the current session, deletes the rest, revokes
 *     native refresh tokens, and leaves API tokens untouched.
 *   - destroySessionById is scoped to the owning user (no cross-user delete)
 *     and takes the public handle, never the row id.
 *   - the (userId, deviceHash) unique index enforces the login-alert dedupe.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  destroyOtherSessions,
  destroySessionById,
  sessionHandle,
} from "@/lib/auth/session";
import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function makeUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test` },
  });
}

describe("destroyOtherSessions", () => {
  it("keeps the current session, removes the others, revokes refresh tokens, keeps API tokens", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("sess-owner");

    const current = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    const refresh = await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: "rt-hash-1",
        expiresAt: new Date(Date.now() + 1e6),
      },
    });
    const apiToken = await prisma.apiToken.create({
      data: {
        userId: user.id,
        name: "automation",
        tokenHash: "at-hash-1",
        permissions: ["*"],
      },
    });

    const result = await destroyOtherSessions(user.id, {
      kind: "session",
      sessionId: current.id,
    });
    expect(result.sessionsRevoked).toBe(2);

    const remaining = await prisma.session.findMany({
      where: { userId: user.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(current.id);

    const rt = await prisma.refreshToken.findUnique({
      where: { id: refresh.id },
    });
    expect(rt?.revokedAt).not.toBeNull();

    const at = await prisma.apiToken.findUnique({ where: { id: apiToken.id } });
    expect(at?.revoked).toBe(false);
  });
});

describe("destroySessionById", () => {
  it("revokes an owned session and refuses a cross-user id", async () => {
    const prisma = getPrismaClient();
    const owner = await makeUser("owner");
    const other = await makeUser("intruder");

    const ownerSession = await prisma.session.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    const otherSession = await prisma.session.create({
      data: { userId: other.id, expiresAt: new Date(Date.now() + 1e6) },
    });

    // Cross-user attempt: owner presents the intruder's handle.
    expect(
      await destroySessionById(owner.id, sessionHandle(otherSession.id)),
    ).toBe(false);
    expect(
      await prisma.session.findUnique({ where: { id: otherSession.id } }),
    ).not.toBeNull();

    // The row id is not an accepted key: a caller who somehow learned it
    // still cannot revoke with it, which is what keeps the id out of the
    // client's hands from being load-bearing in both directions.
    expect(await destroySessionById(owner.id, ownerSession.id)).toBe(false);
    expect(
      await prisma.session.findUnique({ where: { id: ownerSession.id } }),
    ).not.toBeNull();

    // Owned delete succeeds on the handle.
    expect(
      await destroySessionById(owner.id, sessionHandle(ownerSession.id)),
    ).toBe(true);
    expect(
      await prisma.session.findUnique({ where: { id: ownerSession.id } }),
    ).toBeNull();
  });
});

describe("UserKnownDevice unique index", () => {
  it("dedupes on (userId, deviceHash) — the same fingerprint cannot insert twice", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("device-owner");

    await prisma.userKnownDevice.create({
      data: {
        userId: user.id,
        deviceHash: "hash-abc",
        label: "Firefox on macOS",
      },
    });

    await expect(
      prisma.userKnownDevice.create({
        data: { userId: user.id, deviceHash: "hash-abc" },
      }),
    ).rejects.toThrow();

    // A different hash for the same user inserts fine.
    await prisma.userKnownDevice.create({
      data: { userId: user.id, deviceHash: "hash-def" },
    });

    const rows = await prisma.userKnownDevice.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(2);
  });
});
