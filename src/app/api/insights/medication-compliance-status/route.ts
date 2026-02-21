import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  generateMedicationComplianceStatusForUser,
  resolveMedicationComplianceStatusLocale,
} from "@/lib/insights/medication-compliance-status";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = resolveMedicationComplianceStatusLocale(
    localeParam ?? sessionData.user.locale ?? "de",
  );

  try {
    const result = await generateMedicationComplianceStatusForUser(
      sessionData.user.id,
      {
        locale,
        force: false,
      },
    );

    return apiSuccess(result);
  } catch (error) {
    console.error("[insights.medication-compliance-status] GET failed:", error);
    return apiError(
      "Medikamentencompliance-Text konnte nicht erstellt werden",
      500,
    );
  }
}
