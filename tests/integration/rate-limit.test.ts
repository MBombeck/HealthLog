/**
 * Integration regression guard for `src/lib/rate-limit.ts`.
 *
 * The limiter relies on a single atomic SQL upsert (`INSERT ... ON
 * CONFLICT DO UPDATE`) so concurrent calls cannot exceed the cap. These
 * tests prove that contract against a real Postgres — a unit test with
 * a mocked client could not detect a missing UPSERT or a misplaced
 * window-reset branch.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("checkRateLimit (real Postgres)", () => {
  it("permits exactly `limit` of N concurrent calls in the same window", async () => {
    // Lazy import so `process.env.DATABASE_URL` is set by startTestDb()
    // *before* the module pulls in `@/lib/db`.
    const { checkRateLimit } = await import("@/lib/rate-limit");

    const key = "test:concurrent:1.2.3.4";
    const limit = 5;
    const windowMs = 60_000;

    const results = await Promise.all(
      Array.from({ length: 6 }, () => checkRateLimit(key, limit, windowMs)),
    );

    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;

    expect(allowed).toBe(5);
    expect(denied).toBe(1);

    const row = await getPrismaClient().rateLimit.findUnique({
      where: { key },
    });
    expect(row?.count).toBe(6);
  });

  it("resets the counter once the window expires", async () => {
    const { checkRateLimit } = await import("@/lib/rate-limit");

    const key = "test:reset:1.2.3.4";
    const limit = 3;

    // Burn the budget with a short 50ms window.
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(key, limit, 50);
      expect(r.allowed).toBe(true);
    }
    const denied = await checkRateLimit(key, limit, 50);
    expect(denied.allowed).toBe(false);

    // Manually expire the window: cheaper than sleeping and avoids
    // flaky timing on slow CI runners. The branch under test compares
    // `reset_at < NOW()`, so any past timestamp triggers the reset.
    await getPrismaClient().rateLimit.update({
      where: { key },
      data: { resetAt: new Date(Date.now() - 1_000) },
    });

    const afterReset = await checkRateLimit(key, limit, 60_000);
    expect(afterReset.allowed).toBe(true);

    const row = await getPrismaClient().rateLimit.findUnique({
      where: { key },
    });
    expect(row?.count).toBe(1);
    expect(row?.resetAt.getTime()).toBeGreaterThan(Date.now());
  });
});
