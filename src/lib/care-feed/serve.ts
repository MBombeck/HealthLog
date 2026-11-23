/**
 * `GET /api/care/feed/<hlf_token>` — the anonymous care calendar fetch.
 *
 * The token in the path is the whole credential: a calendar provider polls
 * from its own servers with no cookie. The pipeline is the cycle feed's
 * (`src/lib/cycle/feed/serve.ts`), in the same order:
 *
 *   1. the anonymous auth-surface limit, before anything is looked up;
 *   2. the token's shape (`hlf_` plus 48 hex), else nothing is looked up;
 *   3. the HMAC lookup of a live (unrevoked) feed;
 *   4. the link's own bucket;
 *   5. the gates, read live on every fetch: the record is not pending
 *      deletion, and the operator's external-access switch is on.
 *
 * Every miss is the same 404 with the same bytes, built by the shared
 * URL-credential answers (`src/lib/http/url-credential.ts`).
 */
import { NextRequest } from "next/server";

import { activeAccount } from "@/lib/account-deletion/active-account";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { guardianMintRefusal } from "@/lib/sharing/guardian-minted";
import { hashToken } from "@/lib/auth/hmac";
import { fetcherFamily } from "@/lib/cycle/feed/fetcher";
import { parseFeedTokenSegment } from "@/lib/cycle/feed/token";
import { renderIcs } from "@/lib/cycle/ics";
import { prisma } from "@/lib/db";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { annotate } from "@/lib/logging/context";
import { runDetached } from "@/lib/logging/detached";
import {
  checkUrlCredentialSurface,
  icsFeedResponse,
  urlCredentialNotFound,
  urlCredentialTooMany,
} from "@/lib/http/url-credential";
import { matchesEtag } from "@/lib/http/etag";
import { MS_PER_HOUR } from "@/lib/time-constants";
import { checkRateLimit } from "@/lib/rate-limit";

import { buildCareFeed } from "./build";

/** Per link; the cycle feed's figure. */
const TOKEN_LIMIT_PER_HOUR = 120;
const UA_MAX_LENGTH = 80;

const NOT_FOUND_ERROR_CODE = "care.feed.notFound";
const RATE_LIMITED_ERROR_CODE = "care.feed.rateLimited";
const notFound = (reason: string) =>
  urlCredentialNotFound(NOT_FOUND_ERROR_CODE, reason);
const tooMany = (snapshot: Parameters<typeof urlCredentialTooMany>[1]) =>
  urlCredentialTooMany(RATE_LIMITED_ERROR_CODE, snapshot);

export async function serveCareFeed(
  request: NextRequest,
  segment: string,
): Promise<Response> {
  annotate({ action: { name: "care.feed.fetch" } });

  const surface = await checkUrlCredentialSurface(request, "care-feed");
  if (!surface.allowed) return tooMany(surface);

  const token = parseFeedTokenSegment(segment);
  if (token === null) return notFound("malformed");

  const tokenHash = hashToken(token);
  const feed = await prisma.careCalendarFeed.findFirst({
    where: { tokenHash, revokedAt: null },
    select: {
      id: true,
      userId: true,
      createdById: true,
      bodyHash: true,
      contentChangedAt: true,
      includeVisits: true,
      includeCheckups: true,
      includeVaccinations: true,
      titleMode: true,
    },
  });
  if (!feed) return notFound("unknown");

  const perToken = await checkRateLimit(
    `care-feed:${tokenHash}`,
    TOKEN_LIMIT_PER_HOUR,
    MS_PER_HOUR,
  );
  if (!perToken.allowed) return tooMany(perToken);

  const [subject, apiOn] = await Promise.all([
    prisma.user.findFirst({
      where: activeAccount({ id: feed.userId }),
      select: { id: true, timezone: true, locale: true },
    }),
    isApiGloballyEnabled(),
  ]);
  if (!subject) return notFound("subject");
  if (!apiOn) return notFound("api_disabled");
  // A guardian's feed rests on their live grant and the profile's marker.
  const refusal = await guardianMintRefusal(feed);
  if (refusal) return notFound(refusal);

  const now = new Date();
  const built = await buildCareFeed(feed, subject, now);
  const changed = built.contentHash !== feed.bodyHash;
  const changedAt = changed ? now : feed.contentChangedAt;
  const etag = `"${built.contentHash}"`;
  const notModified = !changed && matchesEtag(request, etag);

  const ua = request.headers.get("user-agent")?.slice(0, UA_MAX_LENGTH) ?? null;
  trackBackgroundTask(
    runDetached(() =>
      prisma.careCalendarFeed
        .update({
          where: { id: feed.id },
          data: {
            lastFetchedAt: now,
            fetchCount: { increment: 1 },
            ...(ua ? { lastFetcherUa: ua } : {}),
            ...(changed
              ? { bodyHash: built.contentHash, contentChangedAt: changedAt }
              : {}),
          },
        })
        .then(() => undefined)
        .catch(() => {
          // Best-effort statistics; the next fetch writes them again.
        }),
    ),
  );

  annotate({
    meta: {
      status: notModified ? 304 : 200,
      uaFamily: fetcherFamily(ua),
      events: built.calendar.events.length,
    },
  });

  return icsFeedResponse({
    body: notModified ? "" : renderIcs(built.calendar, changedAt),
    etag,
    notModified,
    filename: "healthlog-care.ics",
  });
}
