import { prisma } from "@/lib/db";
import {
  ALREADY_LINKED_REASON,
  accountLinkedElsewhere,
} from "@/lib/integrations/oauth-kit/account-link";
import { apiHandler } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { verifyCallbackActor } from "@/lib/integrations/oauth-kit/connect-target";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { registerUser } from "@/lib/polar/client";
import { polarOAuth } from "@/lib/polar/oauth";
import { getPolarClientCredentials } from "@/lib/polar/credentials";
import {
  oauthStateCookieName,
  stateMatchesCookie,
  verifySignedState,
} from "@/lib/oauth/signed-state";
import { runOAuthCallbackOnce } from "@/lib/oauth/callback-claim";
import { markReconnected } from "@/lib/integrations/status";
import { POLAR_SYNC_QUEUE } from "@/lib/jobs/integration-poll-queues";
import { enqueueWhenBossReady } from "@/lib/jobs/boss-ready";
import { NextRequest, NextResponse } from "next/server";

/**
 * v1.17.0 — OAuth callback from Polar AccessLink.
 *
 * Identity + CSRF: the `state` URL param is a stateless HMAC-signed token. The
 * callback enforces (1) the param equals the httpOnly cookie byte-for-byte
 * (double-submit), and (2) the signature + expiry + `polar` provider binding
 * are valid. The `userId` is read from INSIDE the verified token — tamper-
 * evident — so identity never comes from the ambient session. When a web
 * session cookie is also present we cross-check it matches, so a logged-in user
 * can't complete another user's in-flight handshake.
 *
 * On success: exchange the code (Basic-auth), register the user with the Polar
 * app, persist the encrypted access token + member id on `User`, clear any
 * prior reauth state, and redirect back to Settings.
 */
const ERR = (reason: string) =>
  NextResponse.redirect(
    new URL(
      `/settings/integrations?polar=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "polar.callback" } });

  const state = new URL(request.url).searchParams.get("state");
  const cookieState = request.cookies.get(oauthStateCookieName("polar"))?.value;

  // CSRF double-submit: the URL state must equal the cookie (constant-time).
  if (!stateMatchesCookie(state, cookieState)) {
    annotate({ meta: { reason: "csrf1" } });
    return ERR("csrf1");
  }

  // Verify signature + expiry + provider binding; userId rides inside.
  const verified = verifySignedState("polar", state);
  if (!verified) {
    annotate({ meta: { reason: "state" } });
    return ERR("state");
  }
  const userId = verified.userId;

  // Everything that can refuse the callback without the code runs before
  // the claim, so a refused callback (a denied consent arrives without a
  // code) never spends the state: the same authorize URL still works. The
  // claim stays strictly before the exchange.
  const code = new URL(request.url).searchParams.get("code");

  const evt = getEvent();
  if (evt) evt.setAuth({ user_id: userId, auth_method: "session" });

  // Optional session cross-check when a web session is present.
  // The browser finishing the flow must be the record's own, or, for a
  // managed profile, a guardian's with a live MANAGE grant on it.
  const sessionData = await getSession();
  const actorCheck = await verifyCallbackActor(
    userId,
    sessionData?.user.id ?? null,
  );
  if (!actorCheck.ok) {
    annotate({ meta: { reason: actorCheck.reason } });
    return ERR("cross_user");
  }
  const guardianUserId = actorCheck.guardianUserId;

  if (!code) return ERR("nocode");

  // Single-use: a callback delivered twice exchanges its code once, and the
  // duplicate follows the first request's result (src/lib/oauth/callback-claim.ts).
  return runOAuthCallbackOnce(
    "polar",
    state,
    {
      fallbackUrl: new URL(
        "/settings/integrations",
        process.env.NEXT_PUBLIC_APP_URL!,
      ).toString(),
      stateCookie: oauthStateCookieName("polar"),
    },
    () => completeCallback(userId, guardianUserId, code),
  );
});

async function completeCallback(
  userId: string,
  guardianUserId: string | null,
  code: string,
): Promise<NextResponse> {
  try {
    const creds = await getPolarClientCredentials(userId);
    if (!creds) return ERR("nocreds");

    const tokens = await polarOAuth.exchange(code, creds);
    // Guard against an off-spec token body without `x_user_id`: persisting the
    // string "undefined" as the member id would break every later data read
    // (`/v3/users/undefined/...`) with no clear cause.
    if (
      typeof tokens.x_user_id !== "number" ||
      !Number.isFinite(tokens.x_user_id)
    ) {
      return ERR("token");
    }
    const polarUserId = String(tokens.x_user_id);

    // One Polar member, one record. Checked before the registration so a
    // refused connect registers nothing.
    if (await accountLinkedElsewhere("polar", polarUserId, userId)) {
      annotate({ meta: { reason: ALREADY_LINKED_REASON } });
      return ERR(ALREADY_LINKED_REASON);
    }

    // Register the user with the Polar app (idempotent; 409 = already linked).
    await registerUser(tokens.access_token, polarUserId);

    await prisma.user.update({
      where: { id: userId },
      data: {
        polarAccessTokenEncrypted: encrypt(tokens.access_token),
        // Polar issues no refresh token, so no refresh column is stored.
        polarUserIdEncrypted: encrypt(polarUserId),
      },
    });

    await auditLog("polar.connect", {
      userId,
      actorUserId: guardianUserId,
    });
    await markReconnected(userId, "polar");

    // Start the first sync now instead of leaving the user staring at an empty
    // card until the next hourly tick. Best-effort by design: the hourly cron
    // remains the safety net, so a missing boss instance must never strand the
    // redirect.
    await enqueueWhenBossReady("polar-connect", async (boss) => {
      await boss
        .send(POLAR_SYNC_QUEUE, { userId })
        .catch((err) =>
          getEvent()?.addWarning(`polar-sync connect enqueue failed: ${err}`),
        );
    });

    const response = NextResponse.redirect(
      new URL(
        "/settings/integrations?polar=connected",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
    response.cookies.delete(oauthStateCookieName("polar"));
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    return ERR("token");
  }
}
