import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { extractFeatures } from "@/lib/insights/features";
import { getInsightsSystemPrompt, buildUserPrompt } from "@/lib/insights/prompt";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { resolveProvider } from "@/lib/ai/provider";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const userId = user.id;

  const rl = await checkRateLimit(`insights:${userId}`, 2, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 2 insight generations per hour.", 429);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
      locale: true,
    },
  });

  const locale = await resolveServerLocale({
    request,
    userLocale: dbUser?.locale ?? user.locale ?? null,
  });

  const body = await request.json().catch(() => ({}));
  const forceRefresh = body.force === true;

  if (
    !forceRefresh &&
    dbUser?.insightsCachedAt &&
    dbUser.insightsCachedText &&
    Date.now() - dbUser.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
  ) {
    try {
      const cached = JSON.parse(dbUser.insightsCachedText);
      annotate({ action: { name: "insights.generate" }, meta: { cached: true } });
      return apiSuccess({ insights: cached, cached: true, cachedAt: dbUser.insightsCachedAt });
    } catch {
      // Invalid cache, regenerate
    }
  }

  const provider = await resolveProvider(userId);

  if (provider.type === "none") {
    return apiError("No AI provider configured. Connect ChatGPT in settings or ask your admin to set up an API key.", 422);
  }

  const includeRaw = dbUser?.insightsPrivacyMode === "raw";
  const features = await extractFeatures(userId, includeRaw);
  const featuresJson = JSON.stringify(features, null, 2);
  const userPrompt = buildUserPrompt(
    featuresJson,
    dbUser?.insightsPrivacyMode ?? "aggregated",
    locale,
  );

  const result = await provider.generateCompletion({
    systemPrompt: getInsightsSystemPrompt(locale),
    userPrompt,
    temperature: 0.3,
    maxTokens: 1500,
  });

  let insights: InsightResult | Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.content);
    // Try new schema first, fall back to raw parsed if validation fails
    const validated = insightResultSchema.safeParse(parsed);
    insights = validated.success ? validated.data : parsed;
  } catch {
    return apiError("Failed to parse AI response", 502);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
    },
  });

  await auditLog("insights.generate", {
    userId,
    ipAddress: getClientIp(request),
    details: {
      privacyMode: dbUser?.insightsPrivacyMode,
      tokensUsed: result.tokensUsed,
      providerType: result.providerType,
      model: result.model,
    },
  });

  annotate({
    action: { name: "insights.generate" },
    meta: {
      cached: false,
      providerType: result.providerType,
      model: result.model,
      tokensUsed: result.tokensUsed,
    },
  });

  return apiSuccess({ insights, cached: false });
});
