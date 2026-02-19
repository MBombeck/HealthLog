import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";

/**
 * Get insights configuration status.
 */
export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const user = await prisma.user.findUnique({
    where: { id: sessionData.user.id },
    select: {
      openaiKeyEncrypted: true,
      insightsPrivacyMode: true,
      insightsCachedAt: true,
    },
  });

  return apiSuccess({
    hasKey: !!user?.openaiKeyEncrypted,
    privacyMode: user?.insightsPrivacyMode ?? "aggregated",
    lastInsightAt: user?.insightsCachedAt ?? null,
  });
}

/**
 * Update insights settings (API key and/or privacy mode).
 */
export async function PUT(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const body = await request.json();
  const data: Record<string, unknown> = {};

  // Update API key if provided
  if (typeof body.apiKey === "string") {
    const key = body.apiKey.trim();
    if (key === "") {
      // Remove key
      data.openaiKeyEncrypted = null;
      data.insightsCachedAt = null;
      data.insightsCachedText = null;
    } else {
      if (!key.startsWith("sk-")) {
        return apiError(
          "Ungültiges API-Key-Format (muss mit sk- beginnen)",
          422,
        );
      }
      data.openaiKeyEncrypted = encrypt(key);
    }
  }

  // Update privacy mode if provided
  if (typeof body.privacyMode === "string") {
    if (!["aggregated", "raw"].includes(body.privacyMode)) {
      return apiError("Ungültiger Privacy-Modus", 422);
    }
    data.insightsPrivacyMode = body.privacyMode;
    // Clear cache when privacy mode changes
    data.insightsCachedAt = null;
    data.insightsCachedText = null;
  }

  if (Object.keys(data).length === 0) {
    return apiError("Keine Änderungen", 422);
  }

  await prisma.user.update({
    where: { id: sessionData.user.id },
    data,
  });

  return apiSuccess({ updated: true });
}
