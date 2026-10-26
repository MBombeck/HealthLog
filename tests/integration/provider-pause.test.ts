/**
 * v1.42 — the escalating provider pause, against the real upsert.
 *
 * The pause is computed inside the one `INSERT … ON CONFLICT DO UPDATE` that
 * records a failure, from the count that same statement writes, so two
 * workers failing at once still arm the pause their combined count deserves.
 * Only Postgres can show the CASE arithmetic is right; the unit test can only
 * show the statement carries it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { partitionForBackgroundWork } from "@/lib/ai/background-bench";
import { readServerProviderHealth } from "@/lib/ai/server-provider-health";

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

/**
 * Every instant the ledger stores is read back against the app's clock, so
 * it has to be written with the app's clock too. With the app clock pinned
 * far from the database's, a window written from the database's `NOW()`
 * lands months away from where every reader looks for it.
 */
describe("provider health ledger on the app's clock", () => {
  let userId: string;

  beforeEach(async () => {
    await truncateAllTables(prisma);
    const user = await prisma.user.create({
      data: {
        email: "clock@example.test",
        username: "clock",
        passwordHash: "x",
      },
    });
    userId = user.id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function row() {
    return prisma.providerHealth.findFirstOrThrow({
      where: { userId, providerType: "admin-openai" },
      select: { lastFailureAt: true, lastOkAt: true, nextRetryAt: true },
    });
  }

  it("lifts a backoff five minutes after the failure, on a clock behind the database's", async () => {
    const at = new Date("2020-01-01T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: at });
    for (let i = 0; i < 3; i += 1) {
      await ledger.recordFailure(userId, "admin-openai", 500);
    }
    const stored = await row();
    expect(stored.lastFailureAt?.toISOString()).toBe(at.toISOString());
    expect(stored.nextRetryAt?.getTime()).toBe(
      at.getTime() + HARD_FAILURE_COOLDOWN_MS,
    );
    expect(
      (await ledger.getSkipHints(userId)).get("admin-openai")?.reason,
    ).toBe("backoff");

    vi.setSystemTime(at.getTime() + HARD_FAILURE_COOLDOWN_MS + 1_000);
    expect((await ledger.getSkipHints(userId)).size).toBe(0);
  });

  it("benches background work for the whole pause, on a clock ahead of the database's", async () => {
    const at = new Date("2031-03-01T08:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: at });
    for (let i = 0; i < PROVIDER_PAUSE_THRESHOLD; i += 1) {
      await ledger.recordFailure(userId, "admin-openai", 500);
    }
    const skips = await ledger.getSkipHints(userId);
    const hint = skips.get("admin-openai");
    expect(hint?.reason).toBe("paused");
    expect(hint?.retryAt?.getTime()).toBe(
      at.getTime() + PROVIDER_PAUSE_BASE_MS,
    );
    const { walkable, benched } = partitionForBackgroundWork(
      [{ providerType: "admin-openai" as const }],
      skips,
      () => false,
    );
    expect(walkable).toEqual([]);
    expect(benched.map((b) => b.candidate.providerType)).toEqual([
      "admin-openai",
    ]);

    vi.setSystemTime(at.getTime() + PROVIDER_PAUSE_BASE_MS - 1_000);
    expect((await ledger.getSkipHints(userId)).has("admin-openai")).toBe(true);
  });

  it("stamps a success with the app's instant, so the server health reads it as recent", async () => {
    const at = new Date("2031-03-01T08:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: at });
    await ledger.recordSuccess(userId, "admin-openai");
    expect((await row()).lastOkAt?.toISOString()).toBe(at.toISOString());
    expect(await readServerProviderHealth()).toBe("healthy");
  });
});
