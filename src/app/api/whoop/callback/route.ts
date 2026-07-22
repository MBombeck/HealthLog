import { prisma } from "@/lib/db";
import { apiHandler } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import {
  exchangeCode,
  fetchProfile,
  WHOOP_OAUTH_SCOPE,
} from "@/lib/whoop/client";
import { getUserWhoopCredentials } from "@/lib/whoop/credentials";
import { WHOOP_OAUTH_STATE_COOKIE } from "@/lib/whoop/oauth-state";
import { buildReturnSchemeRedirect } from "@/lib/whoop/return-scheme";
import { WHOOP_BACKFILL_QUEUE } from "@/lib/jobs/whoop-backfill";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { markReconnected } from "@/lib/integrations/status";
import { Prisma } from "@/generated/prisma/client";
import { isP2002 } from "@/lib/prisma-errors";
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
    stateRow = await prisma.whoopOAuthState.delete({ where: { nonce: state } });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      annotate({ meta: { reason: "replay" } });
      return WEB_ERR("replay");
    }
    const errName = err instanceof Error ? err.name : "unknown";
    getEvent()?.addWarning(`oauth-state-delete failed: ${errName}`);
    annotate({ meta: { reason: "state" } });
    return WEB_ERR("state");
  }

  // The validated native return scheme (if any) is now known; every redirect
  // below honours it. Identity is the row's userId (bound at connect time from
  // the session or the one-time ticket).
  const returnScheme = stateRow.returnScheme;
  const userId = stateRow.userId;

  const evt = getEvent();
  if (evt) {
    // Identity resolved from the consumed state row (bound at connect time
    // from the session or the one-time ticket); no role is asserted here.
    evt.setAuth({ user_id: userId, auth_method: "session" });
  }

  if (stateRow.expiresAt <= new Date()) {
    annotate({ meta: { reason: "expired" } });
    return outcomeRedirect(returnScheme, "error", "expired");
  }

  // Optional session cross-check: only when a web session cookie is present.
  // The native ticket path carries no session — the nonce cookie + atomic
  // single-use delete already bind the row to its originator.
  const sessionData = await getSession();
  if (sessionData && sessionData.user.id !== userId) {
    annotate({ meta: { reason: "cross_user" } });
    return outcomeRedirect(returnScheme, "error", "cross_user");
  }

  if (!code) {
    return outcomeRedirect(returnScheme, "error", "nocode");
  }

  try {
    const creds = await getUserWhoopCredentials(userId);
    if (!creds) {
      return outcomeRedirect(returnScheme, "error", "nocreds");
    }

    const tokens = await exchangeCode(code, creds);
    const profile = await fetchProfile(tokens.access_token);
    const whoopUserId = String(profile.user_id);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const owner = await prisma.whoopConnection.findUnique({
      where: { whoopUserId },
      select: { userId: true },
    });
    if (owner && owner.userId !== userId) {
      annotate({ meta: { reason: "owner_conflict" } });
      return outcomeRedirect(returnScheme, "error", "owner_conflict");
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
        annotate({ meta: { reason: "owner_conflict" } });
        return outcomeRedirect(returnScheme, "error", "owner_conflict");
      }
      throw err;
    }

    await auditLog("whoop.connect", { userId });

    // Re-completing OAuth clears any prior reauth-required state.
    await markReconnected(userId, "whoop");

    // Enqueue the self-converging history backfill. Best-effort: the boot-time
    // discovery query (`backfillCompletedAt IS NULL`) is the safety net, so a
    // missing boss instance here doesn't strand the connection.
    const boss = getGlobalBoss();
    if (boss) {
      await boss
        .send(WHOOP_BACKFILL_QUEUE, {
          userId,
          enqueuedAt: new Date().toISOString(),
        })
        .catch((err) =>
          getEvent()?.addWarning(`whoop-backfill enqueue failed: ${err}`),
        );
    }

    const response = outcomeRedirect(returnScheme, "connected");
    response.cookies.delete(WHOOP_OAUTH_STATE_COOKIE);
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    return outcomeRedirect(returnScheme, "error", "token");
  }
});
