/**
 * `GET /api/cycle/feed/<hlf_token>` — the anonymous calendar-feed fetch
 * (#1350).
 *
 * The token in the path is the whole credential. A calendar provider polls it
 * from its own servers with no cookie and no header we could ask for, which is
 * why it is a URL credential at all. Everything it may do is decided here, on
 * every fetch, in this order:
 *
 *   1. The anonymous auth-surface limit, before anything is looked up, so a
 *      prober walking token space pays for every guess (the webhook rule:
 *      limit before verification).
 *   2. The token's shape. Anything that is not `hlf_` plus 48 hex is not
 *      looked up at all.
 *   3. The HMAC lookup of a live (unrevoked) feed.
 *   4. The token's own bucket, so one leaked link cannot grind the engine.
 *   5. The gates, all read live and none of them through a session: the
 *      record and the carrier are not pending deletion, the operator's
 *      external-access switch is on, cycle tracking is available for the
 *      record (user toggle AND operator module switch), and a feed minted by
 *      a delegate still has a live MANAGE grant that covers the cycle section.
 *
 * Every miss is the same 404 with the same bytes: unknown, malformed,
 * revoked, switched off, deleted, or a grant that has lapsed. A prober learns
 * nothing from the difference because there is none.
 */
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import { hashToken } from "@/lib/auth/hmac";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { activeAccount } from "@/lib/account-deletion/active-account";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { runDetached } from "@/lib/logging/detached";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import {
  checkAuthSurfaceRateLimit,
  checkRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import {
  findActiveGrant,
  grantAllows,
  grantCoversDomain,
} from "@/lib/sharing/grant-access";

import { renderIcs } from "../ics";
import { buildCycleFeed, type FeedSubject } from "./build";
import { fetcherFamily } from "./fetcher";
import { parseFeedTokenSegment } from "./token";

/**
 * Per source address, across every feed. Generous because the big calendar
 * providers poll from a pool of addresses that churns; the per-token bucket
 * below is the one that bounds a single link.
 */
const SURFACE_LIMIT_PER_HOUR = 120;
/** Per link. A provider polling every few minutes still fits. */
const TOKEN_LIMIT_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/** The longest User-Agent kept for the status read. */
const UA_MAX_LENGTH = 80;

/** Headers every answer carries, the 404 included. */
function baseHeaders(): Record<string, string> {
  return {
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  };
}

/** One blunt 404 for every miss class. */
function notFound(reason: string): Response {
  annotate({ meta: { feed_miss: reason } });
  const response = apiError("Not found", 404, {
    errorCode: "cycle.feed.notFound",
  });
  for (const [k, v] of Object.entries(baseHeaders()))
    response.headers.set(k, v);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function tooMany(snapshot: Parameters<typeof rateLimitHeaders>[0]): Response {
  const response = apiError("Too many requests. Try again later.", 429, {
    errorCode: "cycle.feed.rateLimited",
  });
  for (const [k, v] of Object.entries({
    ...baseHeaders(),
    ...rateLimitHeaders(snapshot),
  })) {
    response.headers.set(k, v);
  }
  return response;
}

const FEED_SELECT = {
  id: true,
  userId: true,
  createdById: true,
  bodyHash: true,
  contentChangedAt: true,
  horizonCycles: true,
  historyCycles: true,
  includeFertile: true,
  titleMode: true,
} as const;

/**
 * Whether a feed may still be served. Every condition is read on this fetch;
 * nothing is cached on the row, so a revocation of anything the feed rests on
 * lands on the provider's next poll.
 */
async function feedStillAllowed(feed: {
  userId: string;
  createdById: string;
}): Promise<
  { ok: true; subject: FeedSubject } | { ok: false; reason: string }
> {
  const [subject, apiOn, cycleOn] = await Promise.all([
    prisma.user.findFirst({
      where: activeAccount({ id: feed.userId }),
      select: { id: true, timezone: true, locale: true },
    }),
    isApiGloballyEnabled(),
    isCycleAvailableForUser(feed.userId),
  ]);
  if (!subject) return { ok: false, reason: "subject" };
  if (!apiOn) return { ok: false, reason: "api_disabled" };
  if (!cycleOn) return { ok: false, reason: "cycle_disabled" };

  if (feed.createdById !== feed.userId) {
    const [carrier, grant] = await Promise.all([
      prisma.user.findFirst({
        where: activeAccount({ id: feed.createdById }),
        select: { id: true },
      }),
      findActiveGrant({ grantorId: feed.userId, granteeId: feed.createdById }),
    ]);
    if (!carrier) return { ok: false, reason: "carrier" };
    if (!grant || !grantAllows(grant, "manage")) {
      return { ok: false, reason: "grant" };
    }
    if (!grantCoversDomain(grant, "cycle"))
      return { ok: false, reason: "grant" };
  }
  return { ok: true, subject };
}

/** Does the request's `If-None-Match` name this ETag? */
function matchesEtag(request: NextRequest, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((v) => v.trim().replace(/^W\//, ""))
    .some((v) => v === etag || v === "*");
}

export async function serveCycleFeed(
  request: NextRequest,
  segment: string,
): Promise<Response> {
  annotate({ action: { name: "cycle.feed.fetch" } });

  // 1. Before any lookup.
  const surface = await checkAuthSurfaceRateLimit(
    request,
    "cycle-feed",
    SURFACE_LIMIT_PER_HOUR,
    HOUR_MS,
  );
  if (!surface.allowed) return tooMany(surface);

  // 2. Shape.
  const token = parseFeedTokenSegment(segment);
  if (token === null) return notFound("malformed");

  // 3. Lookup of a live feed.
  const tokenHash = hashToken(token);
  const feed = await prisma.cycleCalendarFeed.findFirst({
    where: { tokenHash, revokedAt: null },
    select: FEED_SELECT,
  });
  if (!feed) return notFound("unknown");

  // 4. The link's own bucket.
  const perToken = await checkRateLimit(
    `cycle-feed:${tokenHash}`,
    TOKEN_LIMIT_PER_HOUR,
    HOUR_MS,
  );
  if (!perToken.allowed) return tooMany(perToken);

  // 5. Gates.
  const allowed = await feedStillAllowed(feed);
  if (!allowed.ok) return notFound(allowed.reason);

  // 6. The body, built live.
  const now = new Date();
  const built = await buildCycleFeed(feed, allowed.subject, now);
  const changed = built.contentHash !== feed.bodyHash;
  const changedAt = changed ? now : feed.contentChangedAt;
  const etag = `"${built.contentHash}"`;
  const conditional = request.headers.has("if-none-match");
  const notModified = !changed && matchesEtag(request, etag);

  const ua = request.headers.get("user-agent")?.slice(0, UA_MAX_LENGTH) ?? null;
  trackBackgroundTask(
    runDetached(() =>
      prisma.cycleCalendarFeed
        .update({
          where: { id: feed.id },
          data: {
            lastFetchedAt: now,
            fetchCount: { increment: 1 },
            // A fetch without a User-Agent keeps the last one we know.
            ...(ua ? { lastFetcherUa: ua } : {}),
            ...(changed
              ? { bodyHash: built.contentHash, contentChangedAt: changedAt }
              : {}),
          },
        })
        .then(() => undefined)
        .catch(() => {
          // The statistics are best-effort; a failed write never fails the
          // fetch, and the next fetch writes them again.
        }),
    ),
  );

  annotate({
    meta: {
      status: notModified ? 304 : 200,
      conditional,
      uaFamily: fetcherFamily(ua),
      projection_state: built.projectionState,
      events: built.calendar.events.length,
    },
  });

  const headers: Record<string, string> = {
    ...baseHeaders(),
    // `no-cache`, not `no-store`: a client keeps the body and its validator
    // and asks again with `If-None-Match`, which is what the 304 path is for.
    "Cache-Control": "private, no-cache, max-age=0",
    ETag: etag,
  };
  if (notModified) return new Response(null, { status: 304, headers });
  return new Response(renderIcs(built.calendar, changedAt), {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="healthlog.ics"',
    },
  });
}
