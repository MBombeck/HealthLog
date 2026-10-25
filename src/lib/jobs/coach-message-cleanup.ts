/**
 * Daily cleanup for the `coach_messages` table.
 *
 * v1.18.7 retention (GDPR Art. 5(1)(e) "storage limitation"): the Coach
 * persists every turn's prose as an encrypted `encryptedContent` Bytes
 * column. The table is append-only and grows forever — a daily Coach user
 * accrues rows indefinitely with no lifecycle. The conversation history is
 * useful context, but stale beyond a year it is dead weight inflating the
 * table and the `(conversation_id, created_at)` indexes.
 *
 * Default retention is 365 days (configurable via COACH_MESSAGE_RETENTION_DAYS
 * env). Rows older than the cutoff are deleted in a single bulk `deleteMany`;
 * runs daily via pg-boss. The DELETE is keyed on `created_at` directly — the
 * pre-existing `(conversation_id, created_at)` index is not a perfect cover
 * for an unqualified `created_at` scan, but the trailing-edge delete touches
 * only the oldest sliver of the table.
 *
 * The retention floor is 30 days: a misconfigured tiny value never nukes
 * recent, in-context conversation history. Content stays encrypted at rest
 * until the moment it is hard-deleted; there is no plaintext path.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export const DEFAULT_COACH_MESSAGE_RETENTION_DAYS = 365;

export function getCoachMessageRetentionDays(): number {
  const raw = process.env.COACH_MESSAGE_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_COACH_MESSAGE_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_COACH_MESSAGE_RETENTION_DAYS;
  }
  // Refuse a too-short retention window. Coach history is in-context for the
  // proactive nudge frequency gate and the conversation rail; 30 days is the
  // safe floor so a misconfig measured in seconds cannot prune live history.
  if (parsed < 30) return DEFAULT_COACH_MESSAGE_RETENTION_DAYS;
  return parsed;
}

export async function cleanupOldCoachMessages(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const days = getCoachMessageRetentionDays();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  // account-deletion: retention ages rows out whatever their account's state; a frozen record keeps no more than an active one.
  const { count } = await prisma.coachMessage.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}
