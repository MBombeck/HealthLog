/**
 * `GET /api/nutrients/daily?nutrient=<code>&days=N` — per-day series for one
 * nutrient, plus its resolved dietary reference (v1.29) and the target the
 * person set for it (#1402).
 *
 * Feeds the `/insights/nutrients` charts: a dense day-bucketed series (one row
 * per calendar day in the window, 0 for a day with no logged data) folded
 * across sources by `foldNutrientDay` — a day can carry several rows, and the
 * chart shows one honest bar per day. The window is anchored to the
 * caller's own local "today" (`User.timezone`), not a UTC floor —
 * unlike the coarser window on `GET /api/nutrients`, a chart with a
 * one-day edge wobble reads as a visible bug.
 *
 * The reference resolves against the caller's profile sex (from the
 * session's own `User` row — no extra query) and is `null` when the
 * profile has no sex on file, matching the catalog's own contract:
 * omit, never guess. Module-gated like every other nutrients route.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { binaryReferenceSex } from "@/lib/profile/sex";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  NUTRIENT_CATALOG,
  resolveNutrientReference,
} from "@/lib/nutrients/catalog";
import { nutrientDailyQuerySchema } from "@/lib/validations/nutrients";
import { readNutrientDaily } from "@/lib/nutrients/read";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const parsed = nutrientDailyQuerySchema.safeParse({
    nutrient: request.nextUrl.searchParams.get("nutrient") ?? undefined,
    days: request.nextUrl.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.daily.invalid",
    });
  }
  const { nutrient, days } = parsed.data;
  const definition = NUTRIENT_CATALOG[nutrient];

  // Folded across sources within a day, split by source and judged against
  // the upper intake level in `readNutrientDaily`, the same read the overview
  // and the MCP tool use.
  const userTz = user.timezone || DEFAULT_TIMEZONE;
  const {
    days: daySeries,
    rowCount,
    personalTarget,
  } = await readNutrientDaily(user.id, userTz, nutrient, days);

  const sex = binaryReferenceSex(user.gender);
  const reference = resolveNutrientReference(nutrient, sex);

  annotate({
    action: { name: "nutrient.daily.read" },
    meta: { nutrient, window_days: days, row_count: rowCount },
  });

  return apiSuccess({
    nutrient,
    unit: definition.unit,
    windowDays: days,
    days: daySeries,
    reference,
    personalTarget,
    upperLimit: definition.upperLimit,
  });
});
