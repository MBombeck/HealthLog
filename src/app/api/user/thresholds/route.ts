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
import { apiSuccess, apiError, safeJson, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
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
  const overrides = (profile.thresholdsJson ?? null) as
    | ThresholdOverridesJson
    | null;
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

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = thresholdsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
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
      thresholdsJson:
        Object.keys(after).length === 0 ? Prisma.JsonNull : after,
    },
  });

  await auditLog("thresholds.reset", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { metric: metric ?? "all", before, after },
  });

  return apiSuccess({ overrides: after });
});
