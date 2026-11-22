/**
 * `GET /api/nav/counts` — the two counts the navigation shows: doses due now
 * and check-ups due now (`loadNavCounts`). One cheap read with a fixed
 * statement count (`query-budget-hot-routes.test.ts`); nothing is written.
 *
 * Auth: `requireAuth()`, the caller's own record. Inside somebody else's
 * record the navigation shows no counts and does not ask.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { loadNavCounts } from "@/lib/navigation/nav-counts";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const counts = await loadNavCounts(
    user.id,
    user.timezone ?? DEFAULT_TIMEZONE,
    new Date(),
  );
  annotate({
    action: { name: "nav.counts.read" },
    meta: { doses_due: counts.dosesDue, checkups_due: counts.checkupsDue },
  });
  return apiSuccess(counts);
});
