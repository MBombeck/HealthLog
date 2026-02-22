import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  generateMoodStatusForUser,
  resolveMoodStatusLocale,
} from "@/lib/insights/mood-status";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = resolveMoodStatusLocale(
    localeParam ?? sessionData.user.locale ?? "de",
  );

  try {
    const result = await generateMoodStatusForUser(sessionData.user.id, {
      locale,
      force: false,
    });

    return apiSuccess(result);
  } catch (error) {
    console.error("[insights.mood-status] GET failed:", error);
    return apiError("Stimmungs-Zusammenfassung konnte nicht erstellt werden", 500);
  }
}
