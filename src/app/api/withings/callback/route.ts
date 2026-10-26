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
import { WITHINGS_OAUTH_SCOPE, withingsOAuth } from "@/lib/withings/oauth";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import { WITHINGS_OAUTH_STATE_COOKIE } from "@/lib/withings/oauth-state";
import { setupWebhook } from "@/lib/withings/sync";
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
 * OAuth callback from Withings. Exchanges code for tokens and stores them.
 *
 * v1.4.47 — `state` is now a fully-random 22-character base64url
 * nonce keyed against the `WithingsOAuthState` ledger, rather than the
 * legacy `${user.id}:${random16}` shape. The user identity bound to
 * the in-flight handshake is resolved via the ledger's `userId`
 * column (no longer parsed from the cookie value) and cross-checked
 * against the session — both must agree before the token exchange
 * runs. The row is consumed (deleted) on every exit branch so a
 * replay of the same nonce fails the second time.
 *
 * v1.4.48 — the row is now consumed via a single delete-first
 * round-trip. Prisma `delete` returns the row on success, so the
 * post-delete validity checks (`expiresAt`, `userId`) still run
 * against the consumed payload. Two concurrent callbacks with the
 * same nonce now race at the Postgres row level — only one delete
 * wins, the other hits P2025 ("record not found") and is treated as
 * a replay, bounced to the error page. Previously the `findUnique +
 * separate delete` shape left a tiny RTT window where both legs
 * could pass the lookup before either issued the delete, contrary
 * to the docstring's atomicity promise.
 *
 * Closes the v1.4.43 security audit L-1 finding: the cookie now
 * carries only the opaque nonce, so a future refactor flipping it to
 * non-httpOnly cannot leak the user id into request logs / network
 * captures.
 *
 * A repeat of a consumed nonce is told apart from a replay by the callback
 * claim taken in the same transaction (`src/lib/oauth/callback-claim.ts`): a
 * browser that delivers the callback twice gets one exchange, and the repeat
 * follows the first request to the same page. Only a nonce with no claim left
 * lands on `replay`.
 */
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
  annotate({ action: { name: "withings.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get(WITHINGS_OAUTH_STATE_COOKIE)?.value;

  // CSRF check, leg 1: URL state must match the cookie state byte-for-byte.
  // Timing-safe comparison so a probe can't recover the cookie bytes via
  // response-time analysis. This runs BEFORE the atomic delete so a
  // probe with arbitrary state values can't grief legitimate ledger
  // rows by triggering deletes for nonces it doesn't legitimately
  // hold the cookie for.
  //
  // v1.4.49 — reason tags now distinguish the four post-delete branches
  // so operators reading the audit trail can tell `csrf1` (URL/cookie
  // mismatch, short-circuit before delete), `replay` (P2025 — nonce
  // already consumed), `expired` (valid row but TTL elapsed), and
  // `cross_user` (valid row but session userId mismatch) apart. A
  // matching `meta.reason` Wide-Event annotation carries the same so
  // operators can grep without DB-shell.
  if (
    !state ||
    !storedState ||
    state.length !== storedState.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(storedState))
  ) {
    annotate({ meta: { reason: "csrf1" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=csrf1",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  // CSRF check, leg 2: atomically consume the ledger row. Prisma
  // `delete` returns the row on success so `expiresAt` + `userId`
  // checks still run against the consumed payload. P2025 ("record
  // not found") means the nonce was already consumed by a prior
  // callback (a replay) or never existed — both land on the same
  // error redirect. Atomic at the Postgres row level: two concurrent
  // callbacks with the same nonce can no longer both pass the
  // lookup before either issues the delete.
  let stateRow: { userId: string; expiresAt: Date } | null = null;
  try {
    stateRow = await consumeLedgerState("withings", state, (tx) =>
      tx.withingsOAuthState.delete({ where: { nonce: state } }),
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      // Row already consumed (replay) or never existed.
      // A duplicate of a callback that is consuming or has consumed this
      // row: follow that request's result instead of showing an error.
      const duplicate = await duplicateOAuthCallback("withings", state, {
        fallbackUrl: new URL(
          "/settings/integrations",
          process.env.NEXT_PUBLIC_APP_URL!,
        ).toString(),
        stateCookie: WITHINGS_OAUTH_STATE_COOKIE,
      });
      if (duplicate) return duplicate;
      annotate({ meta: { reason: "replay" } });
      return NextResponse.redirect(
        new URL(
          "/settings/integrations?withings=error&reason=replay",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
    }
    // A real infra problem (connection drop, integrity violation)
    // shouldn't be silently swallowed. Surface it to the Wide Event
    // so the audit trail captures it, then bounce to the error
    // page. Re-throwing would land on the apiHandler's 500 path and
    // strand the user without a clean redirect.
    //
    // v1.4.49 — the warning interpolates `err.name` rather than
    // `${err}` so a Prisma error message echoing the offending value
    // (e.g. the raw nonce) into the wide-event log cannot leak it.
    const errName = err instanceof Error ? err.name : "unknown";
    getEvent()?.addWarning(`oauth-state-delete failed: ${errName}`);
    annotate({ meta: { reason: "state" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=state",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  const consumed = stateRow;
  return settleOAuthCallback("withings", state, async () => {
    // Validity checks against the consumed row. The row is already
    // gone from the ledger by this point — single-use semantics —
    // whether the expiry tripped, the userId mismatched, or
    // everything looked good.
    if (consumed.expiresAt <= new Date()) {
      annotate({ meta: { reason: "expired" } });
      return NextResponse.redirect(
        new URL(
          "/settings/integrations?withings=error&reason=expired",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
    }
    // The record the connect started for; a guardian may finish it for a
    // managed profile it holds a live MANAGE grant on.
    const recordUserId = consumed.userId;
    const actorCheck = await verifyCallbackActor(recordUserId, actor.id);
    if (!actorCheck.ok) {
      annotate({ meta: { reason: actorCheck.reason } });
      return NextResponse.redirect(
        new URL(
          "/settings/integrations?withings=error&reason=cross_user",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
    }

    if (!code) {
      return NextResponse.redirect(
        new URL(
          "/settings/integrations?withings=error&reason=nocode",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
    }

    try {
      const creds = await getUserWithingsCredentials(recordUserId);
      if (!creds) {
        return NextResponse.redirect(
          new URL(
            "/settings/integrations?withings=error&reason=nocreds",
            process.env.NEXT_PUBLIC_APP_URL!,
          ),
        );
      }

      const tokens = await withingsOAuth.exchange(code, creds);

      // One Withings account, one record. A guardian signed in to their own
      // Health Mate account must not attach it to the profile they manage:
      // its webhooks would route to one of the two rows, and a disconnect on
      // either would unsubscribe the other.
      if (
        await accountLinkedElsewhere(
          "withings",
          String(tokens.userid),
          recordUserId,
        )
      ) {
        annotate({ meta: { reason: ALREADY_LINKED_REASON } });
        return NextResponse.redirect(
          new URL(
            `/settings/integrations?withings=error&reason=${ALREADY_LINKED_REASON}`,
            process.env.NEXT_PUBLIC_APP_URL!,
          ),
        );
      }

      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
      const subscriptionRetryAt = new Date();

      // v1.4.25 — persist the OAuth scope we requested. The token
      // response doesn't echo the granted scopes back as a top-level
      // field, but Withings honours the scope param verbatim — there's
      // no scope downgrade unless the user explicitly revokes one in
      // their Health Mate account, which would fail the token exchange
      // entirely. Storing the requested set is therefore a safe
      // representation of what the connection holds.
      await prisma.withingsConnection.upsert({
        where: { userId: recordUserId },
        update: {
          withingsUserId: tokens.userid,
          accessToken: encrypt(tokens.access_token),
          refreshToken: encrypt(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          scope: WITHINGS_OAUTH_SCOPE,
          webhookSubscriptionState: Prisma.DbNull,
          webhookSubscriptionRetryAt: subscriptionRetryAt,
          // A reconnect may come with another developer app (another plan), so
          // what the old grant's plan refused is asked for again.
          apiPlanState: Prisma.DbNull,
          // A reconnect may be another account or device, so nights it gave
          // up on are tried again.
          sleepStageReads: Prisma.DbNull,
        },
        create: {
          userId: recordUserId,
          withingsUserId: tokens.userid,
          accessToken: encrypt(tokens.access_token),
          refreshToken: encrypt(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          scope: WITHINGS_OAUTH_SCOPE,
          webhookSubscriptionState: Prisma.DbNull,
          webhookSubscriptionRetryAt: subscriptionRetryAt,
        },
      });

      // Reconcile every category from a clean state after connect/reconnect.
      setupWebhook(recordUserId).catch(() =>
        getEvent()?.addWarning("Webhook setup failed"),
      );

      await auditLog("withings.connect", {
        userId: recordUserId,
        actorUserId: actorCheck.guardianUserId,
        details: { withingsUserId: tokens.userid },
      });

      // Re-completing OAuth clears any prior `error_reauth` state. We
      // don't write a fresh success-time — that's the next sync's job.
      await markReconnected(recordUserId, "withings");

      const response = NextResponse.redirect(
        new URL(
          "/settings/integrations?withings=connected",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
      response.cookies.delete(WITHINGS_OAUTH_STATE_COOKIE);
      return response;
    } catch {
      getEvent()?.setError(new Error("Withings callback failed"));
      return NextResponse.redirect(
        new URL(
          "/settings/integrations?withings=error&reason=token",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
    }
  });
});
