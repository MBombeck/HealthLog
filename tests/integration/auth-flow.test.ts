/**
 * Integration regression guard for `src/lib/auth/session.ts`.
 *
 * The session helpers couple Postgres (`Session` row), the `cookies()`
 * adapter from `next/headers`, and the `db-compat` schema-migration
 * fallback. A unit test with a mocked Prisma client cannot verify the
 * end-to-end flow — particularly the expired-session purge behaviour,
 * which silently deletes the row before returning null.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

// Stateful in-memory cookie jar so `createSession()` (which calls
// cookies().set) hands the value off to a subsequent `getSession()`
// (which calls cookies().get), exactly as the request lifecycle does.
const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
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
}));

// `db-compat` runs ALTER TABLE IF NOT EXISTS statements that are no-ops
// against a freshly-migrated schema but slow tests down — short-circuit.
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

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

    const sessionId = await createSession(user.id, "127.0.0.1", "vitest/1.0");

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

    const sessionId = await createSession(user.id);

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
});
