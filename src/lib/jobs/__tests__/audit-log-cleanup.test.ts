import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  cleanupOldAuditLogs,
  getAuditLogRetentionDays,
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
} from "../audit-log-cleanup";
import { PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from "../purge-batch";

function makePrismaMock(deletedCount: number) {
  return {
    auditLog: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          Array.from({ length: deletedCount }, (_, i) => ({ id: `row-${i}` })),
        ),
    },
    // The sweep deletes through the owner's `audit_logs_purge` function.
    $queryRaw: vi.fn().mockResolvedValue([{ count: deletedCount }]),
  } as unknown as PrismaClient;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AUDIT_LOG_RETENTION_DAYS;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("getAuditLogRetentionDays", () => {
  it("returns 365 when env is unset", () => {
    expect(getAuditLogRetentionDays()).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
  });

  it("respects a valid override", () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = "180";
    expect(getAuditLogRetentionDays()).toBe(180);
  });

  it("ignores nonsensical values (NaN, 0, negative)", () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = "0";
    expect(getAuditLogRetentionDays()).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
    process.env.AUDIT_LOG_RETENTION_DAYS = "-100";
    expect(getAuditLogRetentionDays()).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
    process.env.AUDIT_LOG_RETENTION_DAYS = "not a number";
    expect(getAuditLogRetentionDays()).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
  });

  it("rejects too-short retention (< 7 days) to guard misconfigs", () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = "3";
    expect(getAuditLogRetentionDays()).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
  });
});

describe("cleanupOldAuditLogs", () => {
  it("deletes audit log rows older than 365 days by default", async () => {
    const prisma = makePrismaMock(42);
    const now = new Date("2026-05-04T00:00:00Z");
    const outcome = await cleanupOldAuditLogs(prisma, now);

    expect(outcome).toEqual({ deleted: 42, drained: true });
    // The predicate is applied on the bounded lookup; the delete itself is by
    // primary key so no statement is on the hook for the whole backlog.
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    const cutoff = new Date(now.getTime() - 365 * 86_400_000);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ids, cutoffIso] = (prisma.$queryRaw as unknown as Mock).mock
      .calls[0];
    expect((sql as string[]).join("?")).toContain('"audit_logs_purge"(');
    expect(ids).toHaveLength(42);
    expect(cutoffIso).toBe(cutoff.toISOString());
  });

  it("uses the configured retention", async () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = "90";
    const prisma = makePrismaMock(7);
    const now = new Date("2026-05-04T00:00:00Z");
    await cleanupOldAuditLogs(prisma, now);

    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: PURGE_BATCH_SIZE,
    });
  });

  it("stops at the batch cap and says the backlog is not drained", async () => {
    const prisma = makePrismaMock(PURGE_BATCH_SIZE);
    const outcome = await cleanupOldAuditLogs(
      prisma,
      new Date("2026-05-04T00:00:00Z"),
    );

    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(PURGE_MAX_BATCHES);
    expect(outcome.drained).toBe(false);
    expect(outcome.deleted).toBe(PURGE_BATCH_SIZE * PURGE_MAX_BATCHES);
  });
});
