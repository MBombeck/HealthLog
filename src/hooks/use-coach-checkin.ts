"use client";

/**
 * S3 — the coach check-in card's keep / let-go actions (§2.3).
 *
 * The Today rail surfaces a `coach_checkin` `PriorityItem` whose two mutating
 * one-tap actions close the coach loop through the EXISTING plan-lifecycle
 * route (`PATCH /api/coach/plans/[id]`) — no new backend surface:
 *   - keep  → re-arm: status `active` + `reviewDate` pushed out one more cycle,
 *             so the check-in comes back in a week rather than the same day;
 *   - letGo → guilt-free retirement: status `abandoned`, a terminal, respected
 *             outcome (the calm inversion of a streak). The card never nags.
 *
 * "Adjust" is navigation (an `href` into the coach) handled by the ask card (`today-asks.tsx`)
 * as a `<Link>` — it never reaches this hook.
 *
 * Both invalidate the daily digest (so the acted-on card leaves the rail) and
 * every plans-list slot (so the /coach/plans ledger stays in step). Keys route
 * through the centralised factory — no bare arrays.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPatch } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { COACH_CHECKIN_REVIEW_DAYS } from "@/lib/daily/coach-checkin-intents";

export function useCoachCheckinAction() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.dailyDigest() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.coachPlansAll() });
  };

  const keep = useMutation({
    mutationFn: async (planId: string) => {
      const reviewDate = new Date(
        Date.now() + COACH_CHECKIN_REVIEW_DAYS * 86_400_000,
      ).toISOString();
      await apiPatch(`/api/coach/plans/${encodeURIComponent(planId)}`, {
        status: "active",
        reviewDate,
      });
      return planId;
    },
    onSuccess: invalidate,
  });

  const letGo = useMutation({
    mutationFn: async (planId: string) => {
      await apiPatch(`/api/coach/plans/${encodeURIComponent(planId)}`, {
        status: "abandoned",
      });
      return planId;
    },
    onSuccess: invalidate,
  });

  return { keep, letGo };
}
