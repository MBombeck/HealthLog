import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  generateGeneralStatusForUser,
  resolveGeneralStatusLocale,
} from "@/lib/insights/general-status";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = resolveGeneralStatusLocale(
    localeParam ?? sessionData.user.locale ?? "de",
  );

  try {
    const result = await generateGeneralStatusForUser(sessionData.user.id, {
      locale,
      force: false,
    });

    return apiSuccess(result);
  } catch (error) {
    console.error("[insights.general-status] GET failed:", error);
    return apiError("Allgemeiner Zustand konnte nicht erstellt werden", 500);
  }
}
