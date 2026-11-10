/**
 * `POST /api/cycle/feed-subscription/rotate` — a new link for the record's
 * calendar subscription (#1350).
 *
 * One transaction: the live feed is revoked and its successor minted with the
 * same options, so there is never a moment with two live links or with none.
 * The forecast style is copied too: a feed minted before that option keeps
 * BAND rather than taking a new feed's default.
 * Calendars holding the old link stop updating on their next poll. The new
 * URL is returned exactly once. Of two rotations racing, the second finds
 * the feed already revoked (or its successor meets the one-live-feed index)
 * and gets the mint path's 409 `cycle.feed.exists`; the winner's link
 * stands. A subscription turned off during a rotation stays off, whichever
 * commits first, and the rotation then answers 404 `cycle.feed.none`; an
 * option changed during one lands on the link that stays live.
 *
 * Same gates as turning the subscription on: cookie session only, the owner or
 * the guardian of a managed profile (`requireGuardianAuth`), a fresh proof,
 * the operator's external-access switch, and the per-actor mint bucket.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  assertRecentCookieProof,
  requireGuardianAuth,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
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
  findLiveFeed,
  toFeedSummary,
} from "@/lib/cycle/feed/status";
import { mintFeedToken } from "@/lib/cycle/feed/token";
import { prisma } from "@/lib/db";
import { resolveOrigin } from "@/lib/http/origin";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import { checkRateLimit } from "@/lib/rate-limit";

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cookieOnlyRefusal();
  const { user, actor } = auth;
  await assertRecentCookieProof(actor, auth.session.id);
  annotate({ action: { name: "cycle.feed.rotate" } });

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

  const minted = mintFeedToken();
  const rotated = await prisma
    .$transaction(async (tx) => {
      const found = await tx.cycleCalendarFeed.findFirst({
        where: { userId: user.id, revokedAt: null },
        select: { id: true },
      });
      if (!found) return null;
      // Only while it is still live: a subscription turned off after the
      // read above stays off instead of coming back under a new link.
      const revoked = await tx.cycleCalendarFeed.updateMany({
        where: { id: found.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 0) return "raced" as const;
      // The options are read after the revoke holds the row, so a change
      // that committed in between is the one the new link carries, and one
      // that comes later waits and then finds the new link.
      const live = await tx.cycleCalendarFeed.findUniqueOrThrow({
        where: { id: found.id },
        select: {
          id: true,
          horizonCycles: true,
          historyCycles: true,
          includeFertile: true,
          titleMode: true,
          forecastStyle: true,
        },
      });
      const created = await tx.cycleCalendarFeed.create({
        data: {
          userId: user.id,
          createdById: actor.id,
          tokenHash: minted.hash,
          tokenPrefix: minted.prefix,
          horizonCycles: live.horizonCycles,
          historyCycles: live.historyCycles,
          includeFertile: live.includeFertile,
          titleMode: live.titleMode,
          forecastStyle: live.forecastStyle,
        },
        select: FEED_SUMMARY_SELECT,
      });
      await auditLog("cycle.feed.rotate", {
        userId: user.id,
        details: {
          feedId: created.id,
          previousFeedId: live.id,
          tokenPrefix: created.tokenPrefix,
        },
        client: tx,
      });
      return created;
    })
    .catch((err: unknown) => {
      if (isP2002(err)) return "raced" as const;
      throw err;
    });
  // Lost to another rotation, the link that won stands; lost to the
  // subscription being turned off, there is none.
  if (rotated === "raced") {
    return (await findLiveFeed(user.id)) ? feedExists() : noLiveFeed();
  }
  if (!rotated) return noLiveFeed();

  return apiSuccess(
    {
      ...feedLinks(resolveOrigin(request), minted.raw),
      feed: toFeedSummary(rotated),
    },
    201,
  );
});
