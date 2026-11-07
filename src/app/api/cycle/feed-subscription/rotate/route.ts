/**
 * `POST /api/cycle/feed-subscription/rotate` — a new link for the record's
 * calendar subscription (#1350).
 *
 * One transaction: the live feed is revoked and its successor minted with the
 * same options, so there is never a moment with two live links or with none.
 * Calendars holding the old link stop updating on their next poll. The new
 * URL is returned exactly once. Two rotations racing both revoke the same
 * feed, and the second successor then meets the one-live-feed index: that
 * one gets the mint path's 409 `cycle.feed.exists`, and the winner's link
 * stands.
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
import { FEED_SUMMARY_SELECT, toFeedSummary } from "@/lib/cycle/feed/status";
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
      const live = await tx.cycleCalendarFeed.findFirst({
        where: { userId: user.id, revokedAt: null },
        select: {
          id: true,
          horizonCycles: true,
          historyCycles: true,
          includeFertile: true,
          titleMode: true,
        },
      });
      if (!live) return null;
      await tx.cycleCalendarFeed.update({
        where: { id: live.id },
        data: { revokedAt: new Date() },
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
  if (rotated === "raced") return feedExists();
  if (!rotated) return noLiveFeed();

  return apiSuccess(
    {
      ...feedLinks(resolveOrigin(request), minted.raw),
      feed: toFeedSummary(rotated),
    },
    201,
  );
});
