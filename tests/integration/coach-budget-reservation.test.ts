/**
 * v1.18.7 (SENIOR-DEV HIGH + MEDIUM) — atomic Coach budget reservation.
 *
 * `reserveBudget` does a single atomic upsert-increment so concurrent
 * requests cannot all pass the daily cap (the old read-before-call gate
 * could). `reconcileSpend` then adjusts the reservation to the actual token
 * count — including on empty / sentinel replies whose tokens were still
 * burned (the prior post-hoc `recordSpend` undercounted these). These tests
 * prove both contracts against a real Postgres; a mocked client could not
 * detect a missing atomic increment.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

async function seedUser(): Promise<string> {
  const user = await getPrismaClient().user.create({
    data: {
      username: "budget-user",
      email: "budget@example.test",
      role: "USER",
    },
  });
  return user.id;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("reserveBudget (real Postgres)", () => {
  it("lets at most one of two concurrent requests push past the cap", async () => {
    const { reserveBudget } = await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-06-19";
    const cap = 1000;

    // Pre-spend 900 so a single 600-token reservation stays under the cap
    // but two concurrent ones cannot both be admitted.
    //
    // v1.38.19 — the 900 sits on BOTH counters. The ledger grew a cost
    // dimension: an operator-owned reservation is measured against
    // `operator_tokens`, so a fixture that pre-spends only the mixed total no
    // longer states its own premise ("900 already spent under this cap") and
    // would prove nothing about concurrency. The contract this test exists for
    // — two concurrent reservations cannot both pass one ceiling — is
    // unchanged, and so is every assertion below.
    await getPrismaClient().coachUsage.create({
      data: {
        userId,
        dateKey,
        totalTokens: 900,
        operatorTokens: 900,
        messageCount: 1,
      },
    });

    const [a, b] = await Promise.all([
      reserveBudget(userId, 600, dateKey, cap, "operator", "coach"),
      reserveBudget(userId, 600, dateKey, cap, "operator", "coach"),
    ]);

    // Exactly one is admitted: the first to commit sees prior 900 (< cap) and
    // reserves to 1500; the second sees prior 1500 (>= cap) and is refused +
    // refunded. Order is non-deterministic, so assert the SET of outcomes.
    const allowed = [a, b].filter((r) => r.allowed).length;
    expect(allowed).toBe(1);

    // The refused reservation was refunded, so the row reflects exactly one
    // admitted 600-token reservation on top of the 900 baseline.
    const row = await getPrismaClient().coachUsage.findUnique({
      where: { userId_dateKey: { userId, dateKey } },
    });
    expect(row?.totalTokens).toBe(1500);
    expect(row?.operatorTokens).toBe(1500);
  });

  it("lets at most one of two concurrent requests push past the TOTAL ceiling", async () => {
    // The same guarantee on the other arm. An operator-funded chain whose key
    // keeps failing leaves `operator_tokens` near zero all day, so the abuse
    // ceiling on the mixed total is the only ceiling left — and it has to
    // serialise exactly like the owner's does.
    const { reserveBudget, USER_PLAN_CAP } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-06-23";

    await getPrismaClient().coachUsage.create({
      data: {
        userId,
        dateKey,
        totalTokens: USER_PLAN_CAP - 100,
        operatorTokens: 0,
        messageCount: 1,
      },
    });

    const [a, b] = await Promise.all([
      reserveBudget(userId, 600, dateKey, 200_000, "operator", "coach"),
      reserveBudget(userId, 600, dateKey, 200_000, "operator", "coach"),
    ]);

    expect([a, b].filter((r) => r.allowed).length).toBe(1);
    expect([a, b].find((r) => !r.allowed)?.limit).toBe("total-cap");
  });

  it("admits the first request of a fresh day via the upsert create branch", async () => {
    const { reserveBudget } = await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-06-20";

    const res = await reserveBudget(
      userId,
      600,
      dateKey,
      25_000,
      "operator",
      "coach",
    );
    expect(res.allowed).toBe(true);

    const row = await getPrismaClient().coachUsage.findUnique({
      where: { userId_dateKey: { userId, dateKey } },
    });
    expect(row?.totalTokens).toBe(600);
    expect(row?.messageCount).toBe(1);
  });

  it("reconciles the reservation down to a smaller actual count", async () => {
    const { reserveBudget, reconcileSpend } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-06-21";

    const res = await reserveBudget(
      userId,
      600,
      dateKey,
      25_000,
      "operator",
      "coach",
    );
    await reconcileSpend(userId, res.reserved, 120, dateKey, 0, {
      servedBy: "admin-openai",
      reservedOwner: res.owner,
    });

    const row = await getPrismaClient().coachUsage.findUnique({
      where: { userId_dateKey: { userId, dateKey } },
    });
    // 600 reserved → reconciled to the actual 120 burned.
    expect(row?.totalTokens).toBe(120);
  });

  it("still records burned tokens on an empty/sentinel reply (no undercount)", async () => {
    const { reserveBudget, reconcileSpend } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-06-22";

    // Provider returned 450 tokens but the reply was empty/sentinel: the
    // reconcile must still record the 450 burned, not zero.
    const res = await reserveBudget(
      userId,
      600,
      dateKey,
      25_000,
      "operator",
      "coach",
    );
    await reconcileSpend(userId, res.reserved, 450, dateKey, 0, {
      servedBy: "admin-openai",
      reservedOwner: res.owner,
    });

    const row = await getPrismaClient().coachUsage.findUnique({
      where: { userId_dateKey: { userId, dateKey } },
    });
    expect(row?.totalTokens).toBe(450);
    expect(row?.totalTokens).toBeGreaterThan(0);
  });
});
