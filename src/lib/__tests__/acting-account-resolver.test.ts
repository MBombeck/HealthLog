/**
 * v1.36.0 — the acting-account resolver, arm by arm.
 *
 * Three things are worth more here than anywhere else in the feature, because
 * everything downstream trusts them:
 *
 *   1. **It fails closed.** A bare `requireAuth()` reached under an active
 *      switch refuses. It must never fall back to the caller's own account —
 *      a delegate who believes they are reading the owner's record being handed
 *      their own is the same data-mixing failure, pointed the other way.
 *   2. **Refusals do not enumerate.** A selector naming an account that does
 *      not exist and one naming an account that granted nothing produce the
 *      same bytes. Asserted as bytes, not as "both were 403".
 *   3. **Nothing is cached.** The grant is loaded on the request that uses it.
 *      Proven against a real database in
 *      `tests/integration/acting-account-resolver.test.ts`, where revoking
 *      between two requests is a thing that can actually happen.
 *
 * The grant module is deliberately NOT mocked. The resolver consuming S1's
 * `isGrantActive` rather than its own idea of "active" is the property that
 * keeps the panel and the resolver from disagreeing, and a mocked predicate
 * would report that property working while it was broken. The Prisma fake below
 * honours its `where` clause for the same reason: a fake that ignores `where`
 * turns every scoping assertion into a check that cannot fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks must be hoisted before importing the module under test. ---

interface GrantRow {
  id: string;
  grantorId: string;
  granteeId: string;
  access: "READ" | "WRITE" | "MANAGE";
  /** v1.37.0 — NULL is the entire record; an array narrows to those sections. */
  scopeJson: string[] | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

const grantRows: GrantRow[] = [];
const userRows = new Map<
  string,
  { id: string; role: string; managedProfileAt: Date | null }
>();
const touched: string[] = [];

vi.mock("@/lib/db", () => ({
  prisma: {
    accountGrant: {
      // Honours the narrowing the real query performs. `findActiveGrant`
      // narrows on `revokedAt: null` in SQL and leaves accepted/expired to the
      // state machine; a fake that returned any row for any `where` would make
      // the cross-user arms below pass no matter what the resolver did.
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            grantorId: string;
            granteeId: string;
            revokedAt: null;
          };
        }) =>
          grantRows.find(
            (g) =>
              g.grantorId === where.grantorId &&
              g.granteeId === where.granteeId &&
              (where.revokedAt === null ? g.revokedAt === null : true),
          ) ?? null,
      ),
      update: vi.fn(async ({ where }: { where: { id: string } }) => {
        touched.push(where.id);
        return {};
      }),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          userRows.get(where.id) ?? null,
      ),
    },
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    webauthnMfaCredential: { count: vi.fn(async () => 0) },
    session: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn(() => "hash") }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  // v1.36.0 — the resolver also writes the owner's day-coalesced access row.
  // Stubbed here because what it writes is a question about rows, answered in
  // `tests/integration/sharing-audit-actor.test.ts` against a real database.
  recordDelegatedAccess: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

const headerJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
  })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// --- Imports use the mocked modules above. ---

import { NextRequest, NextResponse } from "next/server";
import {
  ACCOUNT_SELECTOR_HEADER,
  apiHandler,
  requireActorAuth,
  requireGuardianAuth,
  requireAdmin,
  requireAuth,
  requireCookieAuth,
  requireFreshMfa,
  requireRecordAuth,
  type RecordAuthContext,
} from "../api-handler";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { emitIfSampled } from "@/lib/logging/transports";
import { prisma } from "@/lib/db";
import type { WideEvent } from "@/lib/logging/types";
import { bodyWithoutRequestId } from "@/__tests__/helpers/error-envelope";

const OWNER = "owner-1";
const DELEGATE = "delegate-1";

function user(
  id: string,
  role: "USER" | "ADMIN" = "USER",
  managedProfileAt: Date | null = null,
) {
  return {
    id,
    role,
    username: id,
    email: `${id}@example.test`,
    managedProfileAt,
  };
}

/**
 * Sign the delegate in over the cookie transport.
 *
 * v1.37.0 — this also attaches a TRUTHFUL record-session assertion, because
 * that is what the shipped browser client does on every same-origin request.
 * Without it every switched case in this file would be testing the fence's
 * pre-fence-bundle arm rather than the resolver arm it was written for: a
 * session pointed at a record is fenced, and a request carrying no assertion at
 * all is refused with 403 before the resolver decides anything.
 *
 * `recordEpoch` defaults to 0. A session at 0 pointed at its own record is the
 * fence's exemption, so the un-switched cases are byte-for-byte what they were.
 * Cases that want a stale or absent assertion override the headers themselves.
 */
function signedInCookie(
  actingAsUserId: string | null = null,
  role: "USER" | "ADMIN" = "USER",
  recordEpoch = 0,
): void {
  vi.mocked(getSession).mockResolvedValue({
    session: {
      id: "session-1",
      expiresAt: new Date(Date.now() + 3_600_000),
      actingAsUserId,
      recordEpoch,
    },
    user: user(DELEGATE, role) as never,
  });
  headerJar.set("x-healthlog-record-epoch", String(recordEpoch));
  headerJar.set("x-healthlog-record-scope", actingAsUserId ?? "self");
}

/** Sign the delegate in over the Bearer transport. */
function signedInBearer(): void {
  vi.mocked(getSession).mockResolvedValue(null);
  headerJar.set("authorization", "Bearer hlk_" + "a".repeat(64));
  vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
    id: "token-1",
    userId: DELEGATE,
    permissions: ["*"],
    revoked: false,
    expiresAt: new Date(Date.now() + 3_600_000),
  } as never);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
  userRows.set(DELEGATE, user(DELEGATE));
}

function selector(value: string): void {
  headerJar.set(ACCOUNT_SELECTOR_HEADER, value);
}

function liveGrant(overrides: Partial<GrantRow> = {}): GrantRow {
  const row: GrantRow = {
    id: "grant-1",
    grantorId: OWNER,
    granteeId: DELEGATE,
    access: "READ",
    scopeJson: null,
    acceptedAt: new Date(Date.now() - 60_000),
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
  grantRows.push(row);
  return row;
}

/**
 * Run a resolver call the way a route runs it: inside `apiHandler`, against a
 * real `NextRequest`, so the HTTP method the resolver reads is the one the
 * request actually carried and the refusal is a real HTTP response.
 */
function route(
  resolve: () => Promise<unknown>,
): (method?: string) => Promise<Response> {
  // A zero-argument handler is assignable to the one-argument shape Next.js
  // calls; naming the type here keeps the call site honest without an unused
  // parameter.
  const handler: (request: NextRequest) => Promise<Response> = apiHandler(
    async () => {
      await resolve();
      return NextResponse.json({ data: null, error: null });
    },
  );
  return (method = "GET") =>
    handler(new NextRequest("http://localhost/api/test", { method }));
}

/**
 * Resolve inside a route and hand back what the handler body would have seen.
 * Every substitution assertion runs through here rather than calling the
 * resolver bare, because the HTTP method is part of the decision and a bare
 * call has none.
 */
async function resolveInRoute<T>(
  resolve: () => Promise<T>,
  method = "GET",
): Promise<T> {
  let value: T | undefined;
  const response = await route(async () => {
    value = await resolve();
  })(method);
  expect(response.status).toBe(200);
  return value as T;
}

/** The wide event the last run emitted. */
function lastEvent(): WideEvent {
  const calls = vi.mocked(emitIfSampled).mock.calls;
  return calls[calls.length - 1][0] as WideEvent;
}

function sharingAuditCalls() {
  return vi
    .mocked(auditLog)
    .mock.calls.filter(([action]) => action === "sharing.access.denied");
}

beforeEach(() => {
  vi.clearAllMocks();
  grantRows.length = 0;
  userRows.clear();
  touched.length = 0;
  headerJar.clear();
  userRows.set(OWNER, user(OWNER));
  userRows.set(DELEGATE, user(DELEGATE));
});

describe("do no harm — nothing is acting as anyone", () => {
  it("resolves every mode to the caller, and never asks about a grant", async () => {
    signedInCookie(null);

    const bare = await resolveInRoute(() => requireAuth());
    expect(bare.user.id).toBe(DELEGATE);

    const actor = await resolveInRoute(() => requireActorAuth());
    expect(actor.user.id).toBe(DELEGATE);

    const record = await resolveInRoute(() =>
      requireRecordAuth("read", "measurements"),
    );
    expect(record.user.id).toBe(DELEGATE);
    expect(record.actor.id).toBe(DELEGATE);
    expect(record.grantId).toBeNull();

    // No carrier means no authorization question was ever asked. If this
    // fires, the resolver is doing work on the un-switched path — which is
    // where 100% of today's traffic lives.
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
    expect(sharingAuditCalls()).toHaveLength(0);
  });

  it("leaves the wide event's actor identity alone", async () => {
    signedInCookie(null);
    const call = route(() => requireRecordAuth("read", "measurements"));
    await call();

    expect(lastEvent().auth?.user_id).toBe(DELEGATE);
    expect(lastEvent().auth?.acting_as).toBeUndefined();
  });
});

describe("bare requireAuth refuses to run under a switch", () => {
  it("refuses the session carrier without falling back to the caller", async () => {
    signedInCookie(OWNER);
    liveGrant();

    const response = await route(() => requireAuth())();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.meta.errorCode).toBe("sharing.not_permitted");
    expect(body.data).toBeNull();
  });

  it("refuses even when the grant behind the switch is perfectly valid", async () => {
    // The point of the fail-closed arm: the grant is not the question. The
    // route never declared that it can be used on someone else's record.
    signedInCookie(OWNER);
    liveGrant();

    await expect(requireAuth()).rejects.toMatchObject({
      errorCode: "sharing.not_permitted",
      statusCode: 403,
    });
  });

  it("refuses a Bearer selector, and records it", async () => {
    signedInBearer();
    selector(OWNER);
    liveGrant();

    await expect(requireAuth()).rejects.toMatchObject({
      errorCode: "sharing.not_permitted",
    });
    expect(sharingAuditCalls()).toHaveLength(1);
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      userId: DELEGATE,
      details: expect.objectContaining({
        reason: "undeclared_mode",
        carrier: "header",
        target: OWNER,
      }),
    });
  });

  it("refuses a selector sent over the cookie transport", async () => {
    // The header is a Bearer-only carrier. Ignoring it here would serve the
    // caller's own record to a client that believes it asked for another's.
    signedInCookie(null);
    selector(OWNER);

    await expect(requireAuth()).rejects.toMatchObject({
      errorCode: "sharing.not_permitted",
    });
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ carrier: "misplaced-header" }),
    });
  });

  it("keeps the ambient web refusal out of the audit table", async () => {
    // Every navigation and poll that touches a non-delegable route lands here
    // while a switch is on. A row per request would bury the header refusals,
    // which are the ones that mean something.
    signedInCookie(OWNER);
    await expect(requireAuth()).rejects.toThrow();
    expect(sharingAuditCalls()).toHaveLength(0);
  });
});

describe("requireActorAuth — always the caller's own rows", () => {
  it("works under a session switch and answers as the caller", async () => {
    signedInCookie(OWNER);
    liveGrant();

    const ctx = await requireActorAuth();
    expect(ctx.user.id).toBe(DELEGATE);
    // The switcher, the banner and the "whose records may I open" list all run
    // while switched, and every one of them is about the delegate.
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a Bearer selector loudly", async () => {
    signedInBearer();
    selector(OWNER);
    liveGrant();

    await expect(requireActorAuth()).rejects.toMatchObject({
      errorCode: "sharing.not_permitted",
      statusCode: 403,
    });
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ reason: "actor_surface" }),
    });
  });

  it("refuses a selector on the cookie transport too", async () => {
    signedInCookie(null);
    selector(OWNER);
    await expect(requireActorAuth()).rejects.toMatchObject({
      errorCode: "sharing.not_permitted",
    });
  });
});

describe("requireRecordAuth — substitution", () => {
  it("substitutes the owner as the data scope and keeps the delegate as actor", async () => {
    signedInCookie(OWNER);
    const grant = liveGrant();

    const resolved: RecordAuthContext = await resolveInRoute(() =>
      requireRecordAuth("read", "measurements"),
    );
    expect(resolved.user.id).toBe(OWNER);
    expect(resolved.actor.id).toBe(DELEGATE);
    expect(resolved.grantId).toBe(grant.id);
  });

  it("substitutes over the Bearer selector as well", async () => {
    signedInBearer();
    selector(OWNER);
    liveGrant();

    const resolved = await resolveInRoute(() =>
      requireRecordAuth("read", "measurements"),
    );
    expect(resolved.user.id).toBe(OWNER);
    expect(resolved.actor.id).toBe(DELEGATE);
  });

  it("names the acting account on the wide event without moving the actor", async () => {
    signedInCookie(OWNER);
    liveGrant();

    await route(() => requireRecordAuth("read", "measurements"))();
    expect(lastEvent().auth?.user_id).toBe(DELEGATE);
    expect(lastEvent().auth?.acting_as).toBe(OWNER);
  });

  it("stamps the grant as used without making the read wait on it", async () => {
    signedInCookie(OWNER);
    const grant = liveGrant();

    await resolveInRoute(() => requireRecordAuth("read", "measurements"));
    await new Promise((r) => setTimeout(r, 0));
    expect(touched).toEqual([grant.id]);
  });
});

describe("requireRecordAuth — every way a grant can fail", () => {
  const refused = async (): Promise<Response> => {
    const response = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();
    expect(response.status).toBe(403);
    expect((await response.clone().json()).meta.errorCode).toBe(
      "sharing.access.denied",
    );
    return response;
  };

  it("refuses a pending invitation", async () => {
    signedInCookie(OWNER);
    liveGrant({ acceptedAt: null });
    await refused();
  });

  it("refuses a revoked grant", async () => {
    signedInCookie(OWNER);
    liveGrant({ revokedAt: new Date(Date.now() - 1000) });
    await refused();
  });

  it("refuses an expired grant", async () => {
    signedInCookie(OWNER);
    liveGrant({ expiresAt: new Date(Date.now() - 1000) });
    await refused();
  });

  it("refuses a grant made to somebody else", async () => {
    signedInCookie(OWNER);
    liveGrant({ granteeId: "other-delegate" });
    await refused();
  });

  it("refuses a write method under a read grant", async () => {
    signedInCookie(OWNER);
    liveGrant();

    const response = await route(() =>
      requireRecordAuth("read", "measurements"),
    )("POST");
    expect(response.status).toBe(403);
    expect((await response.json()).meta.errorCode).toBe(
      "sharing.access.denied",
    );
  });

  it("reads a POST at read level only where the route declares readOverPost", async () => {
    signedInCookie(OWNER);
    liveGrant();
    const declared = route(() =>
      requireRecordAuth("read", "record", { readOverPost: true }),
    );
    expect((await declared("POST")).status).toBe(200);
    // The declaration covers POST alone: every other write method still
    // needs a write grant.
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect((await declared(method)).status, method).toBe(403);
    }
  });

  it("does not lower a declared write for a readOverPost route", async () => {
    signedInCookie(OWNER);
    liveGrant();
    const response = await route(() =>
      requireRecordAuth("write", "record", { readOverPost: true }),
    )("POST");
    expect(response.status).toBe(403);
  });

  it("refuses a declared write under a read grant", async () => {
    signedInCookie(OWNER);
    liveGrant();

    const response = await route(() =>
      requireRecordAuth("write", "measurements"),
    )();
    expect(response.status).toBe(403);
  });

  it("admits a write method once the grant says WRITE", async () => {
    // v1 never writes a WRITE row, so this arm is reached by the data rather
    // than by a special case — which is what makes v2 enforcement work instead
    // of a rewrite.
    signedInCookie(OWNER);
    liveGrant({ access: "WRITE" });

    const response = await route(() =>
      requireRecordAuth("write", "measurements"),
    )("POST");
    expect(response.status).toBe(200);
  });

  it("refuses when the method cannot be known", async () => {
    // Outside an event context there is no method to check, so we cannot prove
    // the request is a read. Same fail-closed posture as the MCP audience
    // guard.
    signedInCookie(OWNER);
    liveGrant();
    await expect(
      requireRecordAuth("read", "measurements"),
    ).rejects.toMatchObject({
      errorCode: "sharing.access.denied",
    });
  });

  it("refuses a selector too long to name an account, without querying", async () => {
    signedInBearer();
    selector("x".repeat(65));
    await expect(
      requireRecordAuth("read", "measurements"),
    ).rejects.toMatchObject({
      errorCode: "sharing.access.denied",
    });
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a selector sent over the cookie transport", async () => {
    signedInCookie(null);
    selector(OWNER);
    liveGrant();
    await expect(
      requireRecordAuth("read", "measurements"),
    ).rejects.toMatchObject({
      errorCode: "sharing.not_permitted",
    });
  });

  it("refuses when the owner row is gone under a surviving grant", async () => {
    signedInCookie(OWNER);
    liveGrant();
    userRows.delete(OWNER);
    await refused();
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ reason: "owner_missing" }),
    });
  });
});

describe("refusals do not enumerate", () => {
  it("answers identically for an account that does not exist and one that granted nothing", async () => {
    signedInBearer();
    selector("no-such-account-at-all");
    const missing = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();
    const missingBody = await bodyWithoutRequestId(missing);

    vi.clearAllMocks();
    headerJar.clear();
    signedInBearer();
    // An account that exists, has a session, has data, and simply never
    // granted this caller anything.
    userRows.set("real-stranger", user("real-stranger"));
    selector("real-stranger");
    const present = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();
    const presentBody = await bodyWithoutRequestId(present);

    expect(missing.status).toBe(present.status);
    // Bytes, not statuses. A difference of one word here is an account
    // enumeration oracle for anyone holding a login.
    expect(missingBody).toBe(presentBody);
  });

  it("answers identically for a revoked grant and a grant that never existed", async () => {
    signedInBearer();
    selector(OWNER);
    liveGrant({ revokedAt: new Date(Date.now() - 1000) });
    const revoked = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();
    const revokedBody = await bodyWithoutRequestId(revoked);

    vi.clearAllMocks();
    headerJar.clear();
    grantRows.length = 0;
    signedInBearer();
    selector(OWNER);
    const never = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();

    expect(revokedBody).toBe(await bodyWithoutRequestId(never));
  });

  it("keeps the reason off the wire and on the audit row", async () => {
    signedInBearer();
    selector(OWNER);
    liveGrant({ expiresAt: new Date(Date.now() - 1000) });

    const body = await (
      await route(() => requireRecordAuth("read", "measurements"))()
    ).text();
    expect(body).not.toContain("expire");
    expect(body).not.toContain("grant");
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ reason: "no_active_grant" }),
    });
  });
});

describe("the cookie-only helpers stay out of reach of a switch", () => {
  it("resolves requireAdmin against the actor, never the account being acted on", async () => {
    signedInCookie(OWNER, "ADMIN");
    liveGrant();
    userRows.set(OWNER, user(OWNER, "USER"));

    const ctx = await requireAdmin();
    // The role came off the caller's row. Switching into somebody's record
    // must confer nothing, and switching out of an admin's must take nothing
    // away.
    expect(ctx.user.id).toBe(DELEGATE);
  });

  it("resolves requireCookieAuth against the actor", async () => {
    signedInCookie(OWNER);
    liveGrant();
    const ctx = await requireCookieAuth();
    expect(ctx.user.id).toBe(DELEGATE);
  });

  it("resolves requireFreshMfa against the actor", async () => {
    signedInCookie(OWNER);
    liveGrant();
    vi.mocked(getSession).mockResolvedValue({
      session: {
        id: "session-1",
        expiresAt: new Date(Date.now() + 3_600_000),
        actingAsUserId: OWNER,
        recordEpoch: 0,
      },
      user: {
        ...user(DELEGATE),
        totpConfirmedAt: new Date(Date.now() - 86_400_000),
      } as never,
    });
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: new Date(),
    } as never);

    const ctx = await requireFreshMfa(300);
    expect(ctx.user.id).toBe(DELEGATE);
  });
});

/**
 * v1.37.0 — the section fence.
 *
 * A scoped grant is a door policy: the sections it names open, the others do
 * not answer at all. Every refusal below is the same 403 with the same body as
 * every other sharing refusal — only the audit reason differs — so these
 * assert the reason on the row and the bytes on the wire separately.
 */
describe("a scoped grant reaches only the sections it names", () => {
  it("admits a route whose section the grant names", async () => {
    signedInCookie(OWNER);
    liveGrant({ scopeJson: ["medications"] });

    const ctx = await resolveInRoute(() =>
      requireRecordAuth("read", "medications"),
    );
    expect(ctx.user.id).toBe(OWNER);
    expect(ctx.actor.id).toBe(DELEGATE);
  });

  it("refuses a route whose section the grant does not name", async () => {
    signedInCookie(OWNER);
    liveGrant({ scopeJson: ["medications"] });

    const response = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();
    expect(response.status).toBe(403);
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ reason: "out_of_scope" }),
    });
  });

  it("refuses every record-wide route, at any scope", async () => {
    // The invariant: an aggregate reads across sections and there is no honest
    // partial answer to one. Not filtered — refused.
    signedInCookie(OWNER);
    liveGrant({ scopeJson: ["medications", "measurements", "labs"] });

    const response = await route(() => requireRecordAuth("read", "record"))();
    expect(response.status).toBe(403);
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ reason: "out_of_scope" }),
    });
  });

  it("refuses everything when the stored scope is unreadable", async () => {
    // Fail-closed, end to end: a blob the normaliser cannot read opens
    // nothing, including a section the blob might have happened to name.
    signedInCookie(OWNER);
    liveGrant({ scopeJson: "medications" as unknown as string[] });

    for (const domain of ["medications", "measurements", "record"] as const) {
      const response = await route(() => requireRecordAuth("read", domain))();
      expect(response.status, domain).toBe(403);
    }
  });

  it("leaves a NULL-scope grant reaching everything, as before", async () => {
    // The no-regression leg. Every grant in the product is this one.
    signedInCookie(OWNER);
    liveGrant({ scopeJson: null });

    for (const domain of [
      "measurements",
      "medications",
      "labs",
      "profile",
      "illness",
      "mind",
      "cycle",
      "documents",
      "record",
    ] as const) {
      const ctx = await resolveInRoute(() => requireRecordAuth("read", domain));
      expect(ctx.user.id, domain).toBe(OWNER);
    }
  });

  it("says the same thing on the wire as every other refusal", async () => {
    signedInCookie(OWNER);
    liveGrant({ scopeJson: ["medications"] });
    const outOfScope = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();
    const outOfScopeBody = await bodyWithoutRequestId(outOfScope);

    grantRows.length = 0;
    liveGrant({ access: "READ" });
    const insufficient = await route(() =>
      requireRecordAuth("write", "measurements"),
    )();

    expect(outOfScope.status).toBe(insufficient.status);
    expect(outOfScopeBody).toBe(await bodyWithoutRequestId(insufficient));
    expect(outOfScopeBody).not.toContain("scope");
    expect(outOfScopeBody).not.toContain("section");
  });
});

/**
 * v1.37.0 — the third level, at the resolver.
 */
describe("a route declaring manage refuses everything below it", () => {
  it("admits a MANAGE grant", async () => {
    signedInCookie(OWNER);
    liveGrant({ access: "MANAGE" });

    const ctx = await resolveInRoute(
      () => requireRecordAuth("manage", "measurements"),
      "DELETE",
    );
    expect(ctx.user.id).toBe(OWNER);
  });

  it("refuses a WRITE grant on a safe method", async () => {
    // The method cannot satisfy a declaration, only escalate one. A GET on a
    // manage-declaring route is still a manage question.
    signedInCookie(OWNER);
    liveGrant({ access: "WRITE" });

    const response = await route(() =>
      requireRecordAuth("manage", "measurements"),
    )("GET");
    expect(response.status).toBe(403);
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ reason: "insufficient_access" }),
    });
  });

  it("lets a MANAGE grant satisfy a route that only asked for a write", async () => {
    signedInCookie(OWNER);
    liveGrant({ access: "MANAGE" });

    const ctx = await resolveInRoute(
      () => requireRecordAuth("write", "labs"),
      "POST",
    );
    expect(ctx.user.id).toBe(OWNER);
  });

  it("admits a MANAGE grant over the Bearer transport too", async () => {
    // The native half of the third level, and the asymmetry worth pinning:
    // a token cannot MINT a MANAGE grant (the step-up that gates the
    // invitation resolves through the session cookie — see
    // `src/app/api/account/grants/__tests__/invite-scope-and-manage.test.ts`),
    // and it EXERCISES one exactly as a browser does. Nothing about the level
    // is transport-dependent once the grant exists; a client that could not
    // use what its user was given would be a second authorization model.
    signedInBearer();
    selector(OWNER);
    liveGrant({ access: "MANAGE" });

    const ctx = await resolveInRoute(
      () => requireRecordAuth("manage", "measurements"),
      "DELETE",
    );
    expect(ctx.user.id).toBe(OWNER);
    expect(ctx.actor.id).toBe(DELEGATE);
  });
});

/**
 * v1.37.0 — the identity fence.
 *
 * The single most important arm in the release: the line between "manage my
 * data" and "own my account". An invited adult's MANAGE grant reaches the
 * record's health data and NONE of its settings, integrations, routing, grant
 * management or deletion. The gate is the managed-profile marker on the
 * record, not the level on the grant.
 */
describe("the guardian resolver gates on the marker, not the grant", () => {
  it("admits a MANAGE grant on a marked record", async () => {
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", new Date("2026-08-04T00:00:00Z")));
    liveGrant({ access: "MANAGE" });

    const ctx = await resolveInRoute(() => requireGuardianAuth());
    expect(ctx.user.id).toBe(OWNER);
    expect(ctx.actor.id).toBe(DELEGATE);
    expect(ctx.grantId).toBe("grant-1");
  });

  it("admits a Guardian over the Bearer transport, per request", async () => {
    // A Guardian's phone administers the profile it looks after, with the
    // selector on each request rather than a switch it accumulates. The
    // marker still decides; the transport does not.
    signedInBearer();
    selector(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", new Date("2026-08-04T00:00:00Z")));
    liveGrant({ access: "MANAGE" });

    const ctx = await resolveInRoute(() => requireGuardianAuth());
    expect(ctx.user.id).toBe(OWNER);
    expect(ctx.actor.id).toBe(DELEGATE);
  });

  it("refuses a MANAGE grant on an ordinary adult's record", async () => {
    // The fence. The grant is perfect and the answer is still no, because the
    // record has an owner who runs it.
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", null));
    liveGrant({ access: "MANAGE" });

    const response = await route(() => requireGuardianAuth())();
    expect(response.status).toBe(403);
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ reason: "guardian_only" }),
    });
  });

  it("refuses a WRITE grant on a marked record", async () => {
    // The marker is necessary and not sufficient either way round.
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", new Date("2026-08-04T00:00:00Z")));
    liveGrant({ access: "WRITE" });

    const response = await route(() => requireGuardianAuth())();
    expect(response.status).toBe(403);
    expect(sharingAuditCalls()[0][1]).toMatchObject({
      details: expect.objectContaining({ reason: "insufficient_access" }),
    });
  });

  it("ignores the scope on a marked record, because MANAGE carries none", async () => {
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", new Date("2026-08-04T00:00:00Z")));
    liveGrant({ access: "MANAGE", scopeJson: null });

    const ctx = await resolveInRoute(() => requireGuardianAuth());
    expect(ctx.user.id).toBe(OWNER);
  });

  it("serves the caller's own record when nothing is acting as anyone", async () => {
    // Do no harm: the owner of an ordinary record reaching their own settings
    // is the request it always was, and no grant question is asked.
    signedInCookie(null);

    const ctx = await resolveInRoute(() => requireGuardianAuth());
    expect(ctx.user.id).toBe(DELEGATE);
    expect(ctx.grantId).toBeNull();
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
  });

  it("says the same thing on the wire as every other refusal", async () => {
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", null));
    liveGrant({ access: "MANAGE" });
    const fenced = await route(() => requireGuardianAuth())();
    const fencedBody = await bodyWithoutRequestId(fenced);

    // Compared against the oldest refusal in the feature: no grant at all. The
    // two are as far apart in meaning as this feature gets — "you were never
    // given anything" and "you were given management of a record whose owner
    // runs it" — and the caller must not be able to tell them apart.
    grantRows.length = 0;
    const insufficient = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();

    expect(fenced.status).toBe(insufficient.status);
    expect(fencedBody).toBe(await bodyWithoutRequestId(insufficient));
    expect(fencedBody).not.toContain("guardian");
    expect(fencedBody).not.toContain("managed");
  });
});

/**
 * #1403 — a section only a managed profile's guardian may write to.
 *
 * The vault is health data, so it stays on the record resolver with its
 * section; what it adds is the marker. A MANAGE grant on an adult's record is
 * refused at this need exactly as `requireGuardianAuth` refuses it, so no
 * widening of what MANAGE means can reach the vault through this path.
 */
describe("a route declaring guardian admits only a managed profile's guardian", () => {
  const MARKED = new Date("2026-08-04T00:00:00Z");

  it("serves the caller's own record without asking about a grant", async () => {
    signedInCookie(null);

    const ctx = await resolveInRoute(
      () => requireRecordAuth("guardian", "documents"),
      "POST",
    );
    expect(ctx.user.id).toBe(DELEGATE);
    expect(ctx.actor.id).toBe(DELEGATE);
    expect(ctx.grantId).toBeNull();
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
  });

  it("admits a MANAGE grant on a marked record, on a safe and an unsafe method", async () => {
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", MARKED));
    liveGrant({ access: "MANAGE" });

    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const ctx = await resolveInRoute(
        () => requireRecordAuth("guardian", "documents"),
        method,
      );
      expect(ctx.user.id).toBe(OWNER);
      expect(ctx.actor.id).toBe(DELEGATE);
      expect(ctx.grantId).toBe("grant-1");
    }
  });

  it("stamps the guardian authority for provider work", async () => {
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", MARKED));
    liveGrant({ access: "MANAGE" });

    await resolveInRoute(
      () => requireRecordAuth("guardian", "documents"),
      "POST",
    );
    const auth = lastEvent().auth as Record<string, unknown>;
    expect(auth.provider_work_authority).toMatchObject({
      origin: "guardian",
      recordUserId: OWNER,
      actorUserId: DELEGATE,
      grantId: "grant-1",
    });
    expect(auth.delegated_generation).not.toBe("suppressed");
  });

  it("refuses a MANAGE grant on an adult's record, on every method", async () => {
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", null));
    liveGrant({ access: "MANAGE" });

    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const response = await route(() =>
        requireRecordAuth("guardian", "documents"),
      )(method);
      expect(response.status, method).toBe(403);
    }
    for (const [, entry] of sharingAuditCalls()) {
      expect(entry).toMatchObject({
        details: expect.objectContaining({ reason: "guardian_only" }),
      });
    }
  });

  it("refuses READ and WRITE grants on a marked record", async () => {
    userRows.set(OWNER, user(OWNER, "USER", MARKED));
    for (const access of ["READ", "WRITE"] as const) {
      grantRows.length = 0;
      vi.mocked(auditLog).mockClear();
      signedInCookie(OWNER);
      liveGrant({ access });

      const response = await route(() =>
        requireRecordAuth("guardian", "documents"),
      )("GET");
      expect(response.status, access).toBe(403);
      expect(sharingAuditCalls()[0][1]).toMatchObject({
        details: expect.objectContaining({ reason: "insufficient_access" }),
      });
    }
  });

  it("admits the guardian over the Bearer selector too", async () => {
    signedInBearer();
    selector(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", MARKED));
    liveGrant({ access: "MANAGE" });

    const ctx = await resolveInRoute(
      () => requireRecordAuth("guardian", "documents"),
      "POST",
    );
    expect(ctx.user.id).toBe(OWNER);
    expect(ctx.actor.id).toBe(DELEGATE);
  });

  it("says the same thing on the wire as every other refusal", async () => {
    signedInCookie(OWNER);
    userRows.set(OWNER, user(OWNER, "USER", null));
    liveGrant({ access: "MANAGE" });
    const fenced = await route(() =>
      requireRecordAuth("guardian", "documents"),
    )("POST");
    const fencedBody = await bodyWithoutRequestId(fenced);

    grantRows.length = 0;
    const nothing = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();

    expect(fenced.status).toBe(nothing.status);
    expect(fencedBody).toBe(await bodyWithoutRequestId(nothing));
  });
});

/**
 * v1.37.0 — the record-session fence, from the resolver's side.
 *
 * The integration file proves the refusal against a real database with the
 * `lastUsedAt` / `sharing.record.accessed` instrument. What this adds is the
 * cheapest falsifiable statement of the same property: the grant query is not
 * issued at all.
 *
 * The instrument is `prisma.accountGrant.findFirst`, not a mocked
 * `findActiveGrant`. This file deliberately does not mock `@/lib/sharing/grants`
 * — the resolver consuming that module's own idea of "active" is a property
 * under test here, and a mocked predicate would report it working while it was
 * broken. The Prisma spy is one layer lower, is honest about the same fact, and
 * costs nothing.
 */
describe("the record-session fence, above the grant lookup", () => {
  it("issues no grant query when the asserted epoch is behind", async () => {
    signedInCookie(OWNER, "USER", 4);
    liveGrant();
    headerJar.set("x-healthlog-record-epoch", "3");
    headerJar.set("x-healthlog-record-scope", OWNER);

    const res = await route(() => requireRecordAuth("read", "measurements"))();

    expect(res.status).toBe(409);
    expect((await res.json()).meta.errorCode).toBe("sharing.session.changed");
    // The whole point: nothing was asked of the grant table.
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
    // And nothing was stamped on it either.
    expect(touched).toEqual([]);
  });

  it("issues no grant query when the client sent no assertion at all", async () => {
    signedInCookie(OWNER, "USER", 4);
    liveGrant();
    // A bundle that predates the fence: no assertion on the wire at all.
    headerJar.delete("x-healthlog-record-epoch");
    headerJar.delete("x-healthlog-record-scope");

    const res = await route(() => requireRecordAuth("read", "measurements"))();

    expect(res.status).toBe(403);
    expect((await res.json()).meta.errorCode).toBe("sharing.access.denied");
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a matching assertion does reach the grant query", async () => {
    // Without this the test above would pass for a resolver that never queried
    // the grant table at all.
    signedInCookie(OWNER, "USER", 4);
    liveGrant();
    headerJar.set("x-healthlog-record-epoch", "4");
    headerJar.set("x-healthlog-record-scope", OWNER);

    const ctx = await resolveInRoute(() =>
      requireRecordAuth("read", "measurements"),
    );

    expect(ctx.user.id).toBe(OWNER);
    expect(prisma.accountGrant.findFirst).toHaveBeenCalled();
    expect(touched).toEqual(["grant-1"]);
  });

  it("guards the guardian resolver the same way", async () => {
    signedInCookie(OWNER, "USER", 2);
    userRows.set(OWNER, user(OWNER, "USER", new Date()));
    liveGrant({ access: "MANAGE" });
    headerJar.set("x-healthlog-record-epoch", "1");
    headerJar.set("x-healthlog-record-scope", OWNER);

    const res = await route(() => requireGuardianAuth())();

    expect(res.status).toBe(409);
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
  });

  it("leaves a never-switched session alone, header or no header", async () => {
    // The exemption. A session at epoch 0 pointed at its own record is served
    // byte-for-byte as it was before the fence existed.
    signedInCookie(null, "USER", 0);
    headerJar.delete("x-healthlog-record-epoch");
    headerJar.delete("x-healthlog-record-scope");
    const ctx = await resolveInRoute(() =>
      requireRecordAuth("read", "measurements"),
    );
    expect(ctx.user.id).toBe(DELEGATE);
    expect(prisma.accountGrant.findFirst).not.toHaveBeenCalled();
  });

  it("echoes the context it served under, and only when it resolved one", async () => {
    signedInCookie(OWNER, "USER", 4);
    liveGrant();
    headerJar.set("x-healthlog-record-epoch", "4");
    headerJar.set("x-healthlog-record-scope", OWNER);
    const served = await route(() =>
      requireRecordAuth("read", "measurements"),
    )();
    expect(served.headers.get("x-healthlog-record-epoch")).toBe("4");
    expect(served.headers.get("x-healthlog-record-scope")).toBe(OWNER);

    // An actor surface decides nothing about a record and therefore echoes
    // nothing. A client that discarded on ABSENCE would throw this away, and
    // with it the public `/api/version` poll.
    headerJar.clear();
    signedInCookie(null, "USER", 0);
    const actor = await route(() => requireActorAuth())();
    expect(actor.status).toBe(200);
    expect(actor.headers.get("x-healthlog-record-epoch")).toBeNull();
    expect(actor.headers.get("x-healthlog-record-scope")).toBeNull();
  });
});
