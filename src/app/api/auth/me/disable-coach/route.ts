/**
 * v1.4.47 W3 — per-user Coach opt-out endpoint.
 *
 *  GET    /api/auth/me/disable-coach  — current flag.
 *  PATCH  /api/auth/me/disable-coach  — body `{ disableCoach: boolean }`.
 *                                       Flips the column and emits an
 *                                       audit-log row mirroring the
 *                                       Research-Mode endpoint pattern.
 *
 * The toggle is reachable from Settings → Insights as a `<Switch>`
 * labelled "Hide Coach" / "Coach ausblenden". Default `false` (Coach
 * visible) — see migration `0078_v1447_user_disable_coach` for the
 * column-level documentation.
 *
 * Idempotent. The endpoint always returns the resolved next-state
 * shape so the client can hard-set the optimistic update without an
 * extra round-trip. Rate-limit is intentionally generous (60/min) —
 * the Switch is a one-tap affordance, but iOS clients may eventually
 * batch settings round-trips after a passkey re-pair and a tight
 * 5/min would surface as a 429 on a normal onboarding flow.
 */
import { z } from "zod";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

const patchBodySchema = z.object({ disableCoach: z.boolean() });

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type DisableCoachResponse = {
  disableCoach: boolean;
};

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.disable-coach.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { disableCoach: true },
  });
  const payload: DisableCoachResponse = {
    disableCoach: row?.disableCoach ?? false,
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `disable-coach:patch:${user.id}`,
    PATCH_RATE_LIMIT,
    PATCH_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(422, "disable-coach.body.invalid_json");
  }

  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) {
    annotate({ action: { name: "auth.me.disable-coach.patch.invalid_shape" } });
    return returnAllZodIssues(parsed.error, 422);
  }

  const next = parsed.data.disableCoach;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { disableCoach: true },
  });

  // Idempotent — write even when the values match so the audit row
  // mirrors the API call. The DB write is cheap and the audit log is
  // the source of truth for "user toggled this".
  await prisma.user.update({
    where: { id: user.id },
    data: { disableCoach: next },
  });

  await auditLog(
    next ? "user.disable-coach.enable" : "user.disable-coach.disable",
    {
      userId: user.id,
      ipAddress: getClientIp(req),
      details: {
        previous: previous?.disableCoach ?? false,
        next,
      },
    },
  );

  annotate({
    action: { name: "auth.me.disable-coach.patch" },
    meta: { disableCoach: next },
  });

  const payload: DisableCoachResponse = { disableCoach: next };
  return apiSuccess(payload);
});
