/**
 * Consent withdrawal: revoking receipts, and deleting the model-written text
 * that the withdrawn consent covered.
 *
 * A revocation stops new AI work at once (every capability reads the active
 * receipts). What it also owes the person is the text already written under
 * that consent. Two kinds of stored text are treated differently:
 *
 *   - Regenerable caches are DELETED, in the same transaction as the revoke,
 *     when the revoke leaves no active receipt covering the analysis
 *     (`ai_insights_only` or `ai_full`): the per-metric status notes, the
 *     cached briefing, model-written period narratives (the deterministic ones
 *     are data and stay), arrival reaction lines (the markers stay), and the
 *     workout paragraphs. Nothing of value is lost; granting consent again
 *     regenerates them.
 *   - The person's own records stay: Coach conversations, facts and plans,
 *     document summaries and extracted text. They are hidden from AI surfaces
 *     while a capability is unavailable, but they remain the person's to read
 *     and delete.
 *
 * Revoke and purge commit together or not at all: a purge that fails leaves
 * the receipt active, so the person sees the withdrawal fail and can retry,
 * rather than a revoked consent with its text still stored.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { DETERMINISTIC_PROVIDER_TYPE } from "@/lib/insights/narrative/period-narrative-deterministic";
import type { ConsentKind } from "@/lib/validations/consent";

import { INSIGHTS_CONSENT_KINDS, type ConsentReceipt } from "./receipts";

/** How many stored items one withdrawal deleted, per surface. */
export interface AiTextPurgeCounts {
  statusNotes: number;
  /** 1 when a cached briefing was cleared, else 0. */
  briefing: number;
  narratives: number;
  reactionLines: number;
  workoutParagraphs: number;
}

export interface ConsentWithdrawal {
  /** The receipts this call revoked, in the order of `kinds`. */
  revoked: Array<{ kind: ConsentKind; receipt: ConsentReceipt }>;
  /** What was deleted, or `null` when the withdrawal left the analysis covered. */
  purged: AiTextPurgeCounts | null;
}

/**
 * Delete the regenerable model-written text for one account, inside `tx`.
 * Exported for the transaction below and its tests; call it through
 * `withdrawConsent`, never on its own.
 */
export async function purgeRegenerableAiText(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<AiTextPurgeCounts> {
  const [statusNotes, briefing, narratives, reactionLines, workoutParagraphs] =
    await Promise.all([
      tx.insightStatusCache.deleteMany({ where: { userId } }),
      tx.user.updateMany({
        where: {
          id: userId,
          OR: [
            { insightsCachedText: { not: null } },
            { insightsCachedAt: { not: null } },
            { insightsSnapshotHash: { not: null } },
          ],
        },
        data: {
          insightsCachedText: null,
          insightsCachedAt: null,
          insightsSnapshotHash: null,
        },
      }),
      tx.insightNarrative.deleteMany({
        where: {
          userId,
          OR: [
            { providerType: null },
            { providerType: { not: DETERMINISTIC_PROVIDER_TYPE } },
          ],
        },
      }),
      // The marker is data (it drives the "just in" chip); only the sentence
      // goes. `generatedAt` stays, so the worker does not write it again.
      tx.arrivalReaction.updateMany({
        where: { userId, lineEncrypted: { not: null } },
        data: { lineEncrypted: null },
      }),
      tx.workoutInsight.deleteMany({ where: { userId } }),
    ]);
  return {
    statusNotes: statusNotes.count,
    briefing: briefing.count,
    narratives: narratives.count,
    reactionLines: reactionLines.count,
    workoutParagraphs: workoutParagraphs.count,
  };
}

/**
 * Revoke the active receipt of each of `kinds`, and purge the regenerable
 * text when that leaves the analysis without a covering receipt. One
 * transaction. The purge runs only when this call revoked a receipt that
 * covered the analysis; revoking the Coach consent alone never deletes a
 * status note.
 */
export async function withdrawConsent(
  userId: string,
  kinds: readonly ConsentKind[],
  now: Date = new Date(),
  purge: typeof purgeRegenerableAiText = purgeRegenerableAiText,
): Promise<ConsentWithdrawal> {
  return prisma.$transaction((tx) =>
    withdrawConsentInTransaction(tx, userId, kinds, now, purge),
  );
}

/**
 * The same withdrawal inside a caller's transaction.
 *
 * v1.42 (#959) — a managed profile's AI consent was given by its Guardian on
 * the person's behalf. When the person claims the profile, every active
 * receipt is withdrawn in the claim's own transaction, so the new owner starts
 * from no consent and gives it themselves, and the text written under the
 * Guardian's consent goes with it exactly as on any other withdrawal.
 */
export async function withdrawConsentInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  kinds: readonly ConsentKind[],
  now: Date = new Date(),
  purge: typeof purgeRegenerableAiText = purgeRegenerableAiText,
): Promise<ConsentWithdrawal> {
  const revoked: ConsentWithdrawal["revoked"] = [];
  for (const kind of kinds) {
    // The partial unique index keeps at most one active row per (user,
    // kind), so one conditional update revokes "the" active receipt; a
    // concurrent revoke finds nothing left to match and writes nothing.
    const updated = await tx.consentReceipt.updateMany({
      where: { userId, kind, revokedAt: null },
      data: { revokedAt: now },
    });
    if (updated.count === 0) continue;
    const receipt = await tx.consentReceipt.findFirst({
      where: { userId, kind, revokedAt: now },
      orderBy: { createdAt: "desc" },
    });
    if (receipt) revoked.push({ kind, receipt });
  }

  const touchedAnalysis = revoked.some(({ kind }) =>
    INSIGHTS_CONSENT_KINDS.includes(kind),
  );
  if (!touchedAnalysis) return { revoked, purged: null };

  const stillCovered = await tx.consentReceipt.count({
    where: {
      userId,
      revokedAt: null,
      kind: { in: [...INSIGHTS_CONSENT_KINDS] },
    },
  });
  if (stillCovered > 0) return { revoked, purged: null };

  return { revoked, purged: await purge(tx, userId) };
}
