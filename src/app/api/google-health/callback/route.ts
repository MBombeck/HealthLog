import { prisma } from "@/lib/db";
import {
  ALREADY_LINKED_REASON,
  accountLinkedElsewhere,
} from "@/lib/integrations/oauth-kit/account-link";
import { apiHandler, AUTH_ERROR_CODES, HttpError } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { verifyCallbackActor } from "@/lib/integrations/oauth-kit/connect-target";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import {
  fetchProfile,
  resolveGoogleHealthUserId,
} from "@/lib/google-health/client";
import { googleHealthOAuth } from "@/lib/google-health/oauth";
import { getGoogleHealthScopeString } from "@/lib/google-health/oauth";
import { getUserGoogleHealthCredentials } from "@/lib/google-health/credentials";
import { GOOGLE_HEALTH_OAUTH_STATE_COOKIE } from "@/lib/google-health/oauth-state";
import { GOOGLE_HEALTH_BACKFILL_QUEUE } from "@/lib/jobs/google-health-backfill-queue";
import { enqueueWhenBossReady } from "@/lib/jobs/boss-ready";
import { markReconnected } from "@/lib/integrations/status";
import { Prisma } from "@/generated/prisma/client";
import {
  consumeLedgerState,
  duplicateOAuthCallback,
  settleOAuthCallback,
} from "@/lib/oauth/callback-claim";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * OAuth callback from Google for the Google Health integration (v1.26.0).
 * Mirrors the Fitbit callback with PKCE: the `state` param is a random
 * base64url nonce keyed against the `GoogleHealthOAuthState` ledger, which also
 * carries the PKCE `code_verifier`. The in-flight user is resolved via the
 * row's `userId` (never parsed from the cookie value) and cross-checked against
 * the session. The row is consumed (deleted) atomically on every exit branch so
 * a replay of the same nonce fails the second time.
 *
 * Reason tags distinguish the post-delete branches for the audit trail:
 * `csrf1` (URL/cookie mismatch, short-circuit before delete), `replay` (P2025 —
 * nonce already consumed), `expired` (valid row, TTL elapsed), and `cross_user`
 * (valid row, session userId mismatch).
 *
 * On success: exchange the code with the stored verifier, fetch the Google
 * Health profile for the external `googleUserId`, persist the encrypted
 * `GoogleHealthConnection`, clear any prior reauth state (`needsReauth:false` +
 * the status ledger), and enqueue the self-converging history backfill.
 *
 * A repeat of a consumed nonce is told apart from a replay by the callback
 * claim taken in the same transaction (`src/lib/oauth/callback-claim.ts`): a
 * browser that delivers the callback twice gets one exchange, and the repeat
 * follows the first request to the same page. Only a nonce with no claim left
 * lands on `replay`.
 */
const ERR = (reason: string) =>
  NextResponse.redirect(
    new URL(
      `/settings/integrations?googleHealth=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

export const GET = apiHandler(async (request: NextRequest) => {
  // The person in the browser, read off the session itself rather than
  // through a record resolver: a provider redirect is a navigation, it cannot
  // carry the record-session header, and the record is the one the state row
  // names, checked against this person below. A session is still required.
  const sessionData = await getSession();
  if (!sessionData) {
    throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);
  }
  const actor = sessionData.user;
  annotate({ action: { name: "google_health.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get(
    GOOGLE_HEALTH_OAUTH_STATE_COOKIE,
  )?.value;

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
    return ERR("csrf1");
  }

  // CSRF leg 2: atomically consume the ledger row. `delete` returns the row on
  // success so the `expiresAt` + `userId` checks (and the PKCE verifier read)
  // run against the consumed payload. P2025 means the nonce was already
  // consumed (replay) or never existed — benign. Atomic at the Postgres row
  // level: two concurrent callbacks with the same nonce can't both pass before
  // either deletes.
  let stateRow: {
    userId: string;
    expiresAt: Date;
    codeVerifier: string | null;
  } | null = null;
  try {
    stateRow = await consumeLedgerState("google-health", state, (tx) =>
      tx.googleHealthOAuthState.delete({ where: { nonce: state } }),
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      // A duplicate of a callback that is consuming or has consumed this
      // row: follow that request's result instead of showing an error.
      const duplicate = await duplicateOAuthCallback("google-health", state, {
        fallbackUrl: new URL(
          "/settings/integrations",
          process.env.NEXT_PUBLIC_APP_URL!,
        ).toString(),
        stateCookie: GOOGLE_HEALTH_OAUTH_STATE_COOKIE,
      });
      if (duplicate) return duplicate;
      annotate({ meta: { reason: "replay" } });
      return ERR("replay");
    }
    const errName = err instanceof Error ? err.name : "unknown";
    getEvent()?.addWarning(`oauth-state-delete failed: ${errName}`);
    annotate({ meta: { reason: "state" } });
    return ERR("state");
  }

  const consumed = stateRow;
  return settleOAuthCallback("google-health", state, async () => {
    if (consumed.expiresAt <= new Date()) {
      annotate({ meta: { reason: "expired" } });
      return ERR("expired");
    }
    // The record the connect started for; a guardian may finish it for a
    // managed profile it holds a live MANAGE grant on.
    const recordUserId = consumed.userId;
    const actorCheck = await verifyCallbackActor(recordUserId, actor.id);
    if (!actorCheck.ok) {
      annotate({ meta: { reason: actorCheck.reason } });
      return ERR("cross_user");
    }
    if (!consumed.codeVerifier) {
      annotate({ meta: { reason: "no_verifier" } });
      return ERR("no_verifier");
    }

    if (!code) {
      return ERR("nocode");
    }

    try {
      const creds = await getUserGoogleHealthCredentials(recordUserId);
      if (!creds) {
        return ERR("nocreds");
      }

      const tokens = await googleHealthOAuth.exchange(code, creds, {
        codeVerifier: consumed.codeVerifier,
      });

      // The exchange must return a refresh token (the connect route forces
      // `prompt=consent` and `access_type=offline`). A stored empty one would
      // fail every later refresh, so the person re-consents instead of landing
      // a connection that dies with its first access token.
      if (!tokens.refresh_token) {
        getEvent()?.addWarning(
          `google-health callback: token response carried no refresh_token for user ${recordUserId}`,
        );
        annotate({ meta: { reason: "no_refresh_token" } });
        return ERR("no_refresh_token");
      }

      const profile = await fetchProfile(tokens.access_token);
      const googleUserId = resolveGoogleHealthUserId(profile);
      // One Google account, one record.
      if (
        await accountLinkedElsewhere(
          "google-health",
          googleUserId,
          recordUserId,
        )
      ) {
        annotate({ meta: { reason: ALREADY_LINKED_REASON } });
        return ERR(ALREADY_LINKED_REASON);
      }
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
      const scope = tokens.scope ?? getGoogleHealthScopeString();

      await prisma.googleHealthConnection.upsert({
        where: { userId: recordUserId },
        update: {
          googleUserId,
          accessToken: encrypt(tokens.access_token),
          refreshToken: encrypt(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          scope,
          // Fresh consent clears the soft-disconnect flag so the card drops the
          // reconnect CTA and the sync path stops short-circuiting.
          needsReauth: false,
          backfillCompletedAt: null,
          // A new grant walks history from the start: what an earlier
          // backfill finished was read under the old one.
          backfillProgress: Prisma.DbNull,
        },
        create: {
          userId: recordUserId,
          googleUserId,
          accessToken: encrypt(tokens.access_token),
          refreshToken: encrypt(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          scope,
          needsReauth: false,
        },
      });

      await auditLog("google_health.connect", {
        userId: recordUserId,
        actorUserId: actorCheck.guardianUserId,
        details: { googleUserId },
      });

      // Re-completing OAuth clears any prior reauth-required state on the status
      // ledger too (the `needsReauth` column above is the connection-local flag;
      // this resets the integration-status streak).
      await markReconnected(recordUserId, "google-health");

      // Enqueue the self-converging history backfill. Best-effort: the boot-time
      // discovery query (`backfillCompletedAt IS NULL`) is the safety net, so a
      // missing boss instance here doesn't strand the connection.
      await enqueueWhenBossReady("google-health-backfill", async (boss) => {
        await boss
          .send(GOOGLE_HEALTH_BACKFILL_QUEUE, {
            userId: recordUserId,
            enqueuedAt: new Date().toISOString(),
          })
          .catch((err) =>
            getEvent()?.addWarning(
              `google-health-backfill enqueue failed: ${err}`,
            ),
          );
      });

      const response = NextResponse.redirect(
        new URL(
          "/settings/integrations?googleHealth=connected",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
      response.cookies.delete(GOOGLE_HEALTH_OAUTH_STATE_COOKIE);
      return response;
    } catch (err) {
      getEvent()?.setError(err);
      return ERR("token");
    }
  });
});
