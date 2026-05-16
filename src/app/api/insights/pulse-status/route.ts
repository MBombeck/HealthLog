import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generatePulseStatusForUser,
  resolvePulseStatusLocale,
} from "@/lib/insights/pulse-status";
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
  const locale = resolvePulseStatusLocale(resolved);

  const result = await generatePulseStatusForUser(user.id, {
    locale,
    force: false,
  });

  annotate({ action: { name: "insights.pulse-status" } });

  return apiSuccess(result);
});
