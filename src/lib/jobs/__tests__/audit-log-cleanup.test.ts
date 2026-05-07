import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  cleanupOldAuditLogs,
  getAuditLogRetentionDays,
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
} from "../audit-log-cleanup";

function makePrismaMock(deletedCount: number) {
  return {
    auditLog: {
      deleteMany: vi.fn().mockResolvedValue({ count: deletedCount }),
    },
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
    const deleted = await cleanupOldAuditLogs(prisma, now);

    expect(deleted).toBe(42);
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledTimes(1);
    const cutoff = new Date(now.getTime() - 365 * 86_400_000);
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    });
  });

  it("uses the configured retention", async () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = "90";
    const prisma = makePrismaMock(7);
    const now = new Date("2026-05-04T00:00:00Z");
    await cleanupOldAuditLogs(prisma, now);

    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    });
  });
});
