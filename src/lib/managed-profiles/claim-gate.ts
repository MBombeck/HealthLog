/**
 * v1.42 (#959) — the refusals both anonymous claim routes give before they
 * look at a token, in one place so the preview and the claim cannot disagree.
 *
 * Order matters and is the register route's order:
 *
 *   1. A single-sign-on-only instance admits no password, and the claim sets
 *      one, so the handover is refused outright in v1.42.
 *   2. A signed-in caller is refused with 409. Claiming creates a session for
 *      the new owner, and a Guardian testing their own link would otherwise be
 *      signed out of their account and into the person's. Refused before the
 *      rate limit: it is a state, not an attempt, and spending the bucket on it
 *      would lock out the person the link is for, who may share the address.
 *   3. The per-address rate limit, the anonymous auth-surface pattern: a
 *      misconfigured proxy trust chain collapses every caller into one tight
 *      bucket rather than one free-for-all.
 */
import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { isOidcOnly } from "@/lib/auth/oidc";
import { annotate } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

/** The one answer for every unusable link. Not an oracle. */
export function claimInvalid() {
  return apiError("This link is invalid, expired or already used", 404, {
    errorCode: "profile_claim.invalid",
  });
}

export async function claimGate(
  request: Request,
  surface: "preview" | "claim",
  /**
   * Whether the request carries a live session. Resolved by the ROUTE with
   * `getSession()` and handed in, rather than resolved here: a session read
   * inside a `lib/` wrapper would take both routes off the direct
   * session-resolution list in `session-surface-guard.test.ts`, which is
   * exactly the disappearance that guard exists to catch.
   */
  signedIn: boolean,
): Promise<{ refusal: Response } | { refusal: null; ip: string | null }> {
  if (isOidcOnly()) {
    return {
      refusal: apiError(
        "Taking over a profile is not available while this server allows single sign-on only",
        403,
        { errorCode: "profile_claim.oidc_only_unsupported" },
      ),
    };
  }

  if (signedIn) {
    annotate({
      action: { name: `profile_claim.${surface}.refused_authenticated` },
    });
    return {
      refusal: apiError("Already signed in — sign out first", 409, {
        errorCode: "auth.already_authenticated",
      }),
    };
  }

  const rl =
    surface === "preview"
      ? await checkAuthSurfaceRateLimit(
          request,
          "auth:claim-preview",
          20,
          15 * 60 * 1000,
        )
      : await checkAuthSurfaceRateLimit(
          request,
          "auth:claim",
          5,
          15 * 60 * 1000,
        );
  if (!rl.allowed) {
    return {
      refusal: NextResponse.json(
        { data: null, error: "Too many attempts. Please try again later." },
        { status: 429, headers: rateLimitHeaders(rl) },
      ),
    };
  }
  return { refusal: null, ip: rl.ip };
}
