/**
 * Per-user document-vault AI settings.
 *
 * `documentAutoReadEnabled(userId)` reads the `documentsAutoAiRead` opt-in — the
 * single switch that authorises ambient (no-per-document-tap) AI reading of
 * uploaded documents. OFF by default: the vault stays local-first and every
 * external egress needs an explicit per-document action + consent receipt.
 *
 * It is a trigger, not a consent. Switching it on mints an `ai_extraction`
 * receipt, and that receipt is what the document egress re-check reads, so a
 * revoked receipt stops external reading even with the flag still on. Readers:
 *   - the summary job and its catch-up pass run only while it is ON;
 *   - the auto-index-on-upload job stays strictly local when it is OFF and uses
 *     the document-order external pick when it is ON.
 *
 * v1.43 (#1217) — on the `frugal` AI usage level the setting rests: documents
 * are read on request only, whatever the switch says, and the switch acts
 * again as soon as the level allows it. The stored choice is never changed.
 */
import { prisma } from "@/lib/db";
import { AI_CAPABILITIES } from "@/lib/ai/capabilities/types";
import { AI_EXTRACTION_CONSENT_KIND } from "@/lib/consent/receipts";
import { isP2002 } from "@/lib/prisma-errors";
import { loadRecordUsageLevel } from "@/lib/ai/capabilities/usage";
import { AI_USAGE_LEVEL_EFFECTS } from "@/lib/ai/usage-level";

/**
 * True when the user has opted into automatic AI reading of uploaded documents
 * and their AI usage level lets the opt-in act. A missing row (deleted account
 * raced against a job) resolves to `false` — fail-closed to the local-first
 * posture, never to external egress; so does a usage level that cannot be
 * read.
 */
export async function documentAutoReadEnabled(
  userId: string,
): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { documentsAutoAiRead: true },
  });
  if (!(row?.documentsAutoAiRead ?? false)) return false;
  try {
    const level = await loadRecordUsageLevel(userId);
    return AI_USAGE_LEVEL_EFFECTS[level].documentsAutoRead;
  } catch {
    return false;
  }
}

/**
 * Mint the record's extraction receipt unless one that satisfies document
 * reads is already active, as turning automatic reading on does.
 *
 * The switch is an affirmative act, so an earlier revocation does not block
 * it, exactly as a first grant would not be blocked. The partial unique index
 * on active receipts is the backstop for two concurrent flips; losing that
 * race means the other flip already minted, which is the outcome wanted.
 * `grantedBy` says who flipped it: the person themselves, or (#1403) the
 * guardian of a managed profile, who decides for a record with no self.
 * Returns whether a receipt was written.
 */
export async function ensureExtractionReceipt(
  recordId: string,
  grantedBy: "self" | "guardian" = "self",
  now: Date = new Date(),
): Promise<boolean> {
  const active = await prisma.consentReceipt.findFirst({
    where: {
      userId: recordId,
      revokedAt: null,
      kind: { in: [...AI_CAPABILITIES.documentAi.consent.kinds] },
    },
    select: { id: true },
  });
  if (active) return false;
  try {
    await prisma.consentReceipt.create({
      data: {
        userId: recordId,
        kind: AI_EXTRACTION_CONSENT_KIND,
        artefact: JSON.stringify({
          source: "web",
          kind: AI_EXTRACTION_CONSENT_KIND,
          grantedAt: now.toISOString(),
          ...(grantedBy === "guardian" ? { grantedBy: "guardian" } : {}),
          note:
            grantedBy === "guardian"
              ? "Documents read automatically with AI, turned on for a managed profile by its guardian."
              : "Documents read automatically with AI, turned on in the app.",
        }),
        signedAt: now,
      },
    });
    return true;
  } catch (err) {
    if (isP2002(err)) return false;
    throw err;
  }
}
