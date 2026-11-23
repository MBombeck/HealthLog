/**
 * `GET /api/nutrients/energy-balance?days=N` — the daily energy balance:
 * intake against resting plus active energy, with a seven-day trend.
 *
 * Computed live from data that already arrives (the nutrient store's
 * `energy` total and the energy readings), so a corrected or late import
 * moves it on the next read. A day without a resting reading takes the
 * Mifflin-St Jeor estimate from the profile, flagged as estimated; a day
 * missing any input has no balance rather than a guessed one. See
 * `src/lib/nutrients/energy-balance.ts` for the rules.
 *
 * Module-gated like every other nutrients route, and readable by a delegate
 * whose grant covers the measurements.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { readEnergyBalanceForUser } from "@/lib/nutrients/energy-balance";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { energyBalanceQuerySchema } from "@/lib/validations/nutrients";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const parsed = energyBalanceQuerySchema.safeParse({
    days: request.nextUrl.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.energyBalance.invalid",
    });
  }

  const balance = await readEnergyBalanceForUser({
    userId: user.id,
    // The zone every other day read uses, so "today" here is the day view's
    // today, operator default included.
    tz: await resolveUserTimezone(user.id),
    days: parsed.data.days,
  });

  annotate({
    action: { name: "nutrient.energyBalance.read" },
    meta: {
      window_days: balance.windowDays,
      days_with_balance: balance.summary.daysWithBalance,
      estimate_gaps: balance.estimateGaps.length,
    },
  });
  return apiSuccess(balance);
});
