/**
 * Single-use OAuth callbacks for every provider connect flow.
 *
 * A browser can deliver the same callback twice, a few hundred milliseconds
 * apart, with the same `code` and `state`. An authorization code works once
 * (RFC 6749 4.1.2), so the second exchange is refused, and the same section
 * tells the authorization server to revoke what the first exchange issued.
 * Oura does: the connection then fails its first sync with 401 everywhere and
 * asks for a reconnect.
 *
 * The callback therefore claims its `state` before it touches the code. The
 * claim is an insert that skips on conflict, so of any number of concurrent
 * requests exactly one wins and exchanges the code. Every other request is a
 * duplicate: it waits briefly for the winner to finish and sends the browser to
 * the same place, success page or error page, without reading or writing any
 * token. When the winner has not finished in time, the duplicate lands on the
 * integrations page, which shows the connection's real state.
 *
 * Where the claim sits differs by flow:
 *   - signed-state flows (Oura, Polar, Strava) claim right after the signature
 *     check, so only a state this server minted can create a row;
 *   - ledger flows (WHOOP, Withings, Google Health) already consume
 *     their state row with an atomic delete. The claim rides the same
 *     transaction (`consumeLedgerState`), so a duplicate's delete waits on the
 *     row lock, finds the row gone, and then sees the committed claim.
 *
 * A failed exchange settles the claim with its error page. Trying again means
 * starting a new connect, which mints a new state and so a new claim.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { annotate, getEvent } from "@/lib/logging/context";
import { cleanupExpiredOAuthCallbackClaims } from "@/lib/jobs/oauth-callback-claim-cleanup";

/** Providers whose callbacks claim their state here. */
export type OAuthCallbackProvider =
  "oura" | "polar" | "strava" | "whoop" | "withings" | "google-health";

/**
 * How long a claim is kept. Longer than any state lives (10 minutes), so a
 * state that still verifies can never find its claim already swept.
 */
const OAUTH_CALLBACK_CLAIM_TTL_MS = 15 * 60 * 1000;

/** How long a duplicate waits for the winning request to finish. */
const DUPLICATE_WAIT_MS = 10_000;
const DUPLICATE_POLL_MS = 150;

/** Result URLs are short app paths; anything longer is not stored. */
const MAX_LOCATION_LENGTH = 2048;

type ClaimDb = Pick<Prisma.TransactionClient, "oAuthCallbackClaim">;

function claimKey(provider: OAuthCallbackProvider, state: string): string {
  return createHash("sha256").update(`${provider}\0${state}`).digest("hex");
}

/**
 * Claim one callback. True for the one request that may exchange the code,
 * false for every duplicate. `db` lets a ledger flow claim inside the
 * transaction that consumes its state row.
 */
export async function claimOAuthCallback(
  provider: OAuthCallbackProvider,
  state: string,
  db: ClaimDb = prisma,
): Promise<boolean> {
  const { count } = await db.oAuthCallbackClaim.createMany({
    data: [
      {
        key: claimKey(provider, state),
        provider,
        expiresAt: new Date(Date.now() + OAUTH_CALLBACK_CLAIM_TTL_MS),
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}

/**
 * Consume a ledger flow's state row and claim the callback in one
 * transaction. `consume` is the flow's own atomic delete; it throws P2025 for
 * a row already consumed, which aborts the claim with it.
 */
export async function consumeLedgerState<T>(
  provider: OAuthCallbackProvider,
  state: string,
  consume: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const row = await consume(tx);
    await claimOAuthCallback(provider, state, tx);
    return row;
  });
}

/**
 * Run the claimed callback and record where it sent the browser, so a
 * duplicate can follow. A throw is recorded as settled without a result, and
 * re-thrown for the route's own error handling.
 */
export async function settleOAuthCallback(
  provider: OAuthCallbackProvider,
  state: string,
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  let location: string | null = null;
  try {
    const response = await run();
    location = response.headers.get("location");
    return response;
  } finally {
    const now = new Date();
    try {
      await prisma.oAuthCallbackClaim.updateMany({
        where: { key: claimKey(provider, state) },
        data: {
          settledAt: now,
          location:
            location && location.length <= MAX_LOCATION_LENGTH
              ? location
              : null,
        },
      });
      await cleanupExpiredOAuthCallbackClaims(prisma, now);
    } catch (err) {
      getEvent()?.addWarning(`oauth callback claim settle failed: ${err}`);
    }
  }
}

/**
 * Answer a duplicate callback: wait for the claiming request to finish and
 * redirect to the same place, or to `fallbackUrl` when it does not finish in
 * time or finished without a result. Returns null when no claim exists for
 * this state at all, which a ledger flow reads as a genuine replay.
 *
 * Never touches tokens. Clears the state cookie like the winning request does,
 * since the browser may render this response instead of that one.
 */
export async function duplicateOAuthCallback(
  provider: OAuthCallbackProvider,
  state: string,
  opts: {
    fallbackUrl: string;
    stateCookie: string;
    waitMs?: number;
  },
): Promise<NextResponse | null> {
  const key = claimKey(provider, state);
  const deadline = Date.now() + (opts.waitMs ?? DUPLICATE_WAIT_MS);
  let row = await prisma.oAuthCallbackClaim.findUnique({
    where: { key },
    select: { settledAt: true, location: true },
  });
  if (!row) return null;
  while (!row?.settledAt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DUPLICATE_POLL_MS));
    row = await prisma.oAuthCallbackClaim.findUnique({
      where: { key },
      select: { settledAt: true, location: true },
    });
  }
  const settled = Boolean(row?.settledAt);
  annotate({
    meta: {
      reason: "duplicate_callback",
      duplicate_callback_settled: settled,
    },
  });
  const response = NextResponse.redirect(
    settled && row?.location ? row.location : opts.fallbackUrl,
  );
  response.cookies.delete(opts.stateCookie);
  return response;
}

/**
 * The whole single-use step for a flow whose state carries no ledger row:
 * claim, then either run the callback and record its result, or answer as the
 * duplicate.
 */
export async function runOAuthCallbackOnce(
  provider: OAuthCallbackProvider,
  state: string,
  opts: { fallbackUrl: string; stateCookie: string },
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  if (await claimOAuthCallback(provider, state)) {
    return settleOAuthCallback(provider, state, run);
  }
  const duplicate = await duplicateOAuthCallback(provider, state, opts);
  if (duplicate) return duplicate;
  const response = NextResponse.redirect(opts.fallbackUrl);
  response.cookies.delete(opts.stateCookie);
  return response;
}
