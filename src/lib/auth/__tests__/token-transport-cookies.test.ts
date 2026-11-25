/**
 * The token transport never receives a web session cookie, and a cookie that
 * rides beside a Bearer is never read as the caller.
 *
 * These pin the floor in `session.ts` and `mfa-enrollment.ts`: whichever route
 * calls `createSession` or a hint-cookie setter, a Bearer caller or a native
 * sign-in gets no `Set-Cookie` and no session row. The routes branch on the
 * same test first; this is what holds when a route forgets to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  set: vi.fn(),
  delete: vi.fn(),
}));

const db = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string;
    userId: string;
    tokenHash: string | null;
    expiresAt: Date;
    lastActiveAt: Date | null;
    actingAsUserId: string | null;
    recordEpoch: number;
    user: { id: string; deletionRequestedAt: Date | null };
  }>,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash?: string } }) =>
        where.tokenHash
          ? (db.sessions.find((s) => s.tokenHash === where.tokenHash) ?? null)
          : null,
      ),
      create: vi.fn(async ({ data }: { data: { userId: string } }) => ({
        id: "sess-new",
        ...data,
      })),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const before = db.sessions.length;
        db.sessions = db.sessions.filter((s) => s.id !== where.id);
        return { count: before - db.sessions.length };
      }),
      update: vi.fn(async () => ({})),
    },
    user: { update: vi.fn(async () => ({})) },
  },
}));

vi.mock("@/lib/settings/operator-row", () => ({
  readOperatorRow: vi.fn(async () => ({ mfaRequired: true })),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: (raw: string) => `hash:${raw}`,
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => undefined,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => jar.headers.get(name.toLowerCase()) ?? null,
  })),
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = jar.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options?: unknown) => {
      jar.set(name, value, options);
      jar.cookies.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
      jar.cookies.delete(name);
    },
  })),
}));

import {
  createSession,
  getSession,
  setOnboardingPendingCookie,
} from "@/lib/auth/session";
import { setMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";
import { refuseCookieIdentityConflict } from "@/lib/auth/cookie-identity-conflict";
import { carriesBearer, usesTokenTransport } from "@/lib/auth/token-transport";
import { prisma } from "@/lib/db";

const SECRET_A = `hls_${"a".repeat(64)}`;

function seedSession(id: string, userId: string, secret: string): void {
  db.sessions.push({
    id,
    userId,
    tokenHash: `hash:${secret}`,
    expiresAt: new Date(Date.now() + 29 * 24 * 3600_000),
    lastActiveAt: new Date(),
    actingAsUserId: null,
    recordEpoch: 0,
    user: { id: userId, deletionRequestedAt: null },
  });
}

/** Every cookie name a `set` wrote with a live value (an expiry is not a set). */
function cookiesSet(): string[] {
  return jar.set.mock.calls
    .filter(([, value, options]) => {
      const maxAge = (options as { maxAge?: number } | undefined)?.maxAge;
      return value !== "" && maxAge !== 0;
    })
    .map(([name]) => name as string);
}

beforeEach(() => {
  jar.cookies.clear();
  jar.headers.clear();
  jar.set.mockClear();
  jar.delete.mockClear();
  db.sessions = [];
  vi.mocked(prisma.session.create).mockClear();
  vi.mocked(prisma.session.update).mockClear();
});

describe("the transport predicates", () => {
  it("counts a Bearer header, the native markers, and nothing a browser sends", () => {
    const h = (init: Record<string, string>) => new Headers(init);
    expect(carriesBearer(h({ authorization: "Bearer hlk_x" }))).toBe(true);
    expect(carriesBearer(h({ authorization: "Basic dXNlcjpw" }))).toBe(false);
    expect(usesTokenTransport(h({ authorization: "Bearer hlk_x" }))).toBe(true);
    expect(usesTokenTransport(h({ "x-client-type": "native" }))).toBe(true);
    expect(usesTokenTransport(h({ "user-agent": "HealthLog-iOS/1.7" }))).toBe(
      true,
    );
    expect(
      usesTokenTransport(
        h({ "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" }),
      ),
    ).toBe(false);
  });
});

describe("createSession", () => {
  it("issues a session cookie to a browser", async () => {
    jar.headers.set("user-agent", "Mozilla/5.0 Safari/605.1.15");
    const id = await createSession("user-a", false);
    expect(id).toBe("sess-new");
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
    expect(cookiesSet()).toContain("healthlog_session");
  });

  it.each([
    ["a Bearer caller", { authorization: "Bearer hlk_token" }],
    ["a native sign-in", { "x-client-type": "native" }],
    ["the iOS app", { "user-agent": "HealthLog-iOS/1.7 CFNetwork" }],
  ])("writes no row and no cookie for %s", async (_label, headers) => {
    for (const [k, v] of Object.entries(headers)) jar.headers.set(k, v);
    const id = await createSession("user-a", true, null, null, new Date());
    expect(id).toBeNull();
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(cookiesSet()).toEqual([]);
  });
});

describe("getSession", () => {
  it("resolves a cookie session when no Bearer is present", async () => {
    seedSession("sess-a", "user-a", SECRET_A);
    jar.cookies.set("healthlog_session", SECRET_A);
    const resolved = await getSession();
    expect(resolved?.user.id).toBe("user-a");
  });

  it("reads no cookie, writes nothing and re-issues nothing beside a Bearer", async () => {
    // Old enough that the sliding expiry would re-issue the cookie.
    seedSession("sess-a", "user-a", SECRET_A);
    db.sessions[0].expiresAt = new Date(Date.now() + 2 * 24 * 3600_000);
    jar.cookies.set("healthlog_session", SECRET_A);
    jar.headers.set("authorization", "Bearer hlk_token");

    expect(await getSession()).toBeNull();
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe("the hint cookies", () => {
  it("are set for a browser", async () => {
    await setOnboardingPendingCookie(true);
    await setMfaEnrollCookie(true);
    expect(cookiesSet().sort()).toEqual(["hl_mfa_enroll", "hl_onboarding"]);
  });

  it("are neither set nor cleared on the token transport", async () => {
    jar.headers.set("authorization", "Bearer hlk_token");
    await setOnboardingPendingCookie(true);
    await setMfaEnrollCookie(true);
    await setOnboardingPendingCookie(false);
    await setMfaEnrollCookie(false);
    expect(jar.set).not.toHaveBeenCalled();
    expect(jar.delete).not.toHaveBeenCalled();
  });
});

describe("refuseCookieIdentityConflict", () => {
  it("passes with no cookie, and with a cookie of the same account", async () => {
    expect(await refuseCookieIdentityConflict("user-a")).toBe(false);
    seedSession("sess-a", "user-a", SECRET_A);
    jar.cookies.set("healthlog_session", SECRET_A);
    expect(await refuseCookieIdentityConflict("user-a")).toBe(false);
    expect(db.sessions).toHaveLength(1);
  });

  it("refuses a cookie of another account, ends that session and expires the cookie", async () => {
    seedSession("sess-a", "user-a", SECRET_A);
    jar.cookies.set("healthlog_session", SECRET_A);

    expect(await refuseCookieIdentityConflict("user-b")).toBe(true);
    expect(db.sessions).toEqual([]);
    expect(jar.cookies.has("healthlog_session")).toBe(false);
    expect(cookiesSet()).toEqual([]);
  });

  it("ignores a cookie whose session is already gone", async () => {
    jar.cookies.set("healthlog_session", SECRET_A);
    expect(await refuseCookieIdentityConflict("user-b")).toBe(false);
  });
});
