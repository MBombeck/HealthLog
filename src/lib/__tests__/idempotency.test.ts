import { describe, it, expect, vi, beforeEach } from "vitest";

// The replay cache encrypts the stored body (it echoes decrypted PHI on the
// create paths). Give the suite a real key so these cases exercise the
// encrypted path rather than the skip-caching fallback.
vi.stubEnv("ENCRYPTION_KEYS", "");
vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
vi.stubEnv("ENCRYPTION_KEY", "0".repeat(64));
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    idempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    apiToken: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  // v1.37.0 — the record-session fence stamps the response echo on the
  // request-scoped wide event. There is no event outside a request scope and
  // the fence handles that with an optional call, so `undefined` is the honest
  // stub rather than a fake builder.
  getEvent: vi.fn(() => undefined),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn((raw: string) => `hashed:${raw}`),
}));

import {
  withIdempotency,
  defaultUserIdResolver,
  isCachableStatus,
} from "../idempotency";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
vi.mock("@/lib/sharing/grants", () => ({
  findActiveGrant: vi.fn(),
}));

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { findActiveGrant } from "@/lib/sharing/grants";

/** A live WRITE grant, whole record, as `delegatedGrantFacet` reads it. */
const GRANT = { id: "grant-1", access: "WRITE", scopeJson: null };
function grantFacet(grant: { id: string; access: string; scopeJson: unknown }) {
  const fp = createHash("sha256")
    .update(JSON.stringify(grant.scopeJson ?? null))
    .digest("hex")
    .slice(0, 16);
  return `g:${grant.id}:${grant.access}:${fp}`;
}

function makeRequest(
  method: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/example", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify({ ok: true }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValue(null);
  vi.mocked(findActiveGrant).mockResolvedValue(GRANT as never);
  vi.mocked(prisma.idempotencyKey.create).mockResolvedValue({} as never);
  vi.mocked(prisma.idempotencyKey.updateMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(prisma.idempotencyKey.deleteMany).mockResolvedValue({
    count: 1,
  } as never);
});

describe("withIdempotency", () => {
  it("passes through when no Idempotency-Key header is present", async () => {
    const handler = vi.fn(async () =>
      NextResponse.json({ data: { ok: true }, error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    const res = await wrapped(makeRequest("POST"));
    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("caches the response and replays it on the second call", async () => {
    let callCount = 0;
    const handler = vi.fn(async () => {
      callCount += 1;
      return NextResponse.json(
        { data: { result: callCount }, error: null },
        { status: 201 },
      );
    });
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");

    // First call: nothing cached → key claimed (create) → handler runs →
    // claim promoted to the completed response (updateMany).
    const req1 = makeRequest("POST", { "idempotency-key": "abc-12345678" });
    const res1 = await wrapped(req1);
    const body1 = await res1.json();
    expect(res1.status).toBe(201);
    expect(body1).toEqual({ data: { result: 1 }, error: null });
    expect(handler).toHaveBeenCalledTimes(1);
    // Claim inserted before the handler ran (pending sentinel).
    expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
    const claim = (
      vi.mocked(prisma.idempotencyKey.create).mock.calls[0][0] as {
        data: { responseStatus: number; responseBody: string };
      }
    ).data;
    expect(claim.responseStatus).toBe(0);
    expect(claim.responseBody).toBe("");
    // Completed response promoted via updateMany.
    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledTimes(1);

    // Capture the persisted body for replay.
    const persistedBody = (
      vi.mocked(prisma.idempotencyKey.updateMany).mock.calls[0][0] as {
        data: { responseBody: string; responseStatus: number };
      }
    ).data;

    // Second call: cache hit returns persisted envelope.
    vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValueOnce({
      id: "idem-1",
      userId: "u-1",
      key: "abc-12345678",
      method: "POST",
      path: "/api/example",
      responseStatus: persistedBody.responseStatus,
      responseBody: persistedBody.responseBody,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    } as never);

    const req2 = makeRequest("POST", { "idempotency-key": "abc-12345678" });
    const res2 = await wrapped(req2);
    expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(res2.status).toBe(201);
    const body2 = await res2.json();
    expect(body2).toEqual({ data: { result: 1 }, error: null });
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });

  it("does not cache a successful response marked no-store", async () => {
    const handler = vi.fn(async () =>
      NextResponse.json(
        { data: { failed: 1 }, error: null },
        { headers: { "Cache-Control": "private, no-store" } },
      ),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");

    const response = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );

    expect(response.status).toBe(200);
    expect(prisma.idempotencyKey.updateMany).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalled();
  });

  it("ignores expired cache rows and re-runs the handler", async () => {
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "fresh", error: null }, { status: 200 }),
    );
    vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValueOnce({
      id: "idem-old",
      userId: "u-1",
      key: "abc-12345678",
      method: "POST",
      path: "/api/example",
      responseStatus: 200,
      responseBody: '{"data":"stale","error":null}',
      expiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.idempotencyKey.delete).mockResolvedValue({} as never);

    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    const res = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );
    const body = await res.json();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ data: "fresh", error: null });
    expect(prisma.idempotencyKey.delete).toHaveBeenCalled();
  });

  it("ignores malformed Idempotency-Key headers", async () => {
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    await wrapped(makeRequest("POST", { "idempotency-key": "!!" }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it("does nothing for GET requests", async () => {
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    await wrapped(makeRequest("GET", { "idempotency-key": "abc-12345678" }));
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it("defaults to the cookie session when no resolver is given", async () => {
    vi.mocked(getSession).mockResolvedValue({
      session: { id: "s-1", expiresAt: new Date(Date.now() + 60_000) },
      user: { id: "u-default" },
    } as never);
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler);
    await wrapped(makeRequest("POST", { "idempotency-key": "abc-12345678" }));
    // Twice: once to resolve who is calling, once to read which record they
    // say they are acting on. The second read is what a delegated write costs
    // here, and it is a single indexed lookup on a request that is about to
    // write anyway.
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(prisma.idempotencyKey.create).mock
      .calls[0][0] as { data: { userId: string } };
    expect(persisted.data.userId).toBe("u-default");
  });

  it("skips caching when the default resolver finds no session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(headers).mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as ReturnType<typeof headers> extends Promise<infer T>
      ? T
      : never);
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler);
    await wrapped(makeRequest("POST", { "idempotency-key": "abc-12345678" }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });
});

// A3 — concurrent same-key requests must not both run the side-effect.
// The key is claimed (pending row) before the handler runs; a racing
// request either sees the pending row or loses the insert race, and
// must be refused with 409 instead of executing a second time.
describe("withIdempotency concurrency claim (A3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.idempotencyKey.create).mockResolvedValue({} as never);
    vi.mocked(prisma.idempotencyKey.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.idempotencyKey.deleteMany).mockResolvedValue({
      count: 1,
    } as never);
  });

  it("returns 409 without running the handler when a pending claim exists", async () => {
    // A concurrent request already claimed the key — findUnique returns
    // the pending sentinel row (responseStatus 0, not yet expired).
    vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValueOnce({
      id: "idem-pending",
      userId: "u-1",
      key: "abc-12345678",
      method: "POST",
      path: "/api/example",
      responseStatus: 0,
      responseBody: "",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    } as never);

    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    const res = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );

    expect(res.status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("returns 409 when a racing request wins the claim insert (P2002)", async () => {
    // No row at lookup time, but the claim insert collides with a
    // concurrent insert under the unique constraint.
    vi.mocked(prisma.idempotencyKey.create).mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    const res = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );

    expect(res.status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.updateMany).not.toHaveBeenCalled();
  });

  it("releases the claim and re-throws when the handler throws", async () => {
    const boom = new Error("handler exploded");
    const handler = vi.fn(async () => {
      throw boom;
    });
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");

    await expect(
      wrapped(makeRequest("POST", { "idempotency-key": "abc-12345678" })),
    ).rejects.toBe(boom);

    expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
    // Claim released so a retry isn't locked out for the pending window.
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.updateMany).not.toHaveBeenCalled();
  });
});

// Audit C-4 / phase P2: defaultUserIdResolver must support both cookie
// sessions AND Bearer tokens. Without the Bearer fallback, idempotency
// silently turned off for the iOS / external-ingest paths it was built for.
describe("defaultUserIdResolver (audit C-4)", () => {
  function mockHeader(value: string | null) {
    vi.mocked(headers).mockResolvedValue({
      get: vi
        .fn()
        .mockImplementation((name: string) =>
          name.toLowerCase() === "authorization" ? value : null,
        ),
    } as unknown as ReturnType<typeof headers> extends Promise<infer T>
      ? T
      : never);
  }

  it("returns the session user id when a cookie session is present", async () => {
    vi.mocked(getSession).mockResolvedValue({
      session: { id: "s-1" },
      user: { id: "u-cookie", role: "USER" },
    } as Awaited<ReturnType<typeof getSession>>);
    mockHeader(null);
    expect(await defaultUserIdResolver()).toBe("u-cookie");
  });

  it("falls back to Bearer-token resolution when no cookie session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    mockHeader("Bearer hlk_abcdef");
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "tok-device",
      userId: "u-bearer",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
    } as never);
    expect(await defaultUserIdResolver()).toBe("u-bearer");
    // V3 audit: assert the where-clause used the hashed token, not the
    // raw bearer. The hashToken mock returns "hashed:<raw>" — the lookup
    // MUST be against that, otherwise we are storing recoverable secrets.
    expect(prisma.apiToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: "hashed:hlk_abcdef" },
      }),
    );
  });

  it("rejects revoked Bearer tokens", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    mockHeader("Bearer hlk_abcdef");
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      userId: "u-bearer",
      revoked: true,
      expiresAt: null,
    } as never);
    expect(await defaultUserIdResolver()).toBeNull();
  });

  it("rejects expired Bearer tokens", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    mockHeader("Bearer hlk_abcdef");
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      userId: "u-bearer",
      revoked: false,
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    expect(await defaultUserIdResolver()).toBeNull();
  });

  it("returns null when no auth method is provided", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    mockHeader(null);
    expect(await defaultUserIdResolver()).toBeNull();
  });
});

// P12: bodies that contain a freshly-issued bearer token, refresh token,
// or third-party AI provider key must NEVER be persisted to the
// idempotency cache. Even if a future caller forgets and wraps an
// auth/settings route in withIdempotency, the body-content guard refuses
// to write the secret into the DB.
describe("withIdempotency body-content exclusion (P12)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.idempotencyKey.create).mockResolvedValue({} as never);
    vi.mocked(prisma.idempotencyKey.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.idempotencyKey.deleteMany).mockResolvedValue({
      count: 1,
    } as never);
  });

  it.each([
    ["hlk_ access token", '{"data":{"token":"hlk_abc123"},"error":null}'],
    ["hlr_ refresh token", '{"data":{"refresh":"hlr_xyz789"},"error":null}'],
    ["hls_ share-link token", '{"data":{"link":"hls_def456"},"error":null}'],
    [
      "hlv_ registration invite token",
      '{"data":{"token":"hlv_0a1b2c3d"},"error":null}',
    ],
    ["sk- OpenAI key", '{"data":{"echoed":"sk-1234567890"},"error":null}'],
    [
      "sk-ant- Anthropic key",
      '{"data":{"echoed":"sk-ant-api03-xyz"},"error":null}',
    ],
  ])("does NOT persist responses containing %s", async (_label, body) => {
    const handler = vi.fn(async () => new NextResponse(body, { status: 201 }));
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    await wrapped(makeRequest("POST", { "idempotency-key": "abc-12345678" }));
    expect(handler).toHaveBeenCalledTimes(1);
    // The claim row is still inserted, but the secret-shaped body must
    // never be promoted into it — the claim is released instead.
    expect(prisma.idempotencyKey.updateMany).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["task-id substring", '{"error":"task-id must not contain spaces"}'],
    ["risk-management word", '{"data":{"note":"risk-management"}}'],
    ["disk-io metric", '{"data":{"metric":"disk-io"}}'],
  ])(
    "still caches a benign payload whose text contains %s (no false positive)",
    async (_label, body) => {
      const handler = vi.fn(
        async () => new NextResponse(body, { status: 422 }),
      );
      const wrapped = withIdempotency<[NextRequest]>(
        handler,
        async () => "u-1",
      );
      await wrapped(makeRequest("POST", { "idempotency-key": "key-12345678" }));
      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it("still caches a normal payload that does not carry a secret", async () => {
    const handler = vi.fn(
      async () =>
        new NextResponse('{"data":{"id":"m-1"},"error":null}', { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    await wrapped(makeRequest("POST", { "idempotency-key": "abc-12345678" }));
    expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledTimes(1);
  });
});

// V3 audit STILL-V2-NEW: the cachable-status filter (do-not-cache for
// 401/403/408/429/5xx) had zero tests, so a regression that re-cached an
// expired bearer token's 401 would have been silent.
describe("isCachableStatus do-not-cache rules (V3 audit)", () => {
  it("caches 2xx success responses", () => {
    expect(isCachableStatus(200)).toBe(true);
    expect(isCachableStatus(201)).toBe(true);
    expect(isCachableStatus(204)).toBe(true);
  });

  it("caches 4xx validation responses (so retries don't re-execute side-effects)", () => {
    expect(isCachableStatus(400)).toBe(true);
    expect(isCachableStatus(404)).toBe(true);
    expect(isCachableStatus(409)).toBe(true);
    expect(isCachableStatus(422)).toBe(true);
  });

  it("does NOT cache 401 — the token may have been refreshed between attempts", () => {
    expect(isCachableStatus(401)).toBe(false);
  });

  it("does NOT cache 403 — authorization can change between attempts", () => {
    expect(isCachableStatus(403)).toBe(false);
  });

  it("does NOT cache 408 — caller-side timeout deserves a fresh attempt", () => {
    expect(isCachableStatus(408)).toBe(false);
  });

  it("does NOT cache 429 — caller deserves a fresh window-check on retry", () => {
    expect(isCachableStatus(429)).toBe(false);
  });

  it("does NOT cache any 5xx — server fault must not lock the user out", () => {
    expect(isCachableStatus(500)).toBe(false);
    expect(isCachableStatus(502)).toBe(false);
    expect(isCachableStatus(503)).toBe(false);
    expect(isCachableStatus(504)).toBe(false);
  });

  it("never stores the response body in cleartext", async () => {
    // The create paths echo their own decrypted DTO, so the replay cache held
    // cycle notes, mood text and allergy reactions in the clear for 24 hours -
    // in a column that lands in every backup. The secret-shaped-body guard did
    // not catch it because health data is not secret-SHAPED.
    const PHI = "felt low on Tuesday, cramps returned";
    const handler = vi.fn(async () =>
      NextResponse.json({ data: { note: PHI }, error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");

    await wrapped(makeRequest("POST", { "idempotency-key": "phi-12345678" }));

    const stored = (
      vi.mocked(prisma.idempotencyKey.updateMany).mock.calls[0][0] as {
        data: { responseBody: string };
      }
    ).data.responseBody;

    expect(stored).not.toContain(PHI);
    expect(stored).not.toContain("cramps");
    expect(stored.length).toBeGreaterThan(0);
  });
});

/**
 * The cell is scoped to the record the request claims, not only to the caller.
 *
 * `tests/integration/idempotency-record-scoped-cell.test.ts` proves the rows.
 * These prove the key the wrapper composes, which is what decides whether two
 * requests meet in one cell — including the two cases a row-level test cannot
 * show, because both end in no row at all.
 */
describe("withIdempotency — record-scoped cells", () => {
  const CLIENT_KEY = "abc-12345678";

  /** Present these headers to the wrapper for the next call. */
  function present(values: Record<string, string>): void {
    vi.mocked(headers).mockResolvedValue({
      get: (name: string) => values[name.toLowerCase()] ?? null,
    } as unknown as ReturnType<typeof headers> extends Promise<infer T>
      ? T
      : never);
  }

  /** Sign the caller in over the cookie transport, optionally switched. */
  function cookieSession(actingAsUserId: string | null): void {
    vi.mocked(getSession).mockResolvedValue({
      session: {
        id: "s-1",
        expiresAt: new Date(Date.now() + 60_000),
        actingAsUserId,
      },
      user: { id: "u-1", role: "USER" },
    } as Awaited<ReturnType<typeof getSession>>);
  }

  async function run(key = CLIENT_KEY): Promise<void> {
    const handler = vi.fn(async () =>
      NextResponse.json({ data: { ok: true }, error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler, async () => "u-1");
    await wrapped(makeRequest("POST", { "idempotency-key": key }));
  }

  /** The key the wrapper looked the cell up under. */
  function lookedUpKey(): string {
    const call = vi.mocked(prisma.idempotencyKey.findUnique).mock
      .calls[0][0] as {
      where: { userId_key_method_path: { userId: string; key: string } };
    };
    return call.where.userId_key_method_path.key;
  }

  /** The row the wrapper claimed. */
  function claimed(): { userId: string; key: string } {
    return (
      vi.mocked(prisma.idempotencyKey.create).mock.calls[0][0] as {
        data: { userId: string; key: string };
      }
    ).data;
  }

  it("folds the account named by the Bearer selector into the key", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    present({ "x-healthlog-account": "owner-9" });

    await run();

    expect(lookedUpKey()).toBe(`owner-9|${grantFacet(GRANT)}|${CLIENT_KEY}`);
    // The owner column stays the ACTOR. It is a foreign key to `users` with a
    // cascade behind it, so it can only ever hold a real account id — which is
    // why the record moved into the key and not into here.
    expect(claimed()).toMatchObject({
      userId: "u-1",
      key: `owner-9|${grantFacet(GRANT)}|${CLIENT_KEY}`,
    });
  });

  it("folds the account the cookie session is switched to", async () => {
    cookieSession("owner-7");
    present({});

    await run();

    expect(claimed().key).toBe(`owner-7|${grantFacet(GRANT)}|${CLIENT_KEY}`);
  });

  it("files a delegated request under the grant it acts through, so a replaced grant is a fresh cell", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    present({ "x-healthlog-account": "owner-9" });
    await run();
    const underFirstGrant = claimed().key;

    vi.clearAllMocks();
    vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.idempotencyKey.create).mockResolvedValue({} as never);
    vi.mocked(findActiveGrant).mockResolvedValue({
      ...GRANT,
      id: "grant-2",
      access: "READ",
    } as never);
    present({ "x-healthlog-account": "owner-9" });
    await run();

    expect(claimed().key).not.toBe(underFirstGrant);
    expect(claimed().key).toBe(
      `owner-9|${grantFacet({ ...GRANT, id: "grant-2", access: "READ" })}|${CLIENT_KEY}`,
    );
  });

  it("files a scope edited in place under a fresh cell too", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(findActiveGrant).mockResolvedValue({
      ...GRANT,
      scopeJson: { areas: ["vitals"] },
    } as never);
    present({ "x-healthlog-account": "owner-9" });
    await run();
    expect(claimed().key).not.toBe(
      `owner-9|${grantFacet(GRANT)}|${CLIENT_KEY}`,
    );
  });

  it("neither reads nor claims a cell when no live grant exists", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(findActiveGrant).mockResolvedValue(null);
    present({ "x-healthlog-account": "owner-9" });
    await run();
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("keys a narrow-scoped token's own-record cell by the token, and a wildcard token's byte-for-byte", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "tok-narrow",
      userId: "u-1",
      permissions: ["measurements:write"],
      revoked: false,
      expiresAt: null,
    } as never);
    present({ authorization: `Bearer hlk_${"b".repeat(64)}` });
    await run();
    expect(claimed().key).toBe(`t:tok-narrow|${CLIENT_KEY}`);

    vi.clearAllMocks();
    vi.mocked(prisma.idempotencyKey.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.idempotencyKey.create).mockResolvedValue({} as never);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "tok-wild",
      userId: "u-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
    } as never);
    present({ authorization: `Bearer hlk_${"c".repeat(64)}` });
    await run();
    expect(claimed().key).toBe(CLIENT_KEY);
  });

  it("keys a request with no acting account byte-for-byte as the client sent it", async () => {
    cookieSession(null);
    present({});

    await run();

    expect(lookedUpKey()).toBe(CLIENT_KEY);
    expect(claimed()).toMatchObject({ userId: "u-1", key: CLIENT_KEY });
  });

  it("ignores a selector sent over the cookie transport", async () => {
    // The resolver refuses that request outright (`misplaced_selector`). The
    // cell must not pretend it named a record either — a claim the request was
    // never going to be served must not move where its answer is filed.
    cookieSession(null);
    present({ "x-healthlog-account": "owner-9" });

    await run();

    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("refuses a client key that carries the separator", async () => {
    // The one way a caller could aim at somebody else's cell: send
    // `owner-9|abc-12345678` as the key from their own un-switched session. The
    // key validator does not admit the byte, so the header is malformed and the
    // wrapper does not cache at all.
    vi.mocked(getSession).mockResolvedValue(null);
    present({});

    await run(`owner-9|${CLIENT_KEY}`);

    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("skips the cache when the claimed account names nothing that could exist", async () => {
    // Longer than any account id. The request is refused downstream; caching it
    // would let a caller write an arbitrarily long key into the table on the
    // way to a 403.
    vi.mocked(getSession).mockResolvedValue(null);
    present({ "x-healthlog-account": "x".repeat(65) });

    await run();

    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });
});

/**
 * v1.37.0 — the record-session fence, above the replay cache.
 *
 * The property is a PLACEMENT, and a status-code assertion cannot see it: a
 * wrapper that read the cell, replayed nothing, released its claim and then
 * returned 409 would look identical from outside. `findCached` and `claimKey`
 * are module-private, so the instrument is one layer lower and falsifiable: the
 * two Prisma calls they make must receive zero calls for a refused request and
 * non-zero for a passing one.
 *
 * The first draft of this plan proposed asserting "no row exists for the target
 * cell" instead. That assertion cannot fail: `releaseClaim` deletes the pending
 * row whenever the handler throws, so it would pass with the fence placed after
 * `claimKey` too.
 *
 * Break it by moving the fence call below `findCached` in `withIdempotency`:
 * the `findUnique` zero-call assertion fails.
 */
describe("the record-session fence sits above the replay cache", () => {
  function fencedSession(recordEpoch: number, actingAsUserId: string | null) {
    vi.mocked(getSession).mockResolvedValue({
      session: {
        id: "s-1",
        expiresAt: new Date(Date.now() + 60_000),
        actingAsUserId,
        recordEpoch,
      },
      user: { id: "u-1" },
    } as never);
  }

  function asserts(epoch: string | null, scope: string | null) {
    vi.mocked(headers).mockResolvedValue({
      get: vi.fn((name: string) => {
        if (name.toLowerCase() === "x-healthlog-record-epoch") return epoch;
        if (name.toLowerCase() === "x-healthlog-record-scope") return scope;
        return null;
      }),
    } as never);
  }

  it("refuses a stale claim without reading or claiming a cell", async () => {
    fencedSession(4, "owner-1");
    asserts("3", "owner-1");
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler);

    const res = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).meta.errorCode).toBe("sharing.session.changed");
    // The placement, stated as the only thing that can prove it.
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
    // And the side effect the whole wrapper exists to run once never ran.
    expect(handler).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a matching claim reads the cell and claims it", async () => {
    // Without this the assertion above would pass for a wrapper that never
    // touched the cache at all.
    fencedSession(4, "owner-1");
    asserts("4", "owner-1");
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler);

    const res = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );

    expect(res.status).toBe(201);
    expect(prisma.idempotencyKey.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("lets an unfenced client through to the route's own refusal", async () => {
    // `unfenced-client` is deliberately NOT refused here: the route owns the
    // 403 a pre-fence bundle recovers from, together with its annotation and
    // audit posture. The wrapper still files the cell, because the handler is
    // about to answer.
    fencedSession(4, "owner-1");
    asserts(null, null);
    const handler = vi.fn(async () =>
      NextResponse.json(
        { data: null, error: "Account access denied" },
        { status: 403 },
      ),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler);

    const res = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );

    expect(res.status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("leaves a never-switched session byte-identical", async () => {
    fencedSession(0, null);
    asserts(null, null);
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler);

    const res = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );

    expect(res.status).toBe(201);
    expect(prisma.idempotencyKey.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
  });

  it("leaves the Bearer transport byte-identical", async () => {
    // No session row at all, so no context to be stale about — and a fence
    // header on this transport is neither read nor honoured.
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "tok-device",
      userId: "u-bearer",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(headers).mockResolvedValue({
      get: vi.fn((name: string) => {
        if (name.toLowerCase() === "authorization")
          return `Bearer hlk_${"a".repeat(64)}`;
        if (name.toLowerCase() === "x-healthlog-record-epoch") return "1";
        if (name.toLowerCase() === "x-healthlog-record-scope") return "owner-1";
        return null;
      }),
    } as never);
    const handler = vi.fn(async () =>
      NextResponse.json({ data: "ok", error: null }, { status: 201 }),
    );
    const wrapped = withIdempotency<[NextRequest]>(handler);

    const res = await wrapped(
      makeRequest("POST", { "idempotency-key": "abc-12345678" }),
    );

    expect(res.status).toBe(201);
    expect(prisma.idempotencyKey.findUnique).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
