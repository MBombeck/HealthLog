import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    idempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    apiToken: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
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
import { headers } from "next/headers";

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
  vi.mocked(prisma.idempotencyKey.create).mockResolvedValue({} as never);
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

    // First call: nothing cached → handler runs → response stored.
    const req1 = makeRequest("POST", { "idempotency-key": "abc-12345678" });
    const res1 = await wrapped(req1);
    const body1 = await res1.json();
    expect(res1.status).toBe(201);
    expect(body1).toEqual({ data: { result: 1 }, error: null });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);

    // Capture the persisted body for replay.
    const persistedBody = (
      vi.mocked(prisma.idempotencyKey.create).mock.calls[0][0] as {
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
    expect(getSession).toHaveBeenCalledTimes(1);
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

// Audit C-4 / phase P2: defaultUserIdResolver must support both cookie
// sessions AND Bearer tokens. Without the Bearer fallback, idempotency
// silently turned off for the iOS / external-ingest paths it was built for.
describe("defaultUserIdResolver (audit C-4)", () => {
  function mockHeader(value: string | null) {
    vi.mocked(headers).mockResolvedValue({
      get: vi.fn().mockImplementation((name: string) =>
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
      userId: "u-bearer",
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
});
