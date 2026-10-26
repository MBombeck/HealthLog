import { prisma } from "@/lib/db";
import {
  ALREADY_LINKED_REASON,
  accountLinkedElsewhere,
} from "@/lib/integrations/oauth-kit/account-link";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { fetchProfile, resolveFitbitUserId } from "@/lib/fitbit/client";
import { fitbitOAuth } from "@/lib/fitbit/oauth";
import { FITBIT_OAUTH_SCOPE } from "@/lib/fitbit/oauth";
import { getUserFitbitCredentials } from "@/lib/fitbit/credentials";
import { FITBIT_OAUTH_STATE_COOKIE } from "@/lib/fitbit/oauth-state";
import { FITBIT_BACKFILL_QUEUE } from "@/lib/fitbit/jobs/queues";
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
 * OAuth callback from Fitbit (classic Web API, v1.20.0). Mirrors the WHOOP
 * callback: the `state` param is a random base64url nonce keyed against the
 * `FitbitOAuthState` ledger. The in-flight user is resolved via the row's
 * `userId` (never parsed from the cookie value) and cross-checked against the
 * session. The row is consumed (deleted) atomically on every exit branch so a
 * replay of the same nonce fails the second time.
 *
 * Reason tags distinguish the four post-delete branches for the audit trail:
 * `csrf1` (URL/cookie mismatch, short-circuit before delete), `replay` (P2025 —
 * nonce already consumed), `expired` (valid row, TTL elapsed), and `cross_user`
 * (valid row, session userId mismatch).
 *
 * v1.20.0 — the deleted ledger row carries the PKCE `code_verifier` minted at
 * connect; it is presented on the token exchange.
 *
 * On success: exchange the code, fetch the Fitbit profile for the external
 * `fitbitUserId`, persist the encrypted `FitbitConnection`, clear any prior
 * reauth state, and enqueue the self-converging history backfill.
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
      `/settings/integrations?fitbit=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get(FITBIT_OAUTH_STATE_COOKIE)?.value;

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
  // success so the `expiresAt` + `userId` checks run against the consumed
  // payload. P2025 means the nonce was already consumed (replay) or never
  // existed. Atomic at the Postgres row level: two concurrent callbacks with the
  // same nonce can't both pass before either deletes.
  let stateRow: {
    userId: string;
    expiresAt: Date;
    codeVerifier: string | null;
  } | null = null;
  try {
    stateRow = await consumeLedgerState("fitbit", state, (tx) =>
      tx.fitbitOAuthState.delete({ where: { nonce: state } }),
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      // A duplicate of a callback that is consuming or has consumed this
      // row: follow that request's result instead of showing an error.
      const duplicate = await duplicateOAuthCallback("fitbit", state, {
        fallbackUrl: new URL(
          "/settings/integrations",
          process.env.NEXT_PUBLIC_APP_URL!,
        ).toString(),
        stateCookie: FITBIT_OAUTH_STATE_COOKIE,
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
  return settleOAuthCallback("fitbit", state, async () => {
    if (consumed.expiresAt <= new Date()) {
      annotate({ meta: { reason: "expired" } });
      return ERR("expired");
    }
    if (consumed.userId !== user.id) {
      annotate({ meta: { reason: "cross_user" } });
      return ERR("cross_user");
    }

    if (!code) {
      return ERR("nocode");
    }

    // The PKCE verifier minted at connect rides on the ledger row. Its absence
    // means a malformed / legacy handshake — refuse rather than send a code
    // exchange Fitbit will reject for a missing verifier.
    if (!consumed.codeVerifier) {
      annotate({ meta: { reason: "no_verifier" } });
      return ERR("no_verifier");
    }

    try {
      const creds = await getUserFitbitCredentials(user.id);
      if (!creds) {
        return ERR("nocreds");
      }

      const tokens = await fitbitOAuth.exchange(code, creds, {
        codeVerifier: consumed.codeVerifier,
      });

      // The initial code exchange MUST return a refresh token. If Fitbit ever
      // omits it, refuse to persist — a stored empty refresh token silently bricks
      // every future token refresh (the refresh POST then 400s and the connection
      // dies the moment the access token expires). Error out cleanly so the user
      // re-consents rather than landing a dead connection.
      if (!tokens.refresh_token) {
        getEvent()?.addWarning(
          `fitbit callback: token response carried no refresh_token for user ${user.id}`,
        );
        annotate({ meta: { reason: "no_refresh_token" } });
        return ERR("no_refresh_token");
      }

      const profile = await fetchProfile(tokens.access_token);
      const fitbitUserId = resolveFitbitUserId(profile);
      // One Fitbit account, one record.
      if (await accountLinkedElsewhere("fitbit", fitbitUserId, user.id)) {
        annotate({ meta: { reason: ALREADY_LINKED_REASON } });
        return ERR(ALREADY_LINKED_REASON);
      }
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

      await prisma.fitbitConnection.upsert({
        where: { userId: user.id },
        update: {
          fitbitUserId,
          accessToken: encrypt(tokens.access_token),
          refreshToken: encrypt(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          scope: tokens.scope ?? FITBIT_OAUTH_SCOPE,
          backfillCompletedAt: null,
        },
        create: {
          userId: user.id,
          fitbitUserId,
          accessToken: encrypt(tokens.access_token),
          refreshToken: encrypt(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          scope: tokens.scope ?? FITBIT_OAUTH_SCOPE,
        },
      });

      await auditLog("fitbit.connect", {
        userId: user.id,
        details: { fitbitUserId },
      });

      // Re-completing OAuth clears any prior reauth-required state.
      await markReconnected(user.id, "fitbit");

      // Enqueue the self-converging history backfill. Best-effort: the boot-time
      // discovery query (`backfillCompletedAt IS NULL`) is the safety net, so a
      // missing boss instance here doesn't strand the connection.
      await enqueueWhenBossReady("fitbit-backfill", async (boss) => {
        await boss
          .send(FITBIT_BACKFILL_QUEUE, {
            userId: user.id,
            enqueuedAt: new Date().toISOString(),
          })
          .catch((err) =>
            getEvent()?.addWarning(`fitbit-backfill enqueue failed: ${err}`),
          );
      });

      const response = NextResponse.redirect(
        new URL(
          "/settings/integrations?fitbit=connected",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
      response.cookies.delete(FITBIT_OAUTH_STATE_COOKIE);
      return response;
    } catch (err) {
      getEvent()?.setError(err);
      return ERR("token");
    }
  });
});
