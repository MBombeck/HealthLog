/**
 * `PUT /api/environment/home` — set the account's coarse home location.
 *
 * The picked city (rounded lat/lon + label + IANA timezone) is stored on the
 * user. Coordinates are rounded to 1 decimal (about 11 km) here as a
 * defence-in-depth floor even if a client sends finer values. Setting a home enqueues a
 * lookback fetch so weather appears without waiting for the nightly tick.
 * Module-gated; `userId` is narrowed from auth.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { homeLocationSchema } from "@/lib/validations/environment";
import { roundCoarse } from "@/lib/environment/open-meteo";
import { sealLocation } from "@/lib/environment/location-cipher";
import { enqueueEnvironmentFetch } from "@/lib/jobs/environment-fetch";

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = homeLocationSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "environment.home.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "environment.invalid",
    });
  }

  const { lat, lon, label, timezone } = parsed.data;
  // Stamp the effective-from instant: from now on this home resolves days; days
  // before it stay un-attributed (filled via explicit location periods). Every
  // set/update re-stamps — the home is "effective from the moment it is set".
  const homeSince = new Date();
  const home = {
    lat: roundCoarse(lat),
    lon: roundCoarse(lon),
    label,
  };

  await prisma.user.update({
    where: { id: user.id },
    data: {
      homeLocationEncrypted: sealLocation(home),
      homeLat: null,
      homeLon: null,
      homeLabel: null,
      homeTimezone: timezone,
      homeSince,
    },
  });

  // Kick a lookback refresh so recent days populate promptly. No-ops cleanly
  // when no worker is bound; the nightly cron still covers it.
  await enqueueEnvironmentFetch({ userId: user.id });

  annotate({ action: { name: "environment.home.set" } });

  return apiSuccess({
    home: {
      lat: home.lat,
      lon: home.lon,
      label: home.label,
      timezone,
      since: homeSince.toISOString(),
    },
  });
});
