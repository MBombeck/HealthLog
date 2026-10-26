/**
 * v1.18.7 — POST /api/c/{token}/unlock — public passphrase gate verifier.
 *
 * The second factor for a passphrase-protected clinician share link. It is an
 * anonymous, no-session surface (like the `/c/<token>` view itself): the raw
 * path token plus the submitted passphrase are the only credentials. On a
 * correct passphrase it mints a SHORT-LIVED, httpOnly, SameSite=Strict, Secure
 * cookie SCOPED to this token's view path so the page renders the record; a
 * cookie minted for one token never unlocks another.
 *
 * Brute-force protection is mandatory here — the passphrase is the only thing
 * standing between a leaked URL and the record — so the route is rate-limited
 * by `share-unlock:<tokenHash>:<ip>` BEFORE any compare, using the
 * anonymous-surface limiter so a broken trust chain collapses to one tight
 * bucket rather than a free-for-all.
 *
 * Failure is blunt: a malformed token, an unknown/revoked/expired link, a link
 * with no passphrase set, or a wrong passphrase all answer the SAME flat error.
 * `no-store` is preserved end to end. Nothing here leaks why a request failed.
 */
import { cookies } from "next/headers";
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { resolveShareGateState } from "@/lib/clinician-share/resolve-share-token";
import { verifyPassphrase } from "@/lib/clinician-share/passphrase";
import {
  mintUnlockValue,
  unlockCookieName,
  UNLOCK_TTL_SECONDS,
} from "@/lib/clinician-share/unlock-cookie";
import { unlockShareLinkSchema } from "@/lib/validations/clinician-share-link";

/** One blunt failure for every class — a probe distinguishes nothing. */
function reject() {
  return apiError("Invalid passphrase", 401);
}

export const POST = apiHandler(
  async (request: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    const { token } = await ctx.params;
    annotate({ action: { name: "share-link.unlock" } });

    // Resolve the live-gate state first (no counter bump). A malformed /
    // unknown / revoked / expired token is `null` → the same blunt reject.
    const gate = await resolveShareGateState(token);

    // Rate-limit BEFORE any compare. Key on the resolved tokenHash when we
    // have one (so the bucket is per-link), else a fixed sentinel so probing
    // unknown tokens still shares one tight bucket. The anonymous-surface
    // limiter collapses a broken trust chain to a single bucket.
    const rlKey = gate ? gate.tokenHash : "unknown";
    const rl = await checkAuthSurfaceRateLimit(
      request,
      `share-unlock:${rlKey}`,
      10,
      10 * 60 * 1000,
    );
    if (!rl.allowed) {
      return apiError("Too many attempts", 429);
    }

    const parsed = await parseJsonBody(request, unlockShareLinkSchema, {
      maxBytes: 4 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    // A token with no live gate, or one carrying no passphrase, cannot be
    // unlocked. `verifyPassphrase` is constant-time and returns false for a
    // null stored hash, so the two branches are indistinguishable in timing.
    if (!gate) return reject();
    if (!verifyPassphrase(parsed.data.passphrase, gate.passphraseHash)) {
      annotate({ meta: { unlock: "rejected" } });
      return reject();
    }

    // Correct passphrase — mint the short-lived, token-scoped unlock cookie.
    const cookieStore = await cookies();
    cookieStore.set(
      unlockCookieName(gate.tokenHash),
      mintUnlockValue(gate.tokenHash),
      {
        httpOnly: true,
        secure: shouldEmitSecureCookie(),
        sameSite: "strict",
        // Scope to THIS token's view path only — the cookie unlocks nothing else.
        path: `/c/${token}`,
        maxAge: UNLOCK_TTL_SECONDS,
      },
    );

    annotate({ meta: { unlock: "granted" } });
    return apiSuccess({ unlocked: true });
  },
);
