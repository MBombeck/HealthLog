import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { verifyCallbackActor } from "@/lib/integrations/oauth-kit/connect-target";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { fetchOuraAccountId } from "@/lib/oura/client";
import { exchangeOuraCode, isAcceptedOuraIssuer } from "@/lib/oura/oauth";
import {
  ALREADY_LINKED_REASON,
  accountLinkedElsewhere,
} from "@/lib/integrations/oauth-kit/account-link";
import { getOuraClientCredentials } from "@/lib/oura/credentials";
import {
  oauthStateCookieName,
  stateMatchesCookie,
  verifySignedState,
} from "@/lib/oauth/signed-state";
import { runOAuthCallbackOnce } from "@/lib/oauth/callback-claim";
import { ouraCollectionsMissingFromGrant } from "@/lib/oura/scope";
import { markReconnected } from "@/lib/integrations/status";
import { OURA_SYNC_QUEUE } from "@/lib/jobs/integration-poll-queues";
import { enqueueWhenBossReady } from "@/lib/jobs/boss-ready";
import { integrationBackfillSourceOptions } from "@/lib/jobs/integration-backfill-admission";
import { type OuraBackfillPayload } from "@/lib/jobs/oura-backfill";
import { OURA_BACKFILL_QUEUE } from "@/lib/jobs/oura-backfill-queue";
import { NextRequest, NextResponse } from "next/server";

/**
 * v1.17.0 — OAuth callback from Oura.
 *
 * Identity + CSRF mirror the Polar callback: the `state` param is a stateless
 * HMAC-signed token, enforced as a byte-exact double-submit against the
 * httpOnly cookie AND verified for signature / expiry / `oura` provider
 * binding. The `userId` is read from inside the verified token, cross-checked
 * against the web session when present.
 *
 * The callback is single-use: the verified state is claimed before anything
 * else (`src/lib/oauth/callback-claim.ts`). A browser that delivers it twice
 * gets one exchange; the duplicate is sent where the first request went and
 * never touches the code, because Oura revokes the first exchange's token
 * when it sees the code reused.
 *
 * On success: exchange the code, persist the encrypted access + refresh token
 * on `User`, note the collections the granted scopes leave out, clear any
 * prior reauth state, and redirect back to Settings.
 */
const SETTINGS_URL = () =>
  new URL(
    "/settings/integrations",
    process.env.NEXT_PUBLIC_APP_URL!,
  ).toString();

const ERR = (reason: string) =>
  NextResponse.redirect(
    new URL(
      `/settings/integrations?oura=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "oura.callback" } });

  const state = new URL(request.url).searchParams.get("state");
  const cookieState = request.cookies.get(oauthStateCookieName("oura"))?.value;

  if (!stateMatchesCookie(state, cookieState)) {
    annotate({ meta: { reason: "csrf1" } });
    return ERR("csrf1");
  }

  const verified = verifySignedState("oura", state);
  if (!verified) {
    annotate({ meta: { reason: "state" } });
    return ERR("state");
  }
  const userId = verified.userId;

  // Everything that can refuse the callback without the code runs before
  // the claim, so a refused callback (a denied consent arrives without a
  // code) never spends the state: the same authorize URL still works. The
  // claim stays strictly before the exchange.
  const params = new URL(request.url).searchParams;
  const code = params.get("code");

  const evt = getEvent();
  if (evt) evt.setAuth({ user_id: userId, auth_method: "session" });

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

  // RFC 9207: an authorization server that names itself must be Oura's. The
  // issuer also tells which token endpoint the code belongs to. Older apps
  // send none, which is fine.
  const iss = params.get("iss");
  if (!isAcceptedOuraIssuer(iss)) {
    annotate({ meta: { reason: "issuer" } });
    return ERR("issuer");
  }

  return runOAuthCallbackOnce(
    "oura",
    state,
    {
      fallbackUrl: SETTINGS_URL(),
      stateCookie: oauthStateCookieName("oura"),
    },
    () => completeCallback(userId, guardianUserId, code, iss),
  );
});

async function completeCallback(
  userId: string,
  guardianUserId: string | null,
  code: string,
  iss: string | null,
): Promise<NextResponse> {
  try {
    const creds = await getOuraClientCredentials(userId);
    if (!creds) return ERR("nocreds");

    const tokens = await exchangeOuraCode(code, creds, iss);

    // One Oura account, one record: a guardian signed in to their own Oura
    // account must not attach it to the profile they manage.
    const ouraUserId = await fetchOuraAccountId(tokens.access_token);
    if (await accountLinkedElsewhere("oura", ouraUserId, userId)) {
      annotate({ meta: { reason: ALREADY_LINKED_REASON } });
      return ERR(ALREADY_LINKED_REASON);
    }

    // The token response names the granted scopes when Oura sends them; a
    // permission the person unticked on the consent screen is known from it
    // at once. Without them, the first sync finds out per collection.
    const missing = ouraCollectionsMissingFromGrant(tokens.scope);
    if (missing && missing.length > 0) {
      annotate({ meta: { oura_scope_denied: missing } });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        ouraAccessTokenEncrypted: encrypt(tokens.access_token),
        ouraRefreshTokenEncrypted: encrypt(tokens.refresh_token),
        ouraUserId,
        ouraScopeDenied:
          missing && missing.length > 0 ? missing : Prisma.DbNull,
        // Open the history backfill again: a first connect has none yet,
        // and a reconnect may grant what the old grant refused. What was
        // already walked stays in the progress note and is not read again.
        ouraBackfillCompletedAt: null,
      },
    });

    await auditLog("oura.connect", {
      userId,
      actorUserId: guardianUserId,
    });
    await markReconnected(userId, "oura");

    // Start the first sync now instead of leaving the user staring at an empty
    // card until the next hourly tick. The poll handler has accepted a
    // single-user payload since it was written; this is the producer that was
    // missing. Reconnects ride the same path. Best-effort by design: the hourly
    // cron remains the safety net, so a missing boss instance must never strand
    // the redirect.
    await enqueueWhenBossReady("oura-connect", async (boss) => {
      await boss
        .send(OURA_SYNC_QUEUE, { userId })
        .catch((err) =>
          getEvent()?.addWarning(`oura-sync connect enqueue failed: ${err}`),
        );
      const backfill: OuraBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      await boss
        .send(
          OURA_BACKFILL_QUEUE,
          backfill,
          integrationBackfillSourceOptions(`oura-backfill|${userId}`),
        )
        .catch((err) =>
          getEvent()?.addWarning(
            `oura-backfill connect enqueue failed: ${err}`,
          ),
        );
    });

    const response = NextResponse.redirect(
      new URL(
        "/settings/integrations?oura=connected",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
    response.cookies.delete(oauthStateCookieName("oura"));
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    return ERR("token");
  }
}
