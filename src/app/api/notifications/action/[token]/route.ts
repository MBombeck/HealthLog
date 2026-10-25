/**
 * `POST /api/notifications/action/<token>` — a quick answer tapped inside a
 * notification.
 *
 * The caller is a notification app (ntfy's `http` action), not a browser
 * with a session, so the signed path segment is the whole credential. What
 * the token proves and how it is kept single-use is in
 * `src/lib/notifications/action-token.ts`; this route only applies it:
 *
 *  1. Rate-limit per client address BEFORE looking at the token, so the
 *     route is no oracle for guessing one (the anonymous-surface limiter
 *     collapses a broken proxy trust chain into one tight bucket).
 *  2. Verify the signature (constant-time) and the expiry.
 *  3. Re-check what may have changed since the reminder went out: the
 *     account still exists and its mood module is still on.
 *  4. Claim the reminder's nonce (`action-nonce.ts`), then write the mood
 *     entry under it. The claim and the entry's unique
 *     `(userId, source, externalId)` key each make the first answer the only
 *     one: a repeat tap, or a different answer on the same reminder, is
 *     refused with 409 and writes nothing. The claim is what still holds
 *     after the entry was deleted and purged inside the token's lifetime.
 *
 * The token travels in the path, so it is scrubbed from every log line by
 * the `PATH_SECRET_PATHS` entry for this prefix, and the route sits on the
 * URL-credential inventory in `session-surface-guard.test.ts`.
 */
import { NextRequest } from "next/server";

import { Prisma } from "@/generated/prisma/client";
import { apiHandler } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { logTelegramMood } from "@/lib/mood/create-from-telegram";
import {
  claimActionNonce,
  releaseActionNonce,
} from "@/lib/notifications/action-nonce";
import {
  MOOD_QUICK_ACTIONS,
  quickActionExternalId,
  verifyActionToken,
} from "@/lib/notifications/action-token";
import {
  checkAuthSurfaceRateLimit,
  checkRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Generous for one person tapping, tight for anyone enumerating. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000;

interface RouteContext {
  params: Promise<{ token: string }>;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    annotate({ action: { name: "notification.action.invoke" } });

    // The token is verified first: it is an HMAC, so checking it costs one
    // hash and no database read. A forged or stale token is limited per
    // address in a bucket of its own, and a genuine one per account. The one
    // shared bucket this used to charge first, keyed on the address, became
    // a single bucket for everyone whenever the address could not be read,
    // and a couple of junk requests a minute switched off every person's
    // quick answers.
    const { token } = await context.params;
    const verdict = verifyActionToken(token);
    const rl = verdict.ok
      ? await checkRateLimit(
          `notification-action:user:${verdict.userId}`,
          RATE_LIMIT,
          RATE_WINDOW_MS,
        )
      : await checkAuthSurfaceRateLimit(
          request,
          "notification-action-invalid",
          RATE_LIMIT,
          RATE_WINDOW_MS,
        );
    if (!rl.allowed) {
      annotate({
        action: { name: "notification.action.refused" },
        meta: { reason: "rate_limited" },
      });
      const response = apiError("Too many requests", 429);
      for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
        response.headers.set(k, v);
      }
      return response;
    }

    if (!verdict.ok) {
      annotate({
        action: { name: "notification.action.refused" },
        meta: { reason: verdict.reason },
      });
      return verdict.reason === "expired"
        ? apiError("This answer has expired", 410, {
            errorCode: "notification.action.expired",
          })
        : apiError("Invalid action", 401, {
            errorCode: "notification.action.invalid",
          });
    }

    const user = await prisma.user.findUnique({
      where: { id: verdict.userId },
      select: { id: true, timezone: true },
    });
    if (!user) {
      annotate({
        action: { name: "notification.action.refused" },
        meta: { reason: "unknown_user" },
      });
      return apiError("Invalid action", 401, {
        errorCode: "notification.action.invalid",
      });
    }
    getEvent()?.setAuth({
      user_id: user.id,
      auth_method: "notification_action_token",
    });

    if (!(await isModuleEnabled(user.id, "mood"))) {
      annotate({
        action: { name: "notification.action.refused" },
        meta: { reason: "module_disabled" },
      });
      return apiError("Mood tracking is turned off", 403, {
        errorCode: "notification.action.module_disabled",
      });
    }

    const alreadyUsed = () => {
      annotate({
        action: { name: "notification.action.refused" },
        meta: { reason: "already_used" },
      });
      return apiError("This reminder was already answered", 409, {
        errorCode: "notification.action.already_used",
      });
    };

    const claimed = await claimActionNonce({
      userId: user.id,
      nonce: verdict.nonce,
      expiry: verdict.expiry,
    });
    if (!claimed) return alreadyUsed();

    const score = MOOD_QUICK_ACTIONS[verdict.action];
    let created: boolean;
    try {
      const result = await logTelegramMood({
        userId: user.id,
        score,
        tz: user.timezone,
        externalId: quickActionExternalId(verdict.nonce),
        source: "NOTIFICATION",
      });
      created = result.created;
    } catch (err) {
      // Two taps raced past the existence check; the unique key let one in.
      if (!isUniqueViolation(err)) {
        // Nothing was written: give the answer back so a retry can land.
        await releaseActionNonce({ userId: user.id, nonce: verdict.nonce });
        throw err;
      }
      created = false;
    }

    if (!created) return alreadyUsed();

    annotate({
      action: { name: "notification.action.mood_logged" },
      meta: { action: verdict.action },
    });
    return apiSuccess({ logged: true, action: verdict.action });
  },
);
