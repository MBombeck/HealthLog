/**
 * v1.42 — the escalating provider pause, against the real upsert.
 *
 * The pause is computed inside the one `INSERT … ON CONFLICT DO UPDATE` that
 * records a failure, from the count that same statement writes, so two
 * workers failing at once still arm the pause their combined count deserves.
 * Only Postgres can show the CASE arithmetic is right; the unit test can only
 * show the statement carries it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import {
  HARD_FAILURE_COOLDOWN_MS,
  PROVIDER_PAUSE_BASE_MS,
  PROVIDER_PAUSE_THRESHOLD,
  postgresProviderHealthLedger as ledger,
} from "@/lib/ai/provider-health-ledger";

const prisma = getPrismaClient();

async function windowMs(userId: string): Promise<number> {
  const row = await prisma.providerHealth.findFirstOrThrow({
    where: { userId, providerType: "admin-openai" },
    select: { nextRetryAt: true, lastFailureAt: true },
  });
  return row.nextRetryAt!.getTime() - row.lastFailureAt!.getTime();
}

describe("provider pause in the Postgres ledger", () => {
  let userId: string;

  beforeEach(async () => {
    await truncateAllTables(prisma);
    const user = await prisma.user.create({
      data: {
        email: "pause@example.test",
        username: "pause",
        passwordHash: "x",
      },
    });
    userId = user.id;
  });

  it("backs off briefly, then pauses from the threshold, doubling, and a success resumes", async () => {
    for (let i = 1; i < PROVIDER_PAUSE_THRESHOLD; i += 1) {
      await ledger.recordFailure(userId, "admin-openai", 500);
    }
    expect(await windowMs(userId)).toBe(HARD_FAILURE_COOLDOWN_MS);
    expect(
      (await ledger.getSkipHints(userId)).get("admin-openai")?.reason,
    ).toBe("backoff");

    await ledger.recordFailure(userId, "admin-openai", 500);
    expect(await windowMs(userId)).toBe(PROVIDER_PAUSE_BASE_MS);
    expect(
      (await ledger.getSkipHints(userId)).get("admin-openai")?.reason,
    ).toBe("paused");

    await ledger.recordFailure(userId, "admin-openai", 500);
    expect(await windowMs(userId)).toBe(2 * PROVIDER_PAUSE_BASE_MS);

    await ledger.recordSuccess(userId, "admin-openai");
    expect((await ledger.getSkipHints(userId)).has("admin-openai")).toBe(false);
  });

  it("keeps the fixed cooldown for a dead credential, however long the run", async () => {
    for (let i = 0; i < PROVIDER_PAUSE_THRESHOLD + 2; i += 1) {
      await ledger.recordFailure(userId, "admin-openai", 401);
    }
    expect(
      (await ledger.getSkipHints(userId)).get("admin-openai")?.reason,
    ).toBe("credential_expired");
  });
});
