/**
 * v1.35.0 — which pillars count toward the Health Score.
 *
 *  GET   /api/auth/me/health-score-config — the resolved composition:
 *                                           which pillars count, which
 *                                           the person took out, whether
 *                                           they have chosen at all, and
 *                                           the recipe version.
 *  PATCH /api/auth/me/health-score-config — body `{ pillars: [...] }`,
 *                                           the pillars that should
 *                                           count. Field-by-field write
 *                                           of the columns this route
 *                                           owns; no mass assignment.
 *
 * The body speaks the positive selection because that is what a person
 * chooses. The column stores its complement (see
 * `src/lib/analytics/score/config.ts`), so the inversion happens once,
 * here, on the way in.
 *
 * Two things this route is responsible for beyond storing a list.
 *
 * **It refuses a selection that cannot produce a score.** As of v1.38
 * that is one selection: the empty one. Three areas of health is what
 * the score recommends, not what it demands — a two-area or one-area
 * recipe now saves and produces a score that says on its face how broad
 * it is, so refusing the write would refuse something the scorer is
 * perfectly willing to compute. Taking every pillar out is different in
 * kind: there is nothing left to average, and storing that recipe would
 * leave the person with a settings page that says one thing and a score
 * that has silently vanished. The scorer applies the same rule again at
 * read time through the same function, deliberately, so a config edited
 * outside the app meets an honest refusal rather than a missing number.
 *
 * **It evicts the score caches.** The person just changed what the
 * number means; serving the old one for the next hour would make the
 * change look broken. `invalidateUserHealthScore` is the same call the
 * lab and assessment write paths make.
 *
 * `userId` is always narrowed from `requireAuth()`; the body never
 * carries it.
 */
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
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  takeBaseToken,
  guardedUserUpdate,
  invalidBaseTokenError,
} from "@/lib/optimistic-lock";
import { evaluateScoreBreadth } from "@/lib/analytics/score/breadth";
import {
  healthScoreConfigFromSelection,
  resolveHealthScoreConfig,
  scorePillarIdSchema,
} from "@/lib/analytics/score/config";
import { SCORE_PILLAR_IDS } from "@/lib/analytics/score/types";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

/**
 * The request body. `.strict()` and enum-typed: a client sending an id
 * this build does not know is a mistake worth reporting, unlike a
 * stored blob, which is filtered instead so one stale string cannot
 * discard a recipe (see the resolver).
 */
const healthScoreConfigPatchSchema = z
  .object({
    pillars: z.array(scorePillarIdSchema).max(SCORE_PILLAR_IDS.length),
  })
  .strict();

/**
 * Why a selection cannot produce a score, said the way a person would
 * say it. One entry, because one selection cannot: the empty one.
 */
const BREADTH_REFUSAL = {
  no_pillars_selected:
    "A health score needs at least one area of health to score. Keep one selected. The score will say which areas it is built from.",
} as const;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.health-score-config.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { healthScoreConfigJson: true, updatedAt: true },
  });
  const resolved = resolveHealthScoreConfig(row?.healthScoreConfigJson);
  // A person who never chose has nothing to guard a write against, so
  // they get no token — the first save is the unconditional write.
  if (row?.healthScoreConfigJson == null) return apiSuccess(resolved);
  return apiSuccess({ ...resolved, updatedAt: row.updatedAt?.toISOString() });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `health-score-config:patch:${user.id}`,
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
    throw new HttpError(422, "health-score-config.body.invalid_json");
  }

  // Strip the optimistic-concurrency token before the strict parse, the
  // way the modules route does: the schema must stay strict, so the
  // transport token can never reach it.
  const taken = takeBaseToken(body ?? {});
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;

  const parsed = healthScoreConfigPatchSchema.safeParse(taken.rest ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.health-score-config.patch.invalid_shape" },
      meta: { issues: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "health_score_config.invalid",
    });
  }

  const breadth = evaluateScoreBreadth(parsed.data.pillars);
  if (!breadth.ok) {
    annotate({
      action: { name: "auth.me.health-score-config.patch.too_narrow" },
      meta: {
        reason: breadth.reason,
        selected: parsed.data.pillars.length,
        domains: breadth.domains.length,
      },
    });
    return apiError(BREADTH_REFUSAL[breadth.reason], 422, {
      errorCode: "health_score_config.too_narrow",
      reason: breadth.reason,
    });
  }

  // The recipe version is monotonic per account: a score record has to
  // be able to say which recipe produced it, and a comparison between
  // two windows has to be able to see that the recipe moved between
  // them. Read the previous version, increment, write.
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { healthScoreConfigJson: true },
  });
  const previous = resolveHealthScoreConfig(existing?.healthScoreConfigJson);
  const config = healthScoreConfigFromSelection({
    selection: parsed.data.pillars,
    version: previous.version + 1,
    changedAt: new Date(),
  });

  const guarded = await guardedUserUpdate({
    userId: user.id,
    base,
    data: { healthScoreConfigJson: config },
    conflict: {
      action: "auth.me.health-score-config.conflict",
      errorCode: "health_score_config_conflict",
      message: "The score selection changed since it was loaded",
    },
  });
  if ("conflict" in guarded) return guarded.conflict;

  // The composite the caches hold was computed from the old selection.
  invalidateUserHealthScore(user.id);

  const resolved = resolveHealthScoreConfig(config);

  await auditLog("user.health_score_config.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      counted: resolved.pillars,
      excluded: resolved.excludedPillars,
      version: resolved.version,
    },
  });

  annotate({
    action: { name: "auth.me.health-score-config.patch" },
    meta: {
      counted: resolved.pillars.length,
      excluded: resolved.excludedPillars.length,
      version: resolved.version,
    },
  });

  return apiSuccess({ ...resolved, updatedAt: guarded.updatedAt });
});
