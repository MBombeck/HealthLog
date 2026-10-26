/**
 * `POST /api/auth/claim/sso` — start claiming a managed profile through
 * single sign-on (v1.43, #959).
 *
 * Anonymous, like the password claim beside it, and ordered like it:
 *
 *   1. refusals that read no token (`claimGate`: no identity provider, a live
 *      session, the per-address bucket the password claim also draws on);
 *   2. the body, strictly parsed, and the link checked;
 *   3. the username probe, so the person learns a name is taken here rather
 *      than after the round trip to the provider.
 *
 * Nothing about the account changes here. The answer is a sealed `hl_claim`
 * cookie (`claim-cookie.ts`) naming the link by its id and carrying the
 * chosen username, and `{ redirectTo }` for the browser to navigate to. The
 * OIDC callback binds the provider's subject to the profile, under the lock,
 * with every check repeated. The token never rides a URL and never reaches the
 * cookie.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  CLAIM_SSO_REDIRECT,
  setClaimCookie,
} from "@/lib/managed-profiles/claim-cookie";
import { claimGate, claimInvalid } from "@/lib/managed-profiles/claim-gate";
import { usableHandoverForToken } from "@/lib/managed-profiles/handover";
import { claimSsoSchema } from "@/lib/validations/claim-sso";

export const POST = apiHandler(async (request: NextRequest) => {
  // Refuses a signed-in caller and rate-limits the address, as the password
  // claim does.
  const gate = await claimGate(request, "sso", (await getSession()) !== null);
  if (gate.refusal) return gate.refusal;

  const parsed = await parseJsonBody(request, claimSsoSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const { token, username } = parsed.data;

  // The link first, so the username probe below is no oracle for anybody
  // without a live link (the password claim's argument).
  const link = await usableHandoverForToken(token);
  if (!link) {
    annotate({
      action: { name: "profile_claim.sso.start" },
      meta: { found: false },
    });
    return claimInvalid();
  }

  const existing = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });
  if (existing) {
    return apiError("Username already taken", 409, {
      errorCode: "profile_claim.taken",
    });
  }

  const response = apiSuccess({ redirectTo: CLAIM_SSO_REDIRECT });
  setClaimCookie(response, { handoverId: link.handoverId, username });

  // Filed under the record, with no actor: nobody is signed in yet. No token,
  // no username — the username is not the person's until the claim lands.
  await auditLog("managed_profile.claim_sso.started", {
    userId: link.profileId,
    actorUserId: null,
    ipAddress: gate.ip,
    details: { handoverId: link.handoverId },
  });
  annotate({
    action: { name: "profile_claim.sso.start" },
    meta: { found: true },
  });
  return response;
});
