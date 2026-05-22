/**
 * Unit coverage for the Withings OAuth state ledger sweep.
 *
 * The cron handler in `reminder-worker.ts` is a thin wrapper around
 * `cleanupExpiredWithingsOAuthStates(p)`; the meaningful contract
 * (deletes rows whose `expiresAt < now`, returns the deleted count,
 * leaves live rows untouched) lives on the helper. These cases pin
 * the contract without going near pg-boss or a real Postgres.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { cleanupExpiredWithingsOAuthStates } from "../withings-oauth-state-cleanup";

function makePrismaMock(deletedCount: number) {
  return {
    withingsOAuthState: {
      deleteMany: vi.fn().mockResolvedValue({ count: deletedCount }),
    },
  } as unknown as PrismaClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cleanupExpiredWithingsOAuthStates", () => {
  it("issues a single `expiresAt < now` deleteMany and returns the deleted count", async () => {
    const prisma = makePrismaMock(7);
    const now = new Date("2026-05-22T03:20:00Z");

    const deleted = await cleanupExpiredWithingsOAuthStates(prisma, now);

    expect(deleted).toBe(7);
    expect(prisma.withingsOAuthState.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.withingsOAuthState.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: now } },
    });
  });

  it("defaults `now` to a fresh wall-clock when the caller omits it", async () => {
    const prisma = makePrismaMock(0);
    const before = Date.now();

    await cleanupExpiredWithingsOAuthStates(prisma);

    const after = Date.now();
    const call = (prisma.withingsOAuthState.deleteMany as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    const cutoff: Date = call.where.expiresAt.lt;

    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after);
  });

  it("returns 0 when no rows match (idempotent re-run)", async () => {
    const prisma = makePrismaMock(0);
    const now = new Date("2026-05-22T03:20:00Z");

    const deleted = await cleanupExpiredWithingsOAuthStates(prisma, now);

    expect(deleted).toBe(0);
    expect(prisma.withingsOAuthState.deleteMany).toHaveBeenCalledOnce();
  });
});
