import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateWeightStatusForUser,
  resolveWeightStatusLocale,
} from "@/lib/insights/weight-status";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const locale = resolveWeightStatusLocale(resolved);

  const result = await generateWeightStatusForUser(user.id, {
    locale,
    force: false,
  });

  annotate({ action: { name: "insights.weight-status" } });

  return apiSuccess(result);
});
