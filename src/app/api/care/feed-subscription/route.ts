/**
 * `/api/care/feed-subscription` — the record's care calendar subscription.
 *
 *   GET    → the status: token prefix, options, fetch statistics. Never the
 *            hash, never the URL.
 *   POST   → turn it on. Mints an `hlf_` token, stores only its HMAC, and
 *            returns the URL exactly once.
 *   PATCH  → change the options.
 *   DELETE → turn it off. The row is revoked, never deleted.
 *
 * Auth: cookie session only, and always the caller's own record
 * (`requireActorAuth`). A delegate or a guardian acting on someone else's
 * record cannot put that record's dates into a calendar cloud from here.
 * Turning it on needs a fresh proof, like every other standing credential.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  assertRecentCookieProof,
  requireActorAuth,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { auditLog } from "@/lib/auth/audit";
import {
  CARE_FEED_MINT_LIMIT_PER_HOUR,
  CARE_FEED_MINT_WINDOW_MS,
  CARE_FEED_SUMMARY_SELECT,
  careCookieOnlyRefusal,
  careFeedExists,
  careFeedLinks,
  careNoLiveFeed,
  findLiveCareFeed,
  toCareFeedSummary,
} from "@/lib/care-feed/manage";
import { mintFeedToken } from "@/lib/cycle/feed/token";
import { prisma } from "@/lib/db";
import { resolveOrigin } from "@/lib/http/origin";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { careFeedOptionsPatchSchema } from "@/lib/validations/care-feed";

export const GET = apiHandler(async () => {
  const auth = await requireActorAuth();
  if (auth.authMethod !== "cookie") return careCookieOnlyRefusal();
  annotate({ action: { name: "care.feed.status" } });
  const live = await findLiveCareFeed(auth.user.id);
  return apiSuccess({ feed: live ? toCareFeedSummary(live) : null });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireActorAuth();
  if (auth.authMethod !== "cookie") return careCookieOnlyRefusal();
  const { user } = auth;
  await assertRecentCookieProof(user, auth.session.id);
  annotate({ action: { name: "care.feed.create" } });

  // The operator's external-access switch covers this credential too.
  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403, {
      errorCode: "care.feed.api_disabled",
    });
  }

  const rl = await checkRateLimit(
    `care-feed:mint:${user.id}`,
    CARE_FEED_MINT_LIMIT_PER_HOUR,
    CARE_FEED_MINT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many calendar links, try again later", 429, {
      errorCode: "care.feed.rateLimited",
    });
  }

  if (await findLiveCareFeed(user.id)) return careFeedExists();

  const minted = mintFeedToken();
  let created;
  try {
    created = await prisma.careCalendarFeed.create({
      data: {
        userId: user.id,
        tokenHash: minted.hash,
        tokenPrefix: minted.prefix,
      },
      select: CARE_FEED_SUMMARY_SELECT,
    });
  } catch (err) {
    // A second mint racing this one lost to the one-live-feed index.
    if (isP2002(err)) return careFeedExists();
    throw err;
  }

  await auditLog("care.feed.create", {
    userId: user.id,
    details: { feedId: created.id, tokenPrefix: created.tokenPrefix },
  });

  return apiSuccess(
    {
      ...careFeedLinks(resolveOrigin(request), minted.raw),
      feed: toCareFeedSummary(created),
    },
    201,
  );
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const auth = await requireActorAuth();
  if (auth.authMethod !== "cookie") return careCookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "care.feed.update" } });

  const parsed = await parseJsonBody(request, careFeedOptionsPatchSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;

  const live = await findLiveCareFeed(user.id);
  if (!live) return careNoLiveFeed();

  const data = {
    ...(input.includeVisits !== undefined
      ? { includeVisits: input.includeVisits }
      : {}),
    ...(input.includeCheckups !== undefined
      ? { includeCheckups: input.includeCheckups }
      : {}),
    ...(input.includeVaccinations !== undefined
      ? { includeVaccinations: input.includeVaccinations }
      : {}),
    ...(input.titleMode !== undefined ? { titleMode: input.titleMode } : {}),
  };
  // Only while the feed is still the live one: a revoke that committed after
  // the read above must not be answered with 200 and the options in force.
  const written = await prisma.careCalendarFeed.updateMany({
    where: { id: live.id, revokedAt: null },
    data,
  });
  if (written.count === 0) return careNoLiveFeed();
  const updated = await prisma.careCalendarFeed.findUniqueOrThrow({
    where: { id: live.id },
    select: CARE_FEED_SUMMARY_SELECT,
  });

  const options = (row: typeof live) => ({
    includeVisits: row.includeVisits,
    includeCheckups: row.includeCheckups,
    includeVaccinations: row.includeVaccinations,
    titleMode: row.titleMode,
  });
  await auditLog("care.feed.update", {
    userId: user.id,
    details: {
      feedId: live.id,
      ...overwriteDetails({ before: options(live), after: options(updated) }),
    },
  });

  return apiSuccess({ feed: toCareFeedSummary(updated) });
});

export const DELETE = apiHandler(async () => {
  const auth = await requireActorAuth();
  if (auth.authMethod !== "cookie") return careCookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "care.feed.revoke" } });

  const live = await findLiveCareFeed(user.id);
  if (!live) return careNoLiveFeed();

  // Every live feed of the record. The link stops working on the provider's
  // next poll; what it already copied is beyond reach, which the settings
  // card says before the link is ever made.
  const revokedAt = new Date();
  await prisma.careCalendarFeed.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt },
  });
  const revoked = await prisma.careCalendarFeed.findMany({
    where: { userId: user.id, revokedAt },
    select: { id: true, tokenPrefix: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  for (const feed of revoked) {
    await auditLog("care.feed.revoke", {
      userId: user.id,
      details: {
        feedId: feed.id,
        ...destroyedDetails({
          model: "CareCalendarFeed",
          id: feed.id,
          label: feed.tokenPrefix,
          effectiveAt: feed.createdAt,
        }),
      },
    });
  }

  return apiSuccess({ revoked: true });
});
