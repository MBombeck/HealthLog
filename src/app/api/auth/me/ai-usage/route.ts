/**
 * `PUT /api/auth/me/ai-usage` — the account's own AI usage level (#1217).
 *
 * `{ level: "frugal" | "standard" | "full" | null }`; `null` follows the
 * instance default. A level above the operator's ceiling is refused with 422
 * `ai.usage.aboveCeiling`, never capped silently. Answers the resolved
 * `AiUsageState`, the same block `GET /api/auth/me` publishes as `ai.usage`.
 * Own account only (cookie or a full-scope token), at most 30 writes an hour.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  loadAiUsageSettings,
  loadAiUsageState,
} from "@/lib/ai/capabilities/usage";
import { usageLevelRank, usageLevelToDb } from "@/lib/ai/usage-level";
import { aiUsagePutSchema } from "@/lib/validations/ai-usage";

export const dynamic = "force-dynamic";

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`ai-usage:${user.id}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Too many changes, try again later", 429, {
      errorCode: "ai.usage.rateLimited",
    });
  }

  const parsed = await parseJsonBody(request, aiUsagePutSchema, {
    maxBytes: 1024,
    errorCode: "ai.usage.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const { level } = parsed.data;
  const settings = await loadAiUsageSettings();
  if (
    level !== null &&
    usageLevelRank(level) > usageLevelRank(settings.maxLevel)
  ) {
    annotate({
      action: { name: "auth.me.ai_usage.put.above_ceiling" },
      meta: { level, maxLevel: settings.maxLevel },
    });
    return apiError(
      "This level is above the highest one the server allows",
      422,
      { errorCode: "ai.usage.aboveCeiling", maxLevel: settings.maxLevel },
    );
  }

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { aiUsageLevel: true },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { aiUsageLevel: level === null ? null : usageLevelToDb(level) },
  });
  await auditLog("user.aiUsage.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      previous: previous?.aiUsageLevel?.toLowerCase() ?? null,
      next: level,
    },
  });
  annotate({
    action: { name: "auth.me.ai_usage.put" },
    meta: { level: level ?? "default" },
  });

  return apiSuccess(await loadAiUsageState(user.id, { withMeasurement: true }));
});
