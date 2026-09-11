/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/auth/register.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn().mockResolvedValue({ registrationEnabled: true }),
    },
    // v1.28.42 (M1) — the first-admin count+insert now runs inside a
    // transaction-scoped advisory lock. Default `$transaction` to run the
    // callback with the same prisma mock as its `tx` handle.
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
  },
}));

// v1.28.42 — fail-open breach check + silent device record; mock so the
// happy-path register tests don't reach the network / a real DB write.
vi.mock("@/lib/auth/hibp", () => ({
  checkPasswordBreach: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/auth/login-alert", () => ({
  recordSignInDevice: vi.fn().mockResolvedValue(undefined),
}));

// The invite ledger. A refused registration must never reach it — the
// assertion below is that `uses` is left alone, and the only way this route
// can touch it is through `consumeInviteToken`.
vi.mock("@/lib/auth/invite-token", () => ({
  consumeInviteToken: vi
    .fn()
    .mockResolvedValue({ ok: true, inviteId: "inv-1" }),
  recordInviteConsumer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed"),
  checkPasswordStrength: vi
    .fn()
    .mockReturnValue({ isAcceptable: true, feedback: [] }),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  checkAuthSurfaceRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn().mockResolvedValue("en"),
}));

vi.mock("@/lib/tz/resolver", () => ({
  isValidTimezone: vi.fn().mockReturnValue(true),
  resolveServerDefaultTimezone: vi.fn().mockResolvedValue("Europe/Berlin"),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { checkRateLimit, checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { checkPasswordStrength, hashPassword } from "@/lib/auth/password";
import { createSession, getSession } from "@/lib/auth/session";
import { consumeInviteToken } from "@/lib/auth/invite-token";
import { Prisma } from "@/generated/prisma/client";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "1.2.3.4",
  } as never);
  vi.mocked(getSession).mockResolvedValue(null as never);
});

describe("POST /api/auth/register — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad email + too-short username.
    const res = await postPathThrough({ email: "not-an-email", username: "x" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    // Bad email + bad username + bad password.
    const res = await postPathThrough({
      email: "not-an-email",
      username: "x",
      password: "weak",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

async function postPathThrough(body: unknown): Promise<Response> {
  return POST(postReq(body));
}

// v1.28.42 (M1 + L4) — first-admin race + duplicate-under-race status code.
describe("POST /api/auth/register — first-admin atomicity (M1)", () => {
  beforeEach(() => {
    // Happy-path setup: reach the create call deterministically.
    vi.mocked(checkPasswordStrength).mockReturnValue({
      isAcceptable: true,
      feedback: [],
    } as never);
    vi.mocked(hashPassword).mockResolvedValue("hashed");
    vi.mocked(createSession).mockResolvedValue(undefined as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.user.create).mockImplementation((async (args: {
      data: Record<string, unknown>;
    }) => ({
      id: "u1",
      username: args.data.username,
      email: args.data.email,
      role: args.data.role,
    })) as never);
    // Run the transaction callback against the same prisma mock as `tx`.
    vi.mocked(prisma.$transaction).mockImplementation(((
      fn: (tx: typeof prisma) => unknown,
    ) => fn(prisma)) as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ locked: 1 }] as never);
  });

  const validBody = {
    email: "new@example.com",
    username: "newuser",
    password: "a-very-strong-password-123",
  };

  it("mints ADMIN when the in-transaction count is 0 (genuine first user)", async () => {
    // Early gate count and in-tx count both 0.
    vi.mocked(prisma.user.count).mockResolvedValue(0 as never);

    const res = await postPathThrough(validBody);
    expect(res.status).toBe(201);
    const createArgs = vi.mocked(prisma.user.create).mock.calls[0]?.[0] as {
      data: { role: string };
    };
    expect(createArgs.data.role).toBe("ADMIN");
  });

  it("mints USER when a concurrent registration committed first (stale early read, fresh in-tx re-count)", async () => {
    // The early gate read observed the empty-DB window (0), but by the time
    // the locked transaction re-counts, the racing first registration has
    // committed → 1. Without the in-tx re-count this second user would also
    // be minted ADMIN (the double-admin bug); the fresh count closes it.
    vi.mocked(prisma.user.count)
      .mockResolvedValueOnce(0 as never) // early registrationEnabled gate
      .mockResolvedValueOnce(1 as never); // inside the advisory-locked tx

    const res = await postPathThrough(validBody);
    expect(res.status).toBe(201);
    const createArgs = vi.mocked(prisma.user.create).mock.calls[0]?.[0] as {
      data: { role: string };
    };
    expect(createArgs.data.role).toBe("USER");
  });

  it("acquires the transaction-scoped advisory lock before counting", async () => {
    vi.mocked(prisma.user.count).mockResolvedValue(0 as never);
    await postPathThrough(validBody);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("maps a P2002 duplicate under the race to 409, not 500 (L4)", async () => {
    vi.mocked(prisma.user.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.user.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "test",
      }) as never,
    );

    const res = await postPathThrough(validBody);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Username or email already taken");
  });
});

describe("POST /api/auth/register — OIDC_ONLY server-side enforcement", () => {
  const OIDC_ENV_KEYS = [
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_ONLY",
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of OIDC_ENV_KEYS) original[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of OIDC_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("rejects self-registration before any DB lookup when OIDC_ONLY is set", async () => {
    process.env.OIDC_ISSUER_URL = "https://idp.example.com";
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await postPathThrough({
      email: "new@example.com",
      username: "newuser",
      password: "a-very-strong-password-123",
    });
    expect(res.status).toBe(403);
  });

  it("still allows registration when OIDC_ONLY is set but the provider is half-configured", async () => {
    delete process.env.OIDC_ISSUER_URL;
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await postPathThrough({ email: "not-an-email", username: "x" });
    // Falls through to normal validation (422 here) rather than 403 — a
    // half-set OIDC group must never lock everyone out.
    expect(res.status).toBe(422);
  });
});

/**
 * v1.38.19 — an invitation creates a NEW account, so it cannot be accepted
 * from inside somebody's live session.
 *
 * Until this gate the route read no session at all: a request carrying a valid
 * `healthlog_session` was treated exactly like an anonymous one, and the
 * unconditional `createSession` at the end overwrote the caller's cookie with
 * the fresh account's. The admin who clicked his own invite link to check it
 * was signed out of his admin account and into a stranger's onboarding, with
 * his previous session row left valid server-side and unreachable.
 */
describe("POST /api/auth/register — refuses a live session (v1.38.19)", () => {
  const invitedBody = {
    email: "new@example.com",
    username: "newuser",
    password: "a-very-strong-password-123",
    inviteToken: `hlv_${"a".repeat(64)}`,
  };

  // Everything the happy path needs is stubbed, so the ONLY reason this
  // request can fail is the gate under test. Without it the same request
  // answers 201 and mints a session over the caller's cookie.
  beforeEach(() => {
    vi.mocked(consumeInviteToken).mockResolvedValue({
      ok: true,
      inviteId: "inv-1",
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    vi.mocked(checkPasswordStrength).mockReturnValue({
      isAcceptable: true,
      feedback: [],
    } as never);
    vi.mocked(hashPassword).mockResolvedValue("hashed" as never);
    vi.mocked(prisma.$transaction).mockImplementation(((
      fn: (tx: typeof prisma) => unknown,
    ) => fn(prisma)) as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ locked: 1 }] as never);
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: "u1",
      username: "newuser",
      email: "new@example.com",
      role: "USER",
    } as never);
    vi.mocked(getSession).mockResolvedValue({
      session: { id: "sess-1", expiresAt: new Date(Date.now() + 1e6) },
      user: { id: "u-existing", username: "admin", email: "a@example.com" },
    } as never);
  });

  it("answers 409 already_authenticated", async () => {
    const res = await postPathThrough(invitedBody);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      data: null;
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta?.errorCode).toBe("already_authenticated");
    expect(body.error).toMatch(/sign/i);
  });

  it("creates no account", async () => {
    await postPathThrough(invitedBody);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("does not burn a use of the invitation", async () => {
    await postPathThrough(invitedBody);
    expect(consumeInviteToken).not.toHaveBeenCalled();
  });

  it("does not touch the caller's own session", async () => {
    await postPathThrough(invitedBody);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses before the rate-limit bucket is spent", async () => {
    // The gate is a session read, not an attempt: a signed-in visitor
    // clicking the link three times must not lock the door for the person
    // the invitation is actually for, who shares the IP on a home network.
    await postPathThrough(invitedBody);
    expect(checkAuthSurfaceRateLimit).not.toHaveBeenCalled();
  });

  it("still registers an anonymous caller", async () => {
    // The control. Same request, no session — the invitation works.
    vi.mocked(getSession).mockResolvedValue(null as never);
    const res = await postPathThrough(invitedBody);
    expect(res.status).toBe(201);
  });
});
