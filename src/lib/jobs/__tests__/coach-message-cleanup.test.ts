import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  cleanupOldCoachMessages,
  getCoachMessageRetentionDays,
  DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
} from "../coach-message-cleanup";

/** A table of `rows` old messages; each batch lists and deletes some. */
function makePrismaMock(rows: number) {
  let left = rows;
  return {
    coachMessage: {
      findMany: vi.fn(async ({ take }: { take: number }) =>
        Array.from({ length: Math.min(take, left) }, (_, i) => ({
          id: `m${left - i}`,
        })),
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { id: { in: string[] } } }) => {
          left -= where.id.in.length;
          return { count: where.id.in.length };
        },
      ),
    },
  } as unknown as PrismaClient;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.COACH_MESSAGE_RETENTION_DAYS;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("getCoachMessageRetentionDays", () => {
  it("returns 365 when env is unset", () => {
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
  });

  it("respects a valid override", () => {
    process.env.COACH_MESSAGE_RETENTION_DAYS = "180";
    expect(getCoachMessageRetentionDays()).toBe(180);
  });

  it("ignores nonsensical values (NaN, 0, negative)", () => {
    process.env.COACH_MESSAGE_RETENTION_DAYS = "0";
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
    process.env.COACH_MESSAGE_RETENTION_DAYS = "-100";
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
    process.env.COACH_MESSAGE_RETENTION_DAYS = "not a number";
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
  });

  it("rejects too-short retention (< 30 days) to protect live history", () => {
    process.env.COACH_MESSAGE_RETENTION_DAYS = "7";
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
  });
});

describe("cleanupOldCoachMessages", () => {
  it("deletes coach messages older than 365 days by default", async () => {
    const prisma = makePrismaMock(42);
    const now = new Date("2026-05-04T00:00:00Z");
    const deleted = await cleanupOldCoachMessages(prisma, now);

    expect(deleted).toBe(42);
    const cutoff = new Date(now.getTime() - 365 * 86_400_000);
    expect(prisma.coachMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { createdAt: { lt: cutoff } } }),
    );
  });

  it("uses the configured retention", async () => {
    process.env.COACH_MESSAGE_RETENTION_DAYS = "90";
    const prisma = makePrismaMock(7);
    const now = new Date("2026-05-04T00:00:00Z");
    await cleanupOldCoachMessages(prisma, now);

    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    expect(prisma.coachMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { createdAt: { lt: cutoff } } }),
    );
  });

  it("deletes a backlog larger than one batch in bounded batches", async () => {
    const prisma = makePrismaMock(12_001);
    const deleted = await cleanupOldCoachMessages(
      prisma,
      new Date("2026-05-04T00:00:00Z"),
    );
    expect(deleted).toBe(12_001);
    // 5 000 + 5 000 + 2 001: no statement is asked for more than one batch.
    expect(prisma.coachMessage.deleteMany).toHaveBeenCalledTimes(3);
    for (const [args] of vi.mocked(prisma.coachMessage.deleteMany).mock.calls) {
      expect(
        (args as { where: { id: { in: string[] } } }).where.id.in.length,
      ).toBeLessThanOrEqual(5_000);
    }
  });
});
