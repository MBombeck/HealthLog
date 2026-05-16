import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateMedicationComplianceStatusForUser,
  resolveMedicationComplianceStatusLocale,
} from "@/lib/insights/medication-compliance-status";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { requireAssistantSurface } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  await requireAssistantSurface("insightStatus");

  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const locale = resolveMedicationComplianceStatusLocale(resolved);

  const result = await generateMedicationComplianceStatusForUser(user.id, {
    locale,
    force: false,
  });

  annotate({ action: { name: "insights.medication-compliance-status" } });

  return apiSuccess(result);
});
