/**
 * GET / PUT / DELETE per-user threshold overrides.
 *
 * GET returns `{ defaults, overrides, effective }` so the settings UI can
 * show a side-by-side comparison.
 * PUT accepts a partial map — only the provided metrics are updated, others
 * keep their existing override or remain on the default.
 * DELETE with ?metric=... resets one metric to default.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  apiError,
  returnAllZodIssues,
  safeJson,
  getClientIp,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
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

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = thresholdsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

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

  await auditLog("thresholds.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { before, after: merged },
  });

  return apiSuccess({ overrides: merged });
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const url = new URL(request.url);
  const metric = url.searchParams.get("metric") as ThresholdMetric | null;

  annotate({
    action: { name: "thresholds.reset" },
    meta: { metric: metric ?? "all" },
  });

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

  await auditLog("thresholds.reset", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { metric: metric ?? "all", before, after },
  });

  return apiSuccess({ overrides: after });
});
