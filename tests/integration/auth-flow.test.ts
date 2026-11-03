/**
 * Integration regression guard for `src/lib/auth/session.ts`.
 *
 * The session helpers couple Postgres (`Session` row) and the `cookies()`
 * adapter from `next/headers`. A unit test with a mocked Prisma client cannot verify the
 * end-to-end flow — particularly the expired-session purge behaviour,
 * which silently deletes the row before returning null.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

// Stateful in-memory cookie jar so `createSession()` (which calls
// cookies().set) hands the value off to a subsequent `getSession()`
// (which calls cookies().get), exactly as the request lifecycle does.
// The Map lives in `mock-next-headers.ts` so all integration files
// share the same backing store under vitest `isolate: false`.
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

describe("session lifecycle (real Postgres)", () => {
  it("createSession writes a row and getSession reads it back", async () => {
    const { createSession, getSession } = await import("@/lib/auth/session");

    const user = await getPrismaClient().user.create({
      data: { username: "session-test", email: "session@example.test" },
    });

    const sessionId = await createSession(
      user.id,
      true,
      "127.0.0.1",
      "vitest/1.0",
    );

    const row = await getPrismaClient().session.findUnique({
      where: { id: sessionId },
    });
    expect(row).not.toBeNull();
    expect(row?.userId).toBe(user.id);
    expect(row?.ipAddress).toBe("127.0.0.1");
    expect(row?.userAgent).toBe("vitest/1.0");

    const result = await getSession();
    expect(result).not.toBeNull();
    expect(result?.user.id).toBe(user.id);
    expect(result?.session.id).toBe(sessionId);
  });

  it("rejects expired sessions and purges the stale row", async () => {
    const { createSession, getSession } = await import("@/lib/auth/session");

    const user = await getPrismaClient().user.create({
      data: { username: "expired-session", email: "expired@example.test" },
    });

    const sessionId = await createSession(user.id, false);

    // Force the row past its expiry — getSession must purge it.
    await getPrismaClient().session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await getSession();
    expect(result).toBeNull();

    const purged = await getPrismaClient().session.findUnique({
      where: { id: sessionId },
    });
    expect(purged).toBeNull();
  });

  it("returns null when no session cookie is present", async () => {
    const { getSession } = await import("@/lib/auth/session");
    expect(await getSession()).toBeNull();
  });

  /**
   * v1.4.22 — `createSession` now anchors the
   * `hl_onboarding` cookie itself so issuing a session without it is
   * type-impossible. Pin the contract so a future auth surface added
   * without the helper can never reintroduce the dashboard flash.
   */
  it("createSession sets the hl_onboarding cookie when onboardingPending=true", async () => {
    const { createSession } = await import("@/lib/auth/session");
    const user = await getPrismaClient().user.create({
      data: { username: "onb-pending", email: "pending@example.test" },
    });
    await createSession(user.id, true);
    expect(cookieJar.get("hl_onboarding")).toBe("pending");
  });

  it("createSession clears the hl_onboarding cookie when onboardingPending=false", async () => {
    const { createSession } = await import("@/lib/auth/session");
    const user = await getPrismaClient().user.create({
      data: { username: "onb-done", email: "done@example.test" },
    });
    cookieJar.set("hl_onboarding", "pending"); // simulate stale value
    await createSession(user.id, false);
    expect(cookieJar.get("hl_onboarding")).toBeUndefined();
  });

  /**
   * v1.30.32 — the cookie carries a CSPRNG secret, not the row's cuid.
   * These run against real Postgres because the thing under test is the
   * migration plus the unique index plus the two lookup paths; a mocked
   * client can assert the shape but not that the column and constraint
   * actually exist on a migrated database.
   */
  describe("session cookie secret (migration 0255)", () => {
    it("issues a secret cookie and stores only its hash", async () => {
      const { createSession } = await import("@/lib/auth/session");
      const { hashToken } = await import("@/lib/auth/hmac");

      const user = await getPrismaClient().user.create({
        data: { username: "secret-cookie", email: "secret@example.test" },
      });
      const sessionId = await createSession(user.id, false);

      const cookie = cookieJar.get("healthlog_session")!;
      expect(cookie).toMatch(/^hls_[0-9a-f]{64}$/);
      expect(cookie).not.toBe(sessionId);

      const row = await getPrismaClient().session.findUnique({
        where: { id: sessionId },
      });
      // The raw secret is nowhere on the row.
      expect(row?.tokenHash).toBe(hashToken(cookie));
      expect(row?.tokenHash).not.toBe(cookie);
    });

    it("authenticates by the secret and refuses the row id", async () => {
      const { createSession, getSession } = await import("@/lib/auth/session");

      const user = await getPrismaClient().user.create({
        data: { username: "id-retired", email: "retired@example.test" },
      });
      const sessionId = await createSession(user.id, false);

      // The secret works.
      expect((await getSession())?.session.id).toBe(sessionId);

      // The primary key does not. This is the whole point: knowing or
      // guessing a cuid must no longer authenticate anything.
      cookieJar.set("healthlog_session", sessionId);
      expect(await getSession()).toBeNull();
    });

    it("keeps a pre-upgrade session alive on its row id", async () => {
      // The compatibility contract. This row is exactly what the migration
      // leaves behind: a real session with a NULL token_hash whose cookie in
      // the user's browser is the cuid. The deploy must not sign them out.
      const { getSession } = await import("@/lib/auth/session");

      const user = await getPrismaClient().user.create({
        data: { username: "legacy-session", email: "legacy@example.test" },
      });
      const legacy = await getPrismaClient().session.create({
        data: {
          userId: user.id,
          expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        },
      });
      expect(legacy.tokenHash).toBeNull();

      cookieJar.set("healthlog_session", legacy.id);
      const result = await getSession();

      expect(result).not.toBeNull();
      expect(result?.session.id).toBe(legacy.id);
      expect(result?.user.id).toBe(user.id);
    });

    it("does not extend a pre-upgrade session's expiry", async () => {
      // Withholding the sliding refresh is what bounds the transition: the
      // id-resolvable path drains within the session lifetime instead of
      // renewing forever under an active user.
      const { getSession } = await import("@/lib/auth/session");

      const user = await getPrismaClient().user.create({
        data: { username: "legacy-drain", email: "drain@example.test" },
      });
      const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const legacy = await getPrismaClient().session.create({
        data: { userId: user.id, expiresAt },
      });

      cookieJar.set("healthlog_session", legacy.id);
      expect(await getSession()).not.toBeNull();

      const after = await getPrismaClient().session.findUnique({
        where: { id: legacy.id },
      });
      expect(after?.expiresAt.getTime()).toBe(expiresAt.getTime());
    });

    it("gives concurrent sessions distinct secrets under the unique index", async () => {
      const { createSession } = await import("@/lib/auth/session");

      const user = await getPrismaClient().user.create({
        data: { username: "many-secrets", email: "many@example.test" },
      });
      await createSession(user.id, false);
      const first = cookieJar.get("healthlog_session")!;
      await createSession(user.id, false);
      const second = cookieJar.get("healthlog_session")!;

      expect(first).not.toBe(second);
      const rows = await getPrismaClient().session.findMany({
        where: { userId: user.id },
      });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.tokenHash)).size).toBe(2);
    });

    it("logs out by resolving the secret to its row", async () => {
      const { createSession, destroySession } =
        await import("@/lib/auth/session");

      const user = await getPrismaClient().user.create({
        data: { username: "secret-logout", email: "logout@example.test" },
      });
      const sessionId = await createSession(user.id, false);

      await destroySession();

      // A logout that deleted by cookie value would leave this row behind.
      const row = await getPrismaClient().session.findUnique({
        where: { id: sessionId },
      });
      expect(row).toBeNull();
    });
  });

  it("destroySession clears the hl_onboarding cookie alongside the session cookie", async () => {
    const { createSession, destroySession } =
      await import("@/lib/auth/session");
    const user = await getPrismaClient().user.create({
      data: { username: "dest", email: "dest@example.test" },
    });
    await createSession(user.id, true);
    expect(cookieJar.get("hl_onboarding")).toBe("pending");
    await destroySession();
    expect(cookieJar.get("hl_onboarding")).toBeUndefined();
    expect(cookieJar.get("healthlog_session")).toBeUndefined();
  });
});
