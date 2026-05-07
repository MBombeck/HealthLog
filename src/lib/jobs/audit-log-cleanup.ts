/**
 * Daily cleanup for the `audit_logs` table.
 *
 * V3 audit (GDPR Art. 5(1)(e) "storage limitation"): audit log accumulates
 * IP + city + login events forever. Without retention, a self-hosted
 * deployment is non-compliant with the principle that personal data must
 * not be stored "longer than is necessary".
 *
 * Default retention is 365 days (configurable via AUDIT_LOG_RETENTION_DAYS
 * env). Rows older than the cutoff are deleted in a single bulk
 * `deleteMany`; runs daily via pg-boss.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365;

export function getAuditLogRetentionDays(): number {
  const raw = process.env.AUDIT_LOG_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
  }
  // Refuse very-short retention windows accidentally set to seconds — we
  // don't want a misconfig nuking a fresh audit table.
  if (parsed < 7) return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
  return parsed;
}

export async function cleanupOldAuditLogs(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const days = getAuditLogRetentionDays();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const { count } = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}
