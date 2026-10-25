/**
 * Web AI-consent grant.
 *
 *   POST /api/consent/ai/web   body `{ "confirm": true }`
 *     Records the person's explicit `ai_full` consent: they pressed "Agree"
 *     on a card that named the provider and the data. Idempotent: an active
 *     `ai_full` receipt makes it a no-op. As the person's own consent act it
 *     may follow an earlier withdrawal.
 *
 *     Without `confirm: true` (no body, `{}`, the pre-v1.43.2 mount heal or
 *     its `{ intent }` body) it mints nothing and answers 400
 *     `consent.ai.confirmRequired`. The settings page used to call this on
 *     every mount and mint a receipt nobody had agreed to; a request that is
 *     not the consent act must never create one.
 *
 * Revocation stays on `DELETE /api/consent/ai/latest`; this route only
 * grants.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, isJsonContentType } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkConsentRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { grantWebAiConsent } from "@/lib/consent/web-grant";
import {
  CONSENT_CONFIRM_REQUIRED_ERROR_CODE,
  webConsentGrantBody,
} from "@/lib/validations/consent";

export const POST = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  // Caps a scripted loop; a person tapping Agree never comes near it.
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

  // Only the explicit grant sends a JSON body. Anything else (no body, an
  // empty object, the retired `{ intent }` shape) is not the consent act.
  let confirmed = false;
  const contentType = req.headers.get("content-type") ?? "";
  if (isJsonContentType(contentType)) {
    const parsed = await parseJsonBody(req, webConsentGrantBody, {
      maxBytes: 1024,
      action: "consent.ai.web-grant.invalid_shape",
    });
    if (!parsed.ok) return parsed.error;
    confirmed = parsed.data.confirm === true;
  }
  if (!confirmed) {
    annotate({ action: { name: "consent.ai.web-grant.unconfirmed" } });
    return apiError(
      "Consent is recorded only from an explicit confirmation",
      400,
      { errorCode: CONSENT_CONFIRM_REQUIRED_ERROR_CODE },
    );
  }

  const result = await grantWebAiConsent(user.id);

  if (result.minted) {
    // Audit trail parity with the native POST /api/consent/ai grant so the
    // web-originated consent can be reconstructed. Fire-and-forget.
    auditLog("consent.ai.grant", {
      userId: user.id,
      details: {
        kind: "ai_full",
        source: "web",
        confirmed: true,
        receiptId: result.receipt.id,
      },
    }).catch(() => {});
  }

  annotate({
    action: { name: "consent.ai.web-grant" },
    meta: {
      minted: result.minted,
      ...(result.minted ? { receiptId: result.receipt.id } : {}),
    },
  });

  return apiSuccess({
    minted: result.minted,
    kind: "ai_full" as const,
  });
});
