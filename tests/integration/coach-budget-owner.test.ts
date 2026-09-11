/**
 * v1.38.19 (Wave E) — the daily coach ledger attributes tokens to the COST
 * OWNER of the hop that actually served them.
 *
 * Production evidence (operator instance, 2026-09-11): the chat refused with
 * `coach.budget.exceeded` at `totalAfter: 513539` although almost every token
 * of that day had been served by `codex` — the operator's own ChatGPT plan —
 * after the operator-funded `admin-openai` primary answered HTTP 500. The
 * ledger had no provider dimension, so tokens the USER's plan paid for were
 * counted against the operator-key cap and the interactive chat was locked out
 * by background jobs every morning.
 *
 * These contracts need real Postgres: the attribution lives inside the same
 * atomic statements as the total (`INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * and the reconcile `UPDATE`), and a mocked client cannot prove that the two
 * counters move together under the row lock.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

async function seedUser(): Promise<string> {
  const user = await getPrismaClient().user.create({
    data: {
      username: "budget-owner-user",
      email: "budget-owner@example.test",
      role: "USER",
    },
  });
  return user.id;
}

async function readRow(userId: string, dateKey: string) {
  return getPrismaClient().coachUsage.findUnique({
    where: { userId_dateKey: { userId, dateKey } },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("coach_usage.operator_tokens (real Postgres)", () => {
  it("bills an operator-served turn to both counters", async () => {
    const { reserveBudget, reconcileSpend, OPERATOR_COST_CAP } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-09-11";

    const res = await reserveBudget(
      userId,
      1_000,
      dateKey,
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.allowed).toBe(true);
    await reconcileSpend(userId, res.reserved, 3_000, dateKey, 0, {
      servedBy: "admin-openai",
      reservedOwner: "operator",
    });

    const row = await readRow(userId, dateKey);
    expect(row?.totalTokens).toBe(3_000);
    expect(row?.operatorTokens).toBe(3_000);
  });

  it("moves the reservation out of operator_tokens when the user's own plan served", async () => {
    const { reserveBudget, reconcileSpend, OPERATOR_COST_CAP } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-09-11";

    // The chain's primary is operator-funded, so the reservation is charged to
    // the operator — but the `admin-openai` hop failed and `codex` (the user's
    // own ChatGPT plan) answered. The operator pays nothing for that turn.
    const res = await reserveBudget(
      userId,
      1_000,
      dateKey,
      OPERATOR_COST_CAP,
      "operator",
    );
    await reconcileSpend(userId, res.reserved, 3_000, dateKey, 0, {
      servedBy: "codex",
      reservedOwner: "operator",
    });

    const row = await readRow(userId, dateKey);
    expect(row?.totalTokens).toBe(3_000);
    expect(row?.operatorTokens).toBe(0);
  });

  it("a user-plan turn never touches an existing operator balance", async () => {
    const { reserveBudget, reconcileSpend, USER_PLAN_CAP } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-09-11";

    // An operator-funded job already spent 150k earlier that day.
    await getPrismaClient().coachUsage.create({
      data: {
        userId,
        dateKey,
        totalTokens: 150_000,
        operatorTokens: 150_000,
        messageCount: 12,
      },
    });

    const res = await reserveBudget(
      userId,
      1_000,
      dateKey,
      USER_PLAN_CAP,
      "user",
    );
    await reconcileSpend(userId, res.reserved, 4_000, dateKey, 0, {
      servedBy: "codex",
      reservedOwner: "user",
    });

    const row = await readRow(userId, dateKey);
    expect(row?.totalTokens).toBe(154_000);
    // The operator's balance is untouched: a user-plan turn must neither add
    // to it nor deplete it.
    expect(row?.operatorTokens).toBe(150_000);
  });

  it("bills an operator-funded FALLBACK hop under a user-plan reservation", async () => {
    const { reserveBudget, reconcileSpend, USER_PLAN_CAP } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-09-11";

    // Primary is the user's own key (user-plan reservation), but the chain
    // fell back onto the operator's shared key — those tokens land on the
    // operator's invoice and must be counted there.
    const res = await reserveBudget(
      userId,
      1_000,
      dateKey,
      USER_PLAN_CAP,
      "user",
    );
    await reconcileSpend(userId, res.reserved, 2_500, dateKey, 0, {
      servedBy: "admin-openai",
      reservedOwner: "user",
    });

    const row = await readRow(userId, dateKey);
    expect(row?.totalTokens).toBe(2_500);
    expect(row?.operatorTokens).toBe(2_500);
  });

  it("admits the operator's chat on a day his own plan filled", async () => {
    const { reserveBudget, OPERATOR_COST_CAP } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-09-11";

    // The operator's 06:42Z lockout, reproduced: 1.2 M tokens on the day, of
    // which only 150 k were served by the operator-funded key — the rest by
    // `codex` on his own ChatGPT plan.
    await getPrismaClient().coachUsage.create({
      data: {
        userId,
        dateKey,
        totalTokens: 1_200_000,
        operatorTokens: 150_000,
        messageCount: 240,
      },
    });

    const res = await reserveBudget(
      userId,
      3_000,
      dateKey,
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.allowed).toBe(true);
    expect(res.operatorAfter).toBe(153_000);
  });

  it("refuses once the operator-funded share reaches the operator cap", async () => {
    const { reserveBudget, OPERATOR_COST_CAP } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-09-11";

    await getPrismaClient().coachUsage.create({
      data: {
        userId,
        dateKey,
        totalTokens: 1_200_000,
        operatorTokens: OPERATOR_COST_CAP,
        messageCount: 240,
      },
    });

    const res = await reserveBudget(
      userId,
      3_000,
      dateKey,
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.allowed).toBe(false);

    const row = await readRow(userId, dateKey);
    expect(row?.totalTokens).toBe(1_200_000);
    expect(row?.operatorTokens).toBe(OPERATOR_COST_CAP);
  });

  it("refunds both counters when a refused reservation is rolled back", async () => {
    const { reserveBudget, OPERATOR_COST_CAP } =
      await import("@/lib/ai/coach/budget");
    const userId = await seedUser();
    const dateKey = "2026-09-11";

    await getPrismaClient().coachUsage.create({
      data: {
        userId,
        dateKey,
        totalTokens: OPERATOR_COST_CAP,
        operatorTokens: OPERATOR_COST_CAP,
        messageCount: 3,
      },
    });

    const res = await reserveBudget(
      userId,
      1_000,
      dateKey,
      OPERATOR_COST_CAP,
      "operator",
    );
    expect(res.allowed).toBe(false);

    const row = await readRow(userId, dateKey);
    expect(row?.totalTokens).toBe(OPERATOR_COST_CAP);
    expect(row?.operatorTokens).toBe(OPERATOR_COST_CAP);
    expect(row?.messageCount).toBe(3);
  });
});
