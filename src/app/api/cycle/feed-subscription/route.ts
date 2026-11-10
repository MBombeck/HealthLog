/**
 * `/api/cycle/feed-subscription` — the record's calendar subscription
 * (#1350).
 *
 *   GET    → the status: token prefix, options, fetch statistics, and what
 *            the feed serves right now. Never the hash, never the URL.
 *   POST   → turn it on. Mints an `hlf_` token, stores only its HMAC, and
 *            returns the URL exactly once.
 *   PATCH  → change the options.
 *   DELETE → turn it off. The row is revoked, never deleted.
 *
 * A separate namespace from the feed itself (`/api/cycle/feed/<token>`), so
 * neither the path redactor nor the public-path prefix can ever catch it.
 *
 * Auth: cookie session only, through `requireGuardianAuth()`: the record's
 * owner on their own record, or the guardian of a managed profile (a MANAGE
 * grant on a record that carries the managed-profile marker). A delegate on
 * an adult's record is refused at every grant level, MANAGE included: the
 * feed is a standing credential whose contents end up in a third party's
 * calendar cloud, and only the person the data is about, or the guardian of
 * somebody who cannot decide for themselves, may put them there. Turning it
 * on and rotating also need a fresh proof. A guardian's feed is re-checked
 * against the live grant and the marker on every fetch, and a handover claim
 * ends it.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  assertRecentCookieProof,
  requireGuardianAuth,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { auditLog } from "@/lib/auth/audit";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import {
  FEED_MINT_LIMIT_PER_HOUR,
  FEED_MINT_WINDOW_MS,
  cookieOnlyRefusal,
  feedExists,
  feedLinks,
  noLiveFeed,
} from "@/lib/cycle/feed/manage";
import {
  FEED_SUMMARY_SELECT,
  cycleFeedStatus,
  findLiveFeed,
  toFeedSummary,
} from "@/lib/cycle/feed/status";
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
import {
  NEW_FEED_FORECAST_STYLE,
  cycleFeedOptionsPatchSchema,
} from "@/lib/validations/cycle-feed";

export const GET = apiHandler(async () => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "cycle.feed.status" } });

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  return apiSuccess(await cycleFeedStatus(user, gate.profile.goal));
});

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cookieOnlyRefusal();
  const { user, actor } = auth;
  // The proof is the person at the keyboard, so it is the actor's session.
  await assertRecentCookieProof(actor, auth.session.id);
  annotate({ action: { name: "cycle.feed.create" } });

  // The operator's external-access switch covers this credential too.
  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403, {
      errorCode: "cycle.feed.api_disabled",
    });
  }
  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `cycle-feed:mint:${actor.id}`,
    FEED_MINT_LIMIT_PER_HOUR,
    FEED_MINT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many calendar links, try again later", 429, {
      errorCode: "cycle.feed.rateLimited",
    });
  }

  if (await findLiveFeed(user.id)) return feedExists();

  const minted = mintFeedToken();
  let created;
  try {
    created = await prisma.cycleCalendarFeed.create({
      data: {
        userId: user.id,
        createdById: actor.id,
        forecastStyle: NEW_FEED_FORECAST_STYLE,
        tokenHash: minted.hash,
        tokenPrefix: minted.prefix,
      },
      select: FEED_SUMMARY_SELECT,
    });
  } catch (err) {
    // A second mint racing this one lost to the one-live-feed index.
    if (isP2002(err)) return feedExists();
    throw err;
  }

  await auditLog("cycle.feed.create", {
    userId: user.id,
    details: { feedId: created.id, tokenPrefix: created.tokenPrefix },
  });

  return apiSuccess(
    {
      ...feedLinks(resolveOrigin(request), minted.raw),
      feed: toFeedSummary(created),
    },
    201,
  );
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "cycle.feed.update" } });

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, cycleFeedOptionsPatchSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;

  // The fertile window is a conception-goal option and nothing else. Refused
  // here rather than stored and ignored, so a later goal change cannot switch
  // on something the person never chose under that goal.
  if (
    input.includeFertile === true &&
    gate.profile.goal !== "TRYING_TO_CONCEIVE"
  ) {
    return apiError(
      "The fertile window is only offered when trying to conceive",
      422,
      {
        errorCode: "cycle.feed.fertile_goal",
      },
    );
  }

  let live = await findLiveFeed(user.id);
  if (!live) return noLiveFeed();

  const data = {
    ...(input.horizonCycles !== undefined
      ? { horizonCycles: input.horizonCycles }
      : {}),
    ...(input.historyCycles !== undefined
      ? { historyCycles: input.historyCycles }
      : {}),
    ...(input.includeFertile !== undefined
      ? { includeFertile: input.includeFertile }
      : {}),
    ...(input.titleMode !== undefined ? { titleMode: input.titleMode } : {}),
    ...(input.forecastStyle !== undefined
      ? { forecastStyle: input.forecastStyle }
      : {}),
  };
  // Only while the feed is still the live one. A rotation that committed
  // after the read above revoked it and copied its old options onto the new
  // link; the change then goes to that link, once. Updating the revoked row
  // would answer 200 with the old options left in force.
  let written = await prisma.cycleCalendarFeed.updateMany({
    where: { id: live.id, revokedAt: null },
    data,
  });
  if (written.count === 0) {
    live = await findLiveFeed(user.id);
    if (!live) return noLiveFeed();
    written = await prisma.cycleCalendarFeed.updateMany({
      where: { id: live.id, revokedAt: null },
      data,
    });
    if (written.count === 0) return feedExists();
  }
  const updated = await prisma.cycleCalendarFeed.findUniqueOrThrow({
    where: { id: live.id },
    select: FEED_SUMMARY_SELECT,
  });

  await auditLog("cycle.feed.update", {
    userId: user.id,
    details: {
      feedId: live.id,
      ...overwriteDetails({
        before: {
          horizonCycles: live.horizonCycles,
          historyCycles: live.historyCycles,
          includeFertile: live.includeFertile,
          titleMode: live.titleMode,
          forecastStyle: live.forecastStyle,
        },
        after: {
          horizonCycles: updated.horizonCycles,
          historyCycles: updated.historyCycles,
          includeFertile: updated.includeFertile,
          titleMode: updated.titleMode,
          forecastStyle: updated.forecastStyle,
        },
      }),
    },
  });

  return apiSuccess(await cycleFeedStatus(user, gate.profile.goal));
});

export const DELETE = apiHandler(async () => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "cycle.feed.revoke" } });

  const live = await findLiveFeed(user.id);
  if (!live) return noLiveFeed();

  await prisma.cycleCalendarFeed.update({
    where: { id: live.id },
    data: { revokedAt: new Date() },
  });
  // The link stops working on the provider's next poll. What the provider
  // already copied is beyond reach, which the settings card says before the
  // link is ever made.
  await auditLog("cycle.feed.revoke", {
    userId: user.id,
    details: {
      feedId: live.id,
      ...destroyedDetails({
        model: "CycleCalendarFeed",
        id: live.id,
        label: live.tokenPrefix,
        effectiveAt: live.createdAt,
      }),
    },
  });

  return apiSuccess({ revoked: true });
});
