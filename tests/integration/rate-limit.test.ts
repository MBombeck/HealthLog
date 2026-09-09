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

    // Burn the budget in a window wide enough that it cannot close under the
    // four calls that fill it. It used to be 50 ms, which asked the four
    // round-trips to a containerised Postgres to finish inside a twentieth of
    // a second: on a loaded runner the window expired mid-burn, the counter
    // reset, and the fourth call came back allowed — three failures in thirty
    // days, two of them on `main` (run 33614804032, `expected true to be
    // false` on the line below, in a file that took 1278 ms to run). The short
    // window bought nothing either way, because the expiry this test is about
    // is forced by hand a few lines down rather than waited for.
    const windowMs = 60_000;
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(key, limit, windowMs);
      expect(r.allowed).toBe(true);
    }
    const denied = await checkRateLimit(key, limit, windowMs);
    expect(denied.allowed).toBe(false);

    // The denial has to be the cap, not a window that closed under the burn —
    // a reset would also have produced three allowed calls before it.
    const burned = await getPrismaClient().rateLimit.findUnique({
      where: { key },
    });
    expect(burned?.count).toBe(4);

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
