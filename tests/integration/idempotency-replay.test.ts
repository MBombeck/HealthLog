/**
 * Integration regression guard for `src/lib/idempotency.ts`.
 *
 * Mobile clients retry POST/PUT/PATCH/DELETE with the same
 * `Idempotency-Key`; the wrapper must replay the cached response without
 * re-running the side-effect. These tests exercise the cache table
 * (`idempotency_keys`) end-to-end against a real Postgres.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

// `withIdempotency()` calls `getSession()` (cookie-backed) by default and
// falls back to a Bearer-token lookup. We stub `next/headers` to return
// a fixed user id via the cookie path so the integration stays focused
// on the cache-replay contract rather than the auth machinery.
const TEST_USER_ID = "user-idempotency-test";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(async () => ({
    session: {
      id: "session-stub",
      expiresAt: new Date(Date.now() + 1_000_000),
    },
    user: { id: TEST_USER_ID },
  })),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  // Seed the user the resolver claims to authenticate as so the FK
  // constraint on idempotency_keys.user_id holds.
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "idempotency-test",
      email: "idempotency@example.test",
    },
  });
});

function makeRequest(key: string | null, path = "/api/test"): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (key) headers["idempotency-key"] = key;
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ok: true }),
  });
}

describe("withIdempotency (real Postgres)", () => {
  it("replays the cached response and skips the handler on retry", async () => {
    const { withIdempotency } = await import("@/lib/idempotency");

    let invocations = 0;
    const handler = withIdempotency(async () => {
      invocations++;
      return NextResponse.json({ count: invocations }, { status: 201 });
    });

    const first = await handler(makeRequest("abc-12345678"));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ count: 1 });
    expect(invocations).toBe(1);

    const replay = await handler(makeRequest("abc-12345678"));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual({ count: 1 });
    expect(invocations).toBe(1); // handler did NOT run again

    const rows = await getPrismaClient().idempotencyKey.findMany({
      where: { userId: TEST_USER_ID, key: "abc-12345678" },
    });
    expect(rows).toHaveLength(1);
  });

  it("re-runs the handler after the cached row's TTL has elapsed", async () => {
    const { withIdempotency } = await import("@/lib/idempotency");

    let invocations = 0;
    const handler = withIdempotency(async () => {
      invocations++;
      return NextResponse.json({ count: invocations }, { status: 201 });
    });

    await handler(makeRequest("expired-12345678"));
    expect(invocations).toBe(1);

    // Force the cached row past its expiry — the wrapper purges and
    // falls through to the handler.
    await getPrismaClient().idempotencyKey.updateMany({
      where: { userId: TEST_USER_ID, key: "expired-12345678" },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const second = await handler(makeRequest("expired-12345678"));
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ count: 2 });
    expect(invocations).toBe(2);

    const rows = await getPrismaClient().idempotencyKey.findMany({
      where: { userId: TEST_USER_ID, key: "expired-12345678" },
    });
    // Original row was deleted as stale, then a fresh one was inserted.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does NOT cache 401/403/408/429/5xx responses", async () => {
    const { withIdempotency } = await import("@/lib/idempotency");

    const cases = [401, 403, 408, 429, 500, 502, 503];
    for (const status of cases) {
      const key = `noncacheable-${status}-abcdef`;
      const handler = withIdempotency(async () =>
        NextResponse.json({ status }, { status }),
      );
      const response = await handler(makeRequest(key));
      expect(response.status).toBe(status);

      const row = await getPrismaClient().idempotencyKey.findFirst({
        where: { userId: TEST_USER_ID, key },
      });
      expect(row).toBeNull();
    }
  });

  it("DOES cache 4xx-validation responses (e.g. 422)", async () => {
    const { withIdempotency } = await import("@/lib/idempotency");

    const handler = withIdempotency(async () =>
      NextResponse.json({ error: "validation" }, { status: 422 }),
    );

    await handler(makeRequest("validation-12345678"));
    const row = await getPrismaClient().idempotencyKey.findFirst({
      where: { userId: TEST_USER_ID, key: "validation-12345678" },
    });
    expect(row?.responseStatus).toBe(422);
  });
});
