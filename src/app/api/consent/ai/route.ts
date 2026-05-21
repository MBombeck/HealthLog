/**
 * v1.4.40 SB-10 — AI consent receipts.
 *
 *   POST /api/consent/ai
 *     Body: { kind, artefact, signedAt }
 *     Persists a fresh consent receipt. Returns the inserted row.
 *
 * Reader + revoke handlers live in `./latest/route.ts`.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { consentPostBody } from "@/lib/validations/consent";
import { createReceipt } from "@/lib/consent/receipts";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request);
  if (error) return error;

  const parsed = consentPostBody.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 400);
  }

  const { kind, artefact, signedAt } = parsed.data;
  const receipt = await createReceipt(user.id, kind, artefact, signedAt);

  // Audit trail — separate from the row itself so the legal team can
  // reconstruct "who minted this and when" even if the receipts table
  // is rebuilt from a backup. Fire-and-forget; audit failures must
  // never bubble into a user-facing 500.
  auditLog("consent.ai.grant", {
    userId: user.id,
    details: { kind, receiptId: receipt.id },
  }).catch(() => {});

  annotate({
    action: { name: "consent.ai.grant" },
    meta: { kind, receiptId: receipt.id },
  });

  return apiSuccess({
    id: receipt.id,
    receipt: serialiseReceipt(receipt),
  });
});

interface SerialisedReceipt {
  id: string;
  userId: string;
  kind: string;
  signedAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * Public projection of a `ConsentReceipt`. We deliberately strip
 * `artefact` from the API response — the artefact is large, opaque,
 * and only useful at audit time (read directly from the DB by an
 * operator). Echoing it on every grant would balloon the payload and
 * leak the signed token over network paths it doesn't need to cross.
 */
export function serialiseReceipt(receipt: {
  id: string;
  userId: string;
  kind: string;
  signedAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}): SerialisedReceipt {
  return {
    id: receipt.id,
    userId: receipt.userId,
    kind: receipt.kind,
    signedAt: receipt.signedAt.toISOString(),
    revokedAt: receipt.revokedAt?.toISOString() ?? null,
    createdAt: receipt.createdAt.toISOString(),
  };
}
