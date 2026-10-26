/**
 * v1.4.40 — AI consent receipts.
 *
 *   POST /api/consent/ai
 *     Body: { kind, artefact, signedAt, confirm: true }
 *     Persists a fresh consent receipt. Returns the inserted row.
 *
 *     v1.43.2 — `confirm: true` is required. A receipt records a person's
 *     own consent act, and native builds before it also posted here once per
 *     launch to sync a receipt the account no longer held (re-granting, for
 *     example, a consent the person had withdrawn on the web). Without the
 *     flag nothing is written and the route answers 400
 *     `consent.ai.confirmRequired`; the client reads the standing state from
 *     `ai.consent` on `GET /api/auth/me` instead.
 *
 * Reader + revoke handlers live in `./latest/route.ts`.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkConsentRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  CONSENT_CONFIRM_REQUIRED_ERROR_CODE,
  consentPostBody,
} from "@/lib/validations/consent";
import { createReceipt } from "@/lib/consent/receipts";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  // Per-user ceiling in front of the receipts write. 20/min is well outside
  // any legitimate grant cadence; it caps a scripted loop from filling the
  // audit table.
  const rl = await checkConsentRateLimit(user.id);
  if (!rl.allowed) {
    annotate({
      action: { name: "consent.ai.rate-limited" },
      meta: { userId: user.id, resetAt: rl.resetAt },
    });
    return apiError("Too many consent requests, please wait a moment", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  // v1.4.43 — multi-issue 400 (consent routes use 400 not 422).
  const parsed = await parseJsonBody(request, consentPostBody, {
    maxBytes: 128 * 1024,
    status: 400,
  });
  if (!parsed.ok) return parsed.error;

  const { kind, artefact, signedAt, confirm } = parsed.data;
  if (confirm !== true) {
    // A launch-time sync from an older app build lands here. It is not the
    // person agreeing to anything, so it writes nothing.
    annotate({
      action: { name: "consent.ai.grant.unconfirmed" },
      meta: { kind },
    });
    return apiError(
      "Consent is recorded only from an explicit confirmation",
      400,
      { errorCode: CONSENT_CONFIRM_REQUIRED_ERROR_CODE },
    );
  }
  const receipt = await createReceipt(user.id, kind, artefact, signedAt);

  // Audit trail — separate from the row itself so the legal team can
  // reconstruct "who minted this and when" even if the receipts table
  // is rebuilt from a backup. Fire-and-forget; audit failures must
  // never bubble into a user-facing 500.
  fireAndForget(
    () =>
      auditLog("consent.ai.grant", {
        userId: user.id,
        details: { kind, receiptId: receipt.id },
      }),
    { action: "consent.ai.audit" },
  );

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
