/**
 * `POST /api/environment/travel` — add a manual travel override.
 *
 * For any day in [startDate, endDate] the weather fetch resolves against this
 * coarse location instead of home (a declared trip dominates the home
 * fallback). Coordinates are rounded to 1 decimal (about 11 km). Adding an override
 * enqueues a lookback refresh so its days re-resolve. Module-gated; `userId` is
 * narrowed from auth.
 *
 * v1.42 (#615) — the period's location is stored sealed
 * (`locationEncrypted`); the readable columns are written empty and the
 * answer carries the coarse location as before.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { travelLocationSchema } from "@/lib/validations/environment";
import { roundCoarse } from "@/lib/environment/open-meteo";
import { sealLocation } from "@/lib/environment/location-cipher";
import { enqueueEnvironmentFetch } from "@/lib/jobs/environment-fetch";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, travelLocationSchema, {
    maxBytes: 4 * 1024,
    action: "environment.travel.validation-failed",
    countIssues: true,
    errorCode: "environment.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const entry = parsed.data;
  const location = {
    lat: roundCoarse(entry.lat),
    lon: roundCoarse(entry.lon),
    label: entry.label,
  };
  const row = await prisma.environmentTravelLocation.create({
    data: {
      userId: user.id,
      startDate: entry.startDate,
      endDate: entry.endDate,
      locationEncrypted: sealLocation(location),
    },
    select: { id: true, startDate: true, endDate: true },
  });
  const created = { ...row, ...location };

  // Re-resolve the affected window so the override's days pick up its weather.
  await enqueueEnvironmentFetch({
    userId: user.id,
    startDate: entry.startDate,
    endDate: entry.endDate,
  });

  annotate({
    action: {
      name: "environment.travel.create",
      entity_type: "environment_travel",
      entity_id: created.id,
    },
  });

  return apiSuccess(created, 201);
});
