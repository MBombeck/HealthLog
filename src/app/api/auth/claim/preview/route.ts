/**
 * `POST /api/auth/claim/preview` — what a handover link would hand over: the
 * profile's display name, the link's expiry and each Guardian's proposed
 * access (v1.42, #959). No health data.
 *
 * Anonymous by design: the person opening the link has no credentials yet.
 * The one-time `hlp_` token travels in the BODY, never in this request's URL,
 * so it never reaches an access log or a wide event's `http.path`. Every
 * unusable link — malformed, unknown, expired, used, withdrawn, a profile no
 * longer managed, a creator who lost access — answers the same 404.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues, safeJson } from "@/lib/api-response";
import { getSession } from "@/lib/auth/session";
import { annotate } from "@/lib/logging/context";
import { claimGate, claimInvalid } from "@/lib/managed-profiles/claim-gate";
import { previewHandover } from "@/lib/managed-profiles/handover";
import { claimPreviewSchema } from "@/lib/validations/managed-profile-handover";

export const POST = apiHandler(async (request: NextRequest) => {
  // Refuses to preview over a live session — see `claimGate`.
  const gate = await claimGate(
    request,
    "preview",
    (await getSession()) !== null,
  );
  if (gate.refusal) return gate.refusal;

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = claimPreviewSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const preview = await previewHandover(parsed.data.token);
  annotate({
    action: { name: "profile_claim.preview" },
    meta: { found: preview !== null },
  });
  if (!preview) return claimInvalid();

  return apiSuccess({
    displayName: preview.displayName,
    expiresAt: preview.expiresAt.toISOString(),
    guardians: preview.guardians,
  });
});
