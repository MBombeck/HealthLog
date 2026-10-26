/**
 * `PATCH /api/environment/preferences` — the caller's environment switches,
 * today `airQualityEnabled` (v1.42, #615). Module-gated like the rest of the
 * environment surface; `userId` is narrowed from auth.
 *
 * Off: the nightly run stops asking the air-quality feed for this account,
 * and the overview, the Coach, MCP and the correlations leave the air-quality
 * values out. Days already stored keep theirs. On again: a lookback run is
 * queued, and the nightly gap fill catches up on the days that never had any.
 * The operator switch (`ENVIRONMENT_AIR_QUALITY_DISABLED`) wins either way,
 * and the answer says when it does.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { environmentPreferencesSchema } from "@/lib/validations/environment";
import { isAirQualityOperatorDisabled } from "@/lib/environment/open-meteo-air-quality";
import { enqueueEnvironmentFetch } from "@/lib/jobs/environment-fetch";
import { enqueueAirQualityHistory } from "@/lib/jobs/environment-air-quality-history";

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, environmentPreferencesSchema, {
    maxBytes: 1024,
    errorCode: "environment.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const before = await prisma.user.findUnique({
    where: { id: user.id },
    select: { environmentAirQualityEnabled: true },
  });
  const airQualityEnabled = parsed.data.airQualityEnabled;
  await prisma.user.update({
    where: { id: user.id },
    data: { environmentAirQualityEnabled: airQualityEnabled },
  });

  const operatorDisabled = isAirQualityOperatorDisabled();
  // Turned on: fetch the recent days now rather than at night. No-ops when
  // no worker is bound; the nightly run covers it.
  if (
    airQualityEnabled &&
    !operatorDisabled &&
    before?.environmentAirQualityEnabled === false
  ) {
    await enqueueEnvironmentFetch({ userId: user.id });
    // Switched on: fill the past as well, every earlier day with entries.
    await enqueueAirQualityHistory(user.id);
  }

  annotate({
    action: { name: "environment.preferences.update" },
    meta: { air_quality_enabled: airQualityEnabled },
  });

  return apiSuccess({ airQualityEnabled, operatorDisabled });
});
