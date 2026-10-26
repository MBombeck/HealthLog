/**
 * GET / PUT / DELETE per-user threshold overrides.
 *
 * GET returns `{ effective, overrides }`. The side-by-side comparison the
 * settings UI draws comes out of `effective`, not out of a sibling key: each
 * entry carries `range` (the band in force), `isOverride`, `default` (the
 * unmodified computed band) and `bounds`. There is no top-level `defaults`
 * key and there never was — this comment promised one for long enough that
 * it is worth stating the absence rather than just deleting the word.
 * PUT accepts a partial map — only the provided metrics are updated, others
 * keep their existing override or remain on the default.
 * DELETE with ?metric=... resets one metric to default. WITHOUT the parameter
 * it drops every override the account has, so it demands the typed
 * confirmation the other wide-blast-radius deletes demand — see
 * `RESET_ALL_CONFIRMATION` below.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserProfile } from "@/lib/cache/invalidate";
import {
  getAllEffectiveRanges,
  type ThresholdOverridesJson,
  type ThresholdMetric,
} from "@/lib/analytics/effective-range";
import {
  thresholdsUpdateSchema,
  ALL_METRICS,
} from "@/lib/validations/thresholds";
import { Prisma } from "@/generated/prisma/client";
import type { NextRequest } from "next/server";

async function loadProfileAndOverrides(userId: string) {
  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
      gender: true,
      thresholdsJson: true,
    },
  });
  if (!profile) return null;
  const overrides = (profile.thresholdsJson ??
    null) as ThresholdOverridesJson | null;
  return { profile, overrides };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.thresholds.get" } });

  const result = await loadProfileAndOverrides(user.id);
  if (!result) return apiError("User not found", 404);

  const ranges = getAllEffectiveRanges(result.profile, result.overrides);
  return apiSuccess({
    effective: ranges,
    overrides: result.overrides ?? {},
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.thresholds.update" } });

  // 30 writes / 5 min — generous for legitimate UI edits, tight enough to
  // make audit-log enumeration unattractive. Per-user, not per-IP.
  const rl = await checkRateLimit(
    `thresholds:update:${user.id}`,
    30,
    5 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Too many requests, please slow down", 429);
  }

  const parsed = await parseJsonBody(request, thresholdsUpdateSchema, {
    maxBytes: 64 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { thresholdsJson: true },
  });
  const before = (existing?.thresholdsJson ?? {}) as ThresholdOverridesJson;
  const merged: ThresholdOverridesJson = { ...before, ...parsed.data };

  await prisma.user.update({
    where: { id: user.id },
    data: { thresholdsJson: merged },
  });

  // Threshold overrides feed the targets grid's effective ranges and the
  // analytics snapshot — drop the cached payloads so the next read
  // reflects the new bands instead of serving the pre-edit grid.
  invalidateUserProfile(user.id);

  await auditLog("thresholds.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { before, after: merged },
  });

  return apiSuccess({ overrides: merged });
});

/**
 * What the parameterless DELETE has to be told before it wipes every override.
 *
 * Same shape as `/api/settings/account` (`DELETE_ACCOUNT`) and
 * `/api/settings/data` (`DELETE`): a literal in the JSON body, compared
 * exactly, with no default. The point is that the wide form cannot be reached
 * by dropping a query parameter — a request that means "reset everything" has
 * to say so in a second place.
 *
 * NOT applied to `?metric=`. That form resets one band the person can retype
 * from the editor beside it, and the targets sheet fires it in a loop over the
 * metrics it owns; a confirmation there would be ceremony without a decision.
 */
const RESET_ALL_CONFIRMATION = "RESET_THRESHOLDS";

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const url = new URL(request.url);
  const metric = url.searchParams.get("metric") as ThresholdMetric | null;

  annotate({
    action: { name: "thresholds.reset" },
    meta: { metric: metric ?? "all" },
  });

  // The PUT's limit, on the path that can destroy more in one call than the
  // PUT can. It had none at all: an omitted query parameter erased the whole
  // override set, and nothing stopped that being repeated.
  const rl = await checkRateLimit(
    `thresholds:reset:${user.id}`,
    30,
    5 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Too many requests, please slow down", 429);
  }

  if (!metric) {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    let confirm = "";
    if (raw.length > 0) {
      try {
        const body = JSON.parse(raw) as { confirm?: unknown };
        confirm = typeof body?.confirm === "string" ? body.confirm : "";
      } catch {
        return apiError("Invalid request", 422);
      }
    }
    if (confirm !== RESET_ALL_CONFIRMATION) {
      // Names the token rather than saying "confirmation missing", so a client
      // that reached here by omitting `?metric=` by accident is told what the
      // request it sent actually meant.
      return apiError(
        `Confirmation missing. Resetting every threshold override requires { confirm: '${RESET_ALL_CONFIRMATION}' }`,
        422,
      );
    }
  }

  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { thresholdsJson: true },
  });
  const before = (existing?.thresholdsJson ?? {}) as ThresholdOverridesJson;

  let after: ThresholdOverridesJson = before;
  if (metric) {
    if (!ALL_METRICS.includes(metric)) {
      return apiError("Unknown metric", 400);
    }
    after = { ...before };
    delete after[metric];
  } else {
    after = {};
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      thresholdsJson: Object.keys(after).length === 0 ? Prisma.JsonNull : after,
    },
  });

  // A reset changes the effective ranges back to the defaults — same
  // eviction as the PUT above.
  invalidateUserProfile(user.id);

  await auditLog("thresholds.reset", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { metric: metric ?? "all", before, after },
  });

  return apiSuccess({ overrides: after });
});
