import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { extractFeatures } from "@/lib/insights/features";
import {
  INSIGHTS_SYSTEM_PROMPT,
  buildUserPrompt,
  type InsightsOutput,
} from "@/lib/insights/prompt";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";

/**
 * Generate AI-powered health insights.
 * Rate limit: 2 per hour per user.
 * Caches result daily (or until new data arrives).
 */
export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const userId = sessionData.user.id;

  // Rate limit: 2 per hour per user
  const rl = checkRateLimit(`insights:${userId}`, 2, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError(
      "Maximal 2 Insights-Generierungen pro Stunde. Bitte später erneut versuchen.",
      429,
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      openaiKeyEncrypted: true,
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
    },
  });

  if (!user?.openaiKeyEncrypted) {
    return apiError(
      "Kein OpenAI API-Key hinterlegt. Bitte in den Einstellungen konfigurieren.",
      422,
    );
  }

  // Check if force refresh is requested
  const body = await request.json().catch(() => ({}));
  const forceRefresh = body.force === true;

  // Return cached result if available and less than 24h old
  if (
    !forceRefresh &&
    user.insightsCachedAt &&
    user.insightsCachedText &&
    Date.now() - user.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
  ) {
    try {
      const cached = JSON.parse(user.insightsCachedText) as InsightsOutput;
      return apiSuccess({
        insights: cached,
        cached: true,
        cachedAt: user.insightsCachedAt,
      });
    } catch {
      // Invalid cache, regenerate
    }
  }

  try {
    const apiKey = decrypt(user.openaiKeyEncrypted);
    const includeRaw = user.insightsPrivacyMode === "raw";
    const features = await extractFeatures(userId, includeRaw);
    const featuresJson = JSON.stringify(features, null, 2);
    const userPrompt = buildUserPrompt(featuresJson, user.insightsPrivacyMode);

    // Call OpenAI
    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: INSIGHTS_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 1000,
          response_format: { type: "json_object" },
        }),
      },
    );

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text();
      console.error("[insights] OpenAI error:", openaiRes.status, errBody);
      if (openaiRes.status === 401) {
        return apiError("Ungültiger OpenAI API-Key", 422);
      }
      return apiError("OpenAI-Anfrage fehlgeschlagen", 502);
    }

    const openaiJson = await openaiRes.json();
    const content = openaiJson.choices?.[0]?.message?.content;

    if (!content) {
      return apiError("Keine Antwort von OpenAI erhalten", 502);
    }

    let insights: InsightsOutput;
    try {
      insights = JSON.parse(content);
    } catch {
      return apiError("OpenAI-Antwort konnte nicht verarbeitet werden", 502);
    }

    // Cache the result
    await prisma.user.update({
      where: { id: userId },
      data: {
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify(insights),
      },
    });

    // Audit log (no sensitive content)
    await auditLog("insights.generate", {
      userId,
      ipAddress: getClientIp(request),
      details: {
        privacyMode: user.insightsPrivacyMode,
        tokensUsed: openaiJson.usage?.total_tokens ?? null,
      },
    });

    return apiSuccess({ insights, cached: false });
  } catch (err) {
    console.error("[insights] Error:", err);
    return apiError("Insights-Generierung fehlgeschlagen", 500);
  }
}
