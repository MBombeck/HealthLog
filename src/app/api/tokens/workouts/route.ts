/**
 * `POST /api/tokens/workouts` — mint a Bearer that can push workouts into the
 * holder's own record and do nothing else (#1054).
 *
 * The door a workout bridge pushes through: a watch vendor's sync relayed by a
 * small service, or a script replaying an exported history. It is the
 * measurement-ingest mint (`../measurements/route.ts`) copied for a third
 * scope, and every argument made there holds here — read that file for the
 * reasoning behind each guard. In short:
 *
 * - `permissions` is a literal, so no request shape reaches it;
 * - `workouts:write` is accepted by `POST /api/workouts/batch` alone, on the
 *   holder's own record; the rows it writes carry `EXTERNAL` provenance, and
 *   it cannot list or read a workout back, reach any other route, or mint
 *   another token;
 * - minting takes a cookie session, because a short-lived native access token
 *   must not be able to leave behind a credential that lives a year;
 * - ten mints a minute and ten live tokens bound a runaway loop.
 *
 * No listing and no revoke of its own: `GET /api/tokens` lists every token
 * with its permissions and `DELETE /api/tokens/[id]` revokes one.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  assertRecentCookieProof,
  requireCookieAuth,
} from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { issueApiToken } from "@/lib/auth/issue-token";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { WORKOUTS_WRITE_SCOPE } from "@/lib/workouts/scopes";
import { createWorkoutTokenSchema } from "@/lib/validations/tokens";

/**
 * Days a token lives when the caller names no lifetime. A year, like the
 * measurement token: it is pasted into a bridge that runs unattended, where a
 * quiet expiry surfaces as "my runs stopped showing up sometime in the spring".
 */
const DEFAULT_EXPIRY_DAYS = 365;

/** Mints per user per minute. */
const MINT_RATE_LIMIT_MAX = 10;
const MINT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Live workout tokens an account may hold at once; catches a loop. */
const MAX_LIVE_TOKENS = 10;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, session } = await requireCookieAuth();
  // And a fresh proof on top of the session: the token lives far longer than
  // a stolen session would, so minting one needs the person, not just the
  // browser.
  await assertRecentCookieProof(user, session.id);
  annotate({ action: { name: "tokens.workouts.create" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
  }

  const rl = await checkRateLimit(
    `tokens:workouts:mint:${user.id}`,
    MINT_RATE_LIMIT_MAX,
    MINT_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many token mints, try again later", 429);
  }

  const parsed = await parseJsonBody(request, createWorkoutTokenSchema, {
    maxBytes: 16 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  // Counted live and per scope, after validation and before the create; the
  // count-then-create race is bounded by the mint bucket above. See the
  // measurement mint for the full argument.
  const live = await prisma.apiToken.count({
    where: {
      userId: user.id,
      revoked: false,
      permissions: { has: WORKOUTS_WRITE_SCOPE },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (live >= MAX_LIVE_TOKENS) {
    annotate({
      action: { name: "tokens.workouts.create" },
      meta: { outcome: "ceiling_reached", live_token_count: live },
    });
    return apiError(
      `You already have ${MAX_LIVE_TOKENS} workout tokens. Revoke one before creating another.`,
      409,
      { errorCode: "tokens.workouts.ceiling_reached" },
    );
  }

  const issued = await issueApiToken({
    userId: user.id,
    name: parsed.data.name,
    // A literal, never spread and never derived from the body. `issueApiToken`
    // defaults to `["*"]` when this property is absent, which is why the unit
    // suite asserts this array and not merely the 201.
    permissions: [WORKOUTS_WRITE_SCOPE],
    expiresInDays: parsed.data.expiresInDays ?? DEFAULT_EXPIRY_DAYS,
  });

  await auditLog("tokens.workouts.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { tokenId: issued.tokenId, scope: WORKOUTS_WRITE_SCOPE },
  });

  // The raw token, once. It is stored as an HMAC and no path re-reveals it.
  return apiSuccess(
    { token: issued.token, name: issued.name, expiresAt: issued.expiresAt },
    201,
  );
});
