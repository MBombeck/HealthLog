import { prisma } from "@/lib/db";
import { ALREADY_LINKED_REASON } from "@/lib/integrations/oauth-kit/account-link";
import { apiHandler } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { verifyCallbackActor } from "@/lib/integrations/oauth-kit/connect-target";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { fetchProfile } from "@/lib/whoop/client";
import { WHOOP_OAUTH_SCOPE, whoopOAuth } from "@/lib/whoop/oauth";
import { getUserWhoopCredentials } from "@/lib/whoop/credentials";
import { WHOOP_OAUTH_STATE_COOKIE } from "@/lib/whoop/oauth-state";
import { buildReturnSchemeRedirect } from "@/lib/whoop/return-scheme";
import { WHOOP_BACKFILL_QUEUE } from "@/lib/jobs/whoop-backfill-queue";
import { enqueueWhenBossReady } from "@/lib/jobs/boss-ready";
import { markReconnected } from "@/lib/integrations/status";
import { Prisma } from "@/generated/prisma/client";
import { isP2002 } from "@/lib/prisma-errors";
import {
  consumeLedgerState,
  duplicateOAuthCallback,
  settleOAuthCallback,
} from "@/lib/oauth/callback-claim";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * OAuth callback from WHOOP (v1.11.0; native enhancements v1.12.2). Mirrors the
 * Withings callback: the `state` param is a random base64url nonce keyed
 * against the `WhoopOAuthState` ledger. The in-flight user is resolved via the
 * row's `userId` (never parsed from the cookie value) — this is the
 * authoritative identity, bound at connect time from either the session or the
 * one-time Bearer connect ticket. The row is consumed (deleted) atomically on
 * every exit branch so a replay of the same nonce fails the second time.
 *
 * Auth model. The state row's `userId` is the source of truth. When a web
 * session cookie is ALSO present (the browser/web-login path) we additionally
 * cross-check it matches the row, so a logged-in user can't complete another
 * user's in-flight handshake. The cookie is OPTIONAL: the native ticket path
 * (v1.12.2) carries no web session, and the nonce-cookie CSRF check + atomic
 * single-use delete already pin the row to the caller who started the flow.
 *
 * Reason tags distinguish the post-delete branches for the audit trail:
 * `csrf1` (URL/cookie mismatch, short-circuit before delete), `replay`
 * (P2025 — nonce already consumed), `expired` (valid row, TTL elapsed), and
 * `cross_user` (valid row, session userId mismatch).
 *
 * v1.12.2 — when the state row carries a validated `returnScheme` (set by the
 * connect route from a native `?return_scheme=`), the FINAL redirect targets
 * `<scheme>://whoop?whoop=connected|error&reason=…` instead of the web settings
 * URL, so `ASWebAuthenticationSession` auto-completes on its custom-scheme
 * match. The pre-resolution CSRF rejections (`csrf1`/`replay`/`state`) have no
 * row yet, so they always use the web redirect.
 *
 * On success: exchange the code, fetch the WHOOP profile for `whoopUserId`,
 * persist the encrypted `WhoopConnection`, clear any prior reauth state, and
 * enqueue the self-converging history backfill.
 *
 * A repeat of a consumed nonce is told apart from a replay by the callback
 * claim taken in the same transaction (`src/lib/oauth/callback-claim.ts`): a
 * browser that delivers the callback twice gets one exchange, and the repeat
 * follows the first request to the same page. Only a nonce with no claim left
 * lands on `replay`.
 */

/** Web-URL redirect (default + every pre-row-resolution path). */
const WEB_ERR = (reason: string) =>
  NextResponse.redirect(
    new URL(
      `/settings/integrations?whoop=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

/**
 * Outcome redirect honouring an optional validated native return scheme.
 * `scheme` null → web URL (unchanged behaviour).
 */
const outcomeRedirect = (
  scheme: string | null,
  outcome: "connected" | "error",
  reason?: string,
) => {
  if (scheme) {
    return NextResponse.redirect(
      buildReturnSchemeRedirect(scheme, outcome, reason),
    );
  }
  return outcome === "error"
    ? WEB_ERR(reason ?? "unknown")
    : NextResponse.redirect(
        new URL(
          "/settings/integrations?whoop=connected",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
};

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "whoop.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get(WHOOP_OAUTH_STATE_COOKIE)?.value;

  // CSRF leg 1: URL state must match the cookie state byte-for-byte
  // (timing-safe). Runs BEFORE the atomic delete so a probe with arbitrary
  // state values can't grief legitimate ledger rows.
  if (
    !state ||
    !storedState ||
    state.length !== storedState.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(storedState))
  ) {
    annotate({ meta: { reason: "csrf1" } });
    return WEB_ERR("csrf1");
  }

  // CSRF leg 2: atomically consume the ledger row. `delete` returns the row
  // on success so the `expiresAt` + `userId` + `returnScheme` checks run
  // against the consumed payload. P2025 means the nonce was already consumed
  // (replay) or never existed. Atomic at the Postgres row level: two
  // concurrent callbacks with the same nonce can't both pass before either
  // deletes.
  let stateRow: {
    userId: string;
    expiresAt: Date;
    returnScheme: string | null;
  } | null = null;
  try {
    stateRow = await consumeLedgerState("whoop", state, (tx) =>
      tx.whoopOAuthState.delete({ where: { nonce: state } }),
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      // A duplicate of a callback that is consuming or has consumed this
      // row: follow that request's result instead of showing an error.
      const duplicate = await duplicateOAuthCallback("whoop", state, {
        fallbackUrl: new URL(
          "/settings/integrations",
          process.env.NEXT_PUBLIC_APP_URL!,
        ).toString(),
        stateCookie: WHOOP_OAUTH_STATE_COOKIE,
      });
      if (duplicate) return duplicate;
      annotate({ meta: { reason: "replay" } });
      return WEB_ERR("replay");
    }
    const errName = err instanceof Error ? err.name : "unknown";
    getEvent()?.addWarning(`oauth-state-delete failed: ${errName}`);
    annotate({ meta: { reason: "state" } });
    return WEB_ERR("state");
  }

  const consumed = stateRow;
  return settleOAuthCallback("whoop", state, async () => {
    // The validated native return scheme (if any) is now known; every redirect
    // below honours it. Identity is the row's userId (bound at connect time from
    // the session or the one-time ticket).
    const returnScheme = consumed.returnScheme;
    const userId = consumed.userId;

    const evt = getEvent();
    if (evt) {
      // Identity resolved from the consumed state row (bound at connect time
      // from the session or the one-time ticket); no role is asserted here.
      evt.setAuth({ user_id: userId, auth_method: "session" });
    }

    if (consumed.expiresAt <= new Date()) {
      annotate({ meta: { reason: "expired" } });
      return outcomeRedirect(returnScheme, "error", "expired");
    }

    // Optional session cross-check: only when a web session cookie is present.
    // The native ticket path carries no session — the nonce cookie + atomic
    // single-use delete already bind the row to its originator.
    // A guardian finishing a managed profile's connect needs a live MANAGE
    // grant on it; a managed profile has no session of its own.
    const sessionData = await getSession();
    const actorCheck = await verifyCallbackActor(
      userId,
      sessionData?.user.id ?? null,
    );
    if (!actorCheck.ok) {
      annotate({ meta: { reason: actorCheck.reason } });
      return outcomeRedirect(returnScheme, "error", "cross_user");
    }
    const guardianUserId = actorCheck.guardianUserId;

    if (!code) {
      return outcomeRedirect(returnScheme, "error", "nocode");
    }

    try {
      const creds = await getUserWhoopCredentials(userId);
      if (!creds) {
        return outcomeRedirect(returnScheme, "error", "nocreds");
      }

      const tokens = await whoopOAuth.exchange(code, creds);
      const profile = await fetchProfile(tokens.access_token);
      // An off-spec profile without `user_id` would store the string
      // "undefined" as the account id: every such connection would then look
      // like one WHOOP account, and the check below would refuse the second.
      if (
        typeof profile.user_id !== "number" ||
        !Number.isFinite(profile.user_id)
      ) {
        return outcomeRedirect(returnScheme, "error", "token");
      }
      const whoopUserId = String(profile.user_id);
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
      const owner = await prisma.whoopConnection.findUnique({
        where: { whoopUserId },
        select: { userId: true },
      });
      if (owner && owner.userId !== userId) {
        annotate({ meta: { reason: ALREADY_LINKED_REASON } });
        return outcomeRedirect(returnScheme, "error", ALREADY_LINKED_REASON);
      }

      try {
        await prisma.whoopConnection.upsert({
          where: { userId },
          update: {
            whoopUserId,
            accessToken: encrypt(tokens.access_token),
            refreshToken: encrypt(tokens.refresh_token),
            tokenExpiresAt: expiresAt,
            scope: tokens.scope ?? WHOOP_OAUTH_SCOPE,
            backfillCompletedAt: null,
          },
          create: {
            userId,
            whoopUserId,
            accessToken: encrypt(tokens.access_token),
            refreshToken: encrypt(tokens.refresh_token),
            tokenExpiresAt: expiresAt,
            scope: tokens.scope ?? WHOOP_OAUTH_SCOPE,
          },
        });
      } catch (err) {
        if (isP2002(err)) {
          annotate({ meta: { reason: ALREADY_LINKED_REASON } });
          return outcomeRedirect(returnScheme, "error", ALREADY_LINKED_REASON);
        }
        throw err;
      }

      await auditLog("whoop.connect", {
        userId,
        actorUserId: guardianUserId,
      });

      // Re-completing OAuth clears any prior reauth-required state.
      await markReconnected(userId, "whoop");

      // Enqueue the self-converging history backfill. Best-effort: the boot-time
      // discovery query (`backfillCompletedAt IS NULL`) is the safety net, so a
      // missing boss instance here doesn't strand the connection.
      await enqueueWhenBossReady("whoop-backfill", async (boss) => {
        await boss
          .send(WHOOP_BACKFILL_QUEUE, {
            userId,
            enqueuedAt: new Date().toISOString(),
          })
          .catch((err) =>
            getEvent()?.addWarning(`whoop-backfill enqueue failed: ${err}`),
          );
      });

      const response = outcomeRedirect(returnScheme, "connected");
      response.cookies.delete(WHOOP_OAUTH_STATE_COOKIE);
      return response;
    } catch (err) {
      getEvent()?.setError(err);
      return outcomeRedirect(returnScheme, "error", "token");
    }
  });
});
