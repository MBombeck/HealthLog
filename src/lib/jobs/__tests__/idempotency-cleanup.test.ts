import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { cleanupExpiredIdempotencyKeys } from "../idempotency-cleanup";

function makePrismaMock(deletedCount: number) {
  return {
    idempotencyKey: {
      deleteMany: vi.fn().mockResolvedValue({ count: deletedCount }),
    },
  } as unknown as PrismaClient;
}

describe("cleanupExpiredIdempotencyKeys", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T03:00:00Z"));
  });

  it("deletes all rows whose expires_at is in the past and returns the count", async () => {
    const prisma = makePrismaMock(100);
    const deleted = await cleanupExpiredIdempotencyKeys(prisma);

    expect(deleted).toBe(100);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date("2026-05-04T03:00:00Z") } },
    });
  });

  it("returns 0 when no rows are expired", async () => {
    const prisma = makePrismaMock(0);
    const deleted = await cleanupExpiredIdempotencyKeys(prisma);
    expect(deleted).toBe(0);
  });

  it("propagates errors from prisma so the handler can warn", async () => {
    const prisma = {
      idempotencyKey: {
        deleteMany: vi.fn().mockRejectedValue(new Error("connection lost")),
      },
    } as unknown as PrismaClient;

    await expect(cleanupExpiredIdempotencyKeys(prisma)).rejects.toThrow(
      "connection lost",
    );
  });
});
