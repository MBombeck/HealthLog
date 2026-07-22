import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { exchangeCode, WITHINGS_OAUTH_SCOPE } from "@/lib/withings/client";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import { WITHINGS_OAUTH_STATE_COOKIE } from "@/lib/withings/oauth-state";
import { setupWebhook } from "@/lib/withings/sync";
import { markReconnected } from "@/lib/integrations/status";
import { Prisma } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * OAuth callback from Withings. Exchanges code for tokens and stores them.
 *
 * v1.4.47 W6 — `state` is now a fully-random 22-character base64url
 * nonce keyed against the `WithingsOAuthState` ledger, rather than the
 * legacy `${user.id}:${random16}` shape. The user identity bound to
 * the in-flight handshake is resolved via the ledger's `userId`
 * column (no longer parsed from the cookie value) and cross-checked
 * against the session — both must agree before the token exchange
 * runs. The row is consumed (deleted) on every exit branch so a
 * replay of the same nonce fails the second time.
 *
 * v1.4.48 M3 — the row is now consumed via a single delete-first
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
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
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
    stateRow = await prisma.withingsOAuthState.delete({
      where: { nonce: state },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      // Row already consumed (replay) or never existed.
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
    // v1.4.49 QA-2 — the warning interpolates `err.name` rather than
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

  // Validity checks against the consumed row. The row is already
  // gone from the ledger by this point — single-use semantics —
  // whether the expiry tripped, the userId mismatched, or
  // everything looked good.
  if (stateRow.expiresAt <= new Date()) {
    annotate({ meta: { reason: "expired" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=expired",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }
  if (stateRow.userId !== user.id) {
    annotate({ meta: { reason: "cross_user" } });
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
    const creds = await getUserWithingsCredentials(user.id);
    if (!creds) {
      return NextResponse.redirect(
        new URL(
          "/settings/integrations?withings=error&reason=nocreds",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
    }

    const tokens = await exchangeCode(code, creds);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const subscriptionRetryAt = new Date();

    // v1.4.25 W5d — persist the OAuth scope we requested. The token
    // response doesn't echo the granted scopes back as a top-level
    // field, but Withings honours the scope param verbatim — there's
    // no scope downgrade unless the user explicitly revokes one in
    // their Health Mate account, which would fail the token exchange
    // entirely. Storing the requested set is therefore a safe
    // representation of what the connection holds.
    await prisma.withingsConnection.upsert({
      where: { userId: user.id },
      update: {
        withingsUserId: tokens.userid,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt: expiresAt,
        scope: WITHINGS_OAUTH_SCOPE,
        webhookSubscriptionState: Prisma.DbNull,
        webhookSubscriptionRetryAt: subscriptionRetryAt,
      },
      create: {
        userId: user.id,
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
    setupWebhook(user.id).catch(() =>
      getEvent()?.addWarning("Webhook setup failed"),
    );

    await auditLog("withings.connect", {
      userId: user.id,
      details: { withingsUserId: tokens.userid },
    });

    // Re-completing OAuth clears any prior `error_reauth` state. We
    // don't write a fresh success-time — that's the next sync's job.
    await markReconnected(user.id, "withings");

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
