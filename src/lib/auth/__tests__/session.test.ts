import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieState = vi.hoisted(() => ({
  sessionId: undefined as string | undefined,
  /** The session cookie under the `__Host-` name, when the browser holds one. */
  hostSessionId: undefined as string | undefined,
  delete: vi.fn(),
  set: vi.fn(),
}));

interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string | null;
  expiresAt: Date;
  lastActiveAt: Date | null;
  user: { id: string; locale?: string | null };
}

const store = vi.hoisted(() => ({ sessions: [] as unknown[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      // Dispatches on the `where` shape so the two resolution paths — by
      // secret hash and by primary key — stay distinguishable in assertions.
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
          const rows = store.sessions as SessionRow[];
          if (where.tokenHash !== undefined) {
            return rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
          }
          return rows.find((r) => r.id === where.id) ?? null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `sess_cuid_${(store.sessions as SessionRow[]).length + 1}`,
          lastActiveAt: null,
          user: { id: data.userId as string },
          ...data,
        } as unknown as SessionRow;
        (store.sessions as SessionRow[]).push(row);
        return row;
      }),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    apiToken: { updateMany: vi.fn() },
    refreshToken: { updateMany: vi.fn() },
    trustedDevice: { deleteMany: vi.fn() },
    mcpOAuthConnection: { updateMany: vi.fn() },
    clinicianShareLink: { updateMany: vi.fn() },
    stepUpElevation: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => undefined,
}));

// Deterministic stand-in for the HMAC so tests assert the *shape* of the
// stored value rather than re-deriving a keyed digest.
vi.mock("@/lib/auth/hmac", () => ({
  hashToken: (raw: string) => `hash:${raw}`,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      if (name === "healthlog_session" && cookieState.sessionId) {
        return { value: cookieState.sessionId };
      }
      if (name === "__Host-healthlog_session" && cookieState.hostSessionId) {
        return { value: cookieState.hostSessionId };
      }
      return undefined;
    },
    set: cookieState.set,
    delete: cookieState.delete,
  })),
}));

import { prisma } from "@/lib/db";
import {
  getSession,
  createSession,
  destroyAllSessions,
  destroySession,
  validateSessionFromCookieValue,
  validateSessionWithCreatedAt,
} from "../session";
import { SessionStoreUnavailableError } from "@/lib/api-errors";

/** A cookie value in the shape `mintSessionSecret` produces. */
const SECRET = `hls_${"a".repeat(64)}`;
const FORGED_SECRET = `hls_${"b".repeat(64)}`;
const UNKNOWN_SECRET = `hls_${"c".repeat(64)}`;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Both session cookie names were expired, the `__Host-` one as `Secure`. */
function expectSessionCookiesExpired() {
  expect(cookieState.delete).toHaveBeenCalledWith("healthlog_session");
  expect(cookieState.set).toHaveBeenCalledWith(
    "__Host-healthlog_session",
    "",
    expect.objectContaining({ maxAge: 0, path: "/", secure: true }),
  );
}

function seed(row: Partial<SessionRow> & { id: string }): SessionRow {
  const full: SessionRow = {
    userId: "user-1",
    tokenHash: null,
    expiresAt: new Date(Date.now() + THIRTY_DAYS_MS),
    lastActiveAt: new Date(),
    user: { id: row.userId ?? "user-1" },
    ...row,
  } as SessionRow;
  (store.sessions as SessionRow[]).push(full);
  return full;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.sessions = [];
  cookieState.sessionId = "sess-expired";
  cookieState.hostSessionId = undefined;
  // `clearAllMocks` drops recorded calls but keeps implementations, so a
  // rejection staged by one test would otherwise leak into the next. Re-arm
  // the write mocks with a benign default each time.
  vi.mocked(prisma.session.delete).mockResolvedValue({} as never);
  vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.session.update).mockResolvedValue({} as never);
});

describe("createSession", () => {
  it("puts a CSPRNG secret in the cookie, never the row's primary key", async () => {
    cookieState.sessionId = undefined;

    await createSession("user-1", false);

    const row = (store.sessions as SessionRow[])[0];
    const cookieValue = cookieState.set.mock.calls.find(
      (c) => c[0] === "healthlog_session",
    )![1] as string;

    // A cuid is collision-resistant, not unguessable. The cookie must not be
    // the primary key under any encoding.
    expect(cookieValue).not.toBe(row.id);
    expect(cookieValue).not.toContain(row.id);
    // 32 bytes of randomness, hex-encoded, behind a greppable prefix.
    expect(cookieValue).toMatch(/^hls_[0-9a-f]{64}$/);
    // Only the hash is persisted — a table dump yields no usable cookie.
    expect(row.tokenHash).toBe(`hash:${cookieValue}`);
    expect(row.tokenHash).not.toContain(row.id);
  });

  it("mints a distinct secret per session", async () => {
    cookieState.sessionId = undefined;
    await createSession("user-1", false);
    await createSession("user-1", false);

    const [first, second] = cookieState.set.mock.calls
      .filter((c) => c[0] === "healthlog_session")
      .map((c) => c[1] as string);

    expect(first).not.toBe(second);
  });
});

describe("getSession — cookie resolution", () => {
  it("resolves a modern cookie by its hash, not by primary key", async () => {
    const row = seed({ id: "sess_cuid_1", tokenHash: `hash:${SECRET}` });
    cookieState.sessionId = SECRET;

    const result = await getSession();

    expect(result?.session.id).toBe(row.id);
    // The lookup went through the hash column.
    expect(prisma.session.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: `hash:${SECRET}` } }),
    );
  });

  it("refuses a modern-shaped cookie whose hash matches nothing", async () => {
    seed({ id: "sess_cuid_1", tokenHash: "hash:hls_real" });
    cookieState.sessionId = FORGED_SECRET;

    await expect(getSession()).resolves.toBeNull();
  });

  it("still accepts a pre-upgrade cookie carrying the row id (no forced logout)", async () => {
    // The compatibility path. A session minted before the secret existed has
    // a NULL token_hash and the browser holds its cuid; the deploy must not
    // sign that user out.
    const row = seed({ id: "sess_legacy", tokenHash: null });
    cookieState.sessionId = "sess_legacy";

    const result = await getSession();

    expect(result?.session.id).toBe(row.id);
    expect(result?.user.id).toBe("user-1");
  });

  it("retires the row id once that row holds a secret", async () => {
    // Same cuid, but the row has been issued a secret. The id is an internal
    // identifier again and must not authenticate anything — otherwise the
    // guessable-credential surface never actually closes.
    seed({ id: "sess_upgraded", tokenHash: "hash:hls_xyz" });
    cookieState.sessionId = "sess_upgraded";

    await expect(getSession()).resolves.toBeNull();
  });
});

describe("the session cookie's name on a Secure install", () => {
  // A cookie named `healthlog_session` can be planted by any host under the
  // same registrable domain; one named `__Host-…` only by this host, and only
  // when Secure, on Path=/, without Domain.
  beforeEach(() => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("issues a new session as __Host-healthlog_session, Secure, on /, without Domain", async () => {
    cookieState.sessionId = undefined;
    await createSession("user-1", false);
    const issued = cookieState.set.mock.calls.find(
      (c) => c[0] === "__Host-healthlog_session",
    );
    expect(issued?.[1]).toMatch(/^hls_[0-9a-f]{64}$/);
    expect(issued?.[2]).toMatchObject({ secure: true, path: "/" });
    expect(issued?.[2]).not.toHaveProperty("domain");
    expect(
      cookieState.set.mock.calls.some((c) => c[0] === "healthlog_session"),
    ).toBe(false);
  });

  it("keeps a session found under the old name, and re-issues it under the new one", async () => {
    seed({ id: "sess_cuid_1", tokenHash: `hash:${SECRET}` });
    cookieState.sessionId = SECRET;

    const result = await getSession();

    expect(result?.session.id).toBe("sess_cuid_1");
    expect(cookieState.set).toHaveBeenCalledWith(
      "__Host-healthlog_session",
      SECRET,
      expect.objectContaining({ secure: true, path: "/" }),
    );
    expect(cookieState.delete).toHaveBeenCalledWith("healthlog_session");
  });

  it("answers from the __Host- cookie when a planted old-name cookie rides along", async () => {
    seed({ id: "sess_mine", tokenHash: `hash:${SECRET}` });
    seed({
      id: "sess_planted",
      userId: "attacker",
      tokenHash: `hash:${FORGED_SECRET}`,
    });
    cookieState.hostSessionId = SECRET;
    cookieState.sessionId = FORGED_SECRET;

    const result = await getSession();

    expect(result?.session.id).toBe("sess_mine");
  });

  it("logs out both names", async () => {
    seed({ id: "sess_cuid_1", tokenHash: `hash:${SECRET}` });
    cookieState.hostSessionId = SECRET;
    cookieState.sessionId = undefined;
    await destroySession();
    expect(prisma.session.delete).toHaveBeenCalledWith({
      where: { id: "sess_cuid_1" },
    });
    expectSessionCookiesExpired();
  });
});

describe("the session cookie's name on a plain-HTTP install", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the old name, which a browser accepts without Secure", async () => {
    cookieState.sessionId = undefined;
    await createSession("user-1", false);
    expect(
      cookieState.set.mock.calls.some(
        (c) => c[0] === "healthlog_session" && c[2]?.secure === false,
      ),
    ).toBe(true);
    expect(
      cookieState.set.mock.calls.some(
        (c) => c[0] === "__Host-healthlog_session",
      ),
    ).toBe(false);
  });
});

describe("getSession — sliding expiry", () => {
  it("extends a modern session and re-emits the same secret", async () => {
    seed({
      id: "sess_cuid_1",
      tokenHash: `hash:${SECRET}`,
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    });
    cookieState.sessionId = SECRET;

    await getSession();

    expect(prisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sess_cuid_1" } }),
    );
    const cookieValue = cookieState.set.mock.calls.find(
      (c) => c[0] === "healthlog_session",
    )![1];
    expect(cookieValue).toBe(SECRET);
  });

  it("withholds the extension from a legacy session so the id path drains", async () => {
    // A legacy row must not renew itself indefinitely, or an active user could
    // ride a cuid-as-credential session forever. Capped at the expiry it
    // already carries, the path is gone within the session lifetime.
    seed({
      id: "sess_legacy",
      tokenHash: null,
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    });
    cookieState.sessionId = "sess_legacy";

    const result = await getSession();

    expect(result).not.toBeNull();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });
});

describe("getSession", () => {
  it("swallows expired-session delete races and clears cookies", async () => {
    seed({
      id: "sess-expired",
      tokenHash: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    vi.mocked(prisma.session.deleteMany).mockRejectedValue(
      new Error("already deleted") as never,
    );

    await expect(getSession()).resolves.toBeNull();

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { id: "sess-expired" },
    });
    expectSessionCookiesExpired();
    expect(cookieState.delete).toHaveBeenCalledWith("hl_onboarding");
  });
});

describe("a session lookup that fails is not a missing session", () => {
  // A dropped connection used to fold into `null`, which every caller reads
  // as "signed out": the route answered 401 and the client discarded a good
  // credential because the database blinked.
  function failLookup() {
    vi.mocked(prisma.session.findUnique).mockRejectedValueOnce(
      Object.assign(new Error("Can't reach database server"), {
        code: "P1001",
      }) as never,
    );
  }

  it("getSession raises a 503 with a retryable code", async () => {
    cookieState.sessionId = SECRET;
    failLookup();
    const err = await getSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStoreUnavailableError);
    expect(err).toMatchObject({
      statusCode: 503,
      errorCode: "auth.session.unavailable",
    });
    // Nothing about the browser's credential changes on a fault.
    expect(cookieState.delete).not.toHaveBeenCalled();
  });

  it("validateSessionFromCookieValue raises instead of answering null", async () => {
    failLookup();
    await expect(validateSessionFromCookieValue(SECRET)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });

  it("validateSessionWithCreatedAt raises instead of answering null", async () => {
    failLookup();
    await expect(validateSessionWithCreatedAt(SECRET)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });

  it("raises for a pool that had no connection free (P2024)", async () => {
    vi.mocked(prisma.session.findUnique).mockRejectedValueOnce(
      Object.assign(new Error("connection pool exhausted"), {
        code: "P2024",
      }) as never,
    );
    await expect(validateSessionFromCookieValue(SECRET)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });

  it("raises for the pool's own connect timeout, which carries no code", async () => {
    // pg-pool rejects with exactly this message and nothing else; the driver
    // adapter hands it through unchanged.
    vi.mocked(prisma.session.findUnique).mockRejectedValueOnce(
      new Error("timeout exceeded when trying to connect") as never,
    );
    await expect(validateSessionFromCookieValue(SECRET)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });

  it.each([
    ["53300", "sorry, too many clients already"],
    ["55P03", "canceling statement due to lock timeout"],
    ["53200", "out of memory"],
  ])("raises for SQLSTATE %s, which is about the store", async (state, msg) => {
    vi.mocked(prisma.session.findUnique).mockRejectedValueOnce(
      Object.assign(new Error(msg), {
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: state } } },
      }) as never,
    );
    await expect(validateSessionFromCookieValue(SECRET)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });

  it("answers null for a Prisma validation refusal", async () => {
    vi.mocked(prisma.session.findUnique).mockRejectedValueOnce(
      Object.assign(new Error("Invalid value provided"), {
        name: "PrismaClientValidationError",
      }) as never,
    );
    await expect(validateSessionFromCookieValue(SECRET)).resolves.toBe(null);
  });

  it("answers null, not 503, when the query refused the value itself", async () => {
    // Postgres 22021: a byte sequence it will not accept in text. Nothing is
    // wrong with the store; a 503 here would let any anonymous caller produce
    // server errors on demand.
    vi.mocked(prisma.session.findUnique).mockRejectedValueOnce(
      Object.assign(new Error("invalid byte sequence for encoding"), {
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "22021" } } },
      }) as never,
    );
    await expect(validateSessionFromCookieValue("sess_legacy")).resolves.toBe(
      null,
    );
  });

  it.each([
    ["a NUL byte", "\u0000"],
    ["a percent-encoded NUL", "%00"],
    ["a short secret", "hls_abc"],
    ["a secret with non-hex", `hls_${"z".repeat(64)}`],
    ["an overlong legacy id", "c".repeat(65)],
  ])("never asks the database about %s", async (_name, value) => {
    vi.mocked(prisma.session.findUnique).mockClear();
    await expect(validateSessionFromCookieValue(value)).resolves.toBe(null);
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it("still answers null for a cookie that matches nothing", async () => {
    await expect(validateSessionFromCookieValue(UNKNOWN_SECRET)).resolves.toBe(
      null,
    );
  });

  it("logout still clears the cookie when the lookup fails", async () => {
    cookieState.sessionId = SECRET;
    failLookup();
    await expect(destroySession()).resolves.toBeUndefined();
    expectSessionCookiesExpired();
  });
});

describe("destroySession", () => {
  it("deletes the row the secret resolves to, not the cookie value", async () => {
    // The cookie is no longer the primary key, so a logout that deletes by
    // cookie value would no-op and leave the session alive.
    seed({ id: "sess_cuid_1", tokenHash: `hash:${SECRET}` });
    cookieState.sessionId = SECRET;

    await destroySession();

    expect(prisma.session.delete).toHaveBeenCalledWith({
      where: { id: "sess_cuid_1" },
    });
    expectSessionCookiesExpired();
  });

  it("logs a legacy cookie out too", async () => {
    seed({ id: "sess_legacy", tokenHash: null });
    cookieState.sessionId = "sess_legacy";

    await destroySession();

    expect(prisma.session.delete).toHaveBeenCalledWith({
      where: { id: "sess_legacy" },
    });
  });

  it("treats an already-deleted session row (P2025) as an idempotent logout", async () => {
    seed({ id: "sess-gone", tokenHash: null });
    cookieState.sessionId = "sess-gone";
    vi.mocked(prisma.session.delete).mockRejectedValue(
      Object.assign(new Error("record not found"), { code: "P2025" }) as never,
    );

    await expect(destroySession()).resolves.toBeUndefined();

    expect(prisma.session.delete).toHaveBeenCalledWith({
      where: { id: "sess-gone" },
    });
    expectSessionCookiesExpired();
    expect(cookieState.delete).toHaveBeenCalledWith("hl_onboarding");
  });

  it("clears the cookie even when the row delete fails on a transient fault", async () => {
    seed({ id: "sess-live", tokenHash: null });
    cookieState.sessionId = "sess-live";
    vi.mocked(prisma.session.delete).mockRejectedValue(
      Object.assign(new Error("connection reset"), { code: "P1001" }) as never,
    );

    // A non-P2025 delete failure is recorded on the wide event, not thrown,
    // so logout never leaves the client authenticated with the cookie intact.
    await expect(destroySession()).resolves.toBeUndefined();
    expectSessionCookiesExpired();
    expect(cookieState.delete).toHaveBeenCalledWith("hl_onboarding");
  });
});

describe("destroyAllSessions", () => {
  it("revokes web sessions, API tokens, and refresh tokens for the user", async () => {
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({
      count: 2,
    } as never);
    vi.mocked(prisma.apiToken.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.refreshToken.updateMany).mockResolvedValue({
      count: 3,
    } as never);

    await destroyAllSessions("user-rotated");

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-rotated" },
    });
    expect(prisma.apiToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-rotated", revoked: false },
      data: { revoked: true },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-rotated", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.mcpOAuthConnection.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-rotated", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.clinicianShareLink.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-rotated", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
