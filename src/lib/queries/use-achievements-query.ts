"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import type {
  AchievementMetrics,
  AchievementProgress,
  AchievementSummary,
} from "@/lib/gamification/achievements";

/**
 * v1.4.34 IW-F-Perf — single TanStack-Query wrapper for
 * `/api/gamification/achievements`.
 *
 * Pre-fix, three consumers each declared their own `useQuery` block:
 *   - `<RecentAchievementsCard>` with `["gamification", "achievements"]`,
 *   - the `/achievements` mother page with the same literal key, and
 *   - `<AchievementUnlockNotifier>` with a different key
 *     (`["gamification", "achievements", "unlock-notifier", userId]`)
 *     plus a 2-minute refetch interval.
 *
 * TanStack treats the divergent key as a fresh cache cell, so the
 * dashboard fired two network calls instead of one on every cold
 * mount — once for the card, once for the notifier. The
 * `round-v1434-prod-slowness-investigation.md` HAR catches the
 * duplicate landing inside the same ~3 s pool-starvation tail.
 *
 * This hook mirrors the v1.4.33 `use-analytics-query.ts` shape:
 *   - centralises the queryKey via `queryKeys.gamificationAchievements()`,
 *   - sets `staleTime: 60_000` so a route swing within a minute is a
 *     free cache hit,
 *   - keeps `refetchOnMount: false` + `refetchOnWindowFocus: false` so
 *     route transitions never trigger a refetch storm,
 *   - defaults to `enabled: isAuthenticated` so the unauthenticated
 *     surfaces don't spin up a 401-bound request,
 *   - lets the notifier opt into the 2-minute `refetchInterval` so its
 *     "fresh unlock" toast still fires for users who keep the tab open
 *     without forcing the card to refetch on the same cadence — the
 *     cache slot is shared, so a single refetch updates both.
 */

export interface AchievementsPayload {
  summary: AchievementSummary;
  achievements: AchievementProgress[];
  metrics: AchievementMetrics;
}

export interface UseAchievementsQueryOptions {
  /**
   * Optional override for the auth gate. Defaults to
   * `isAuthenticated`. Callers that need to defer the fetch behind a
   * stricter precondition (e.g. notifier waiting for a known userId)
   * can pass a composed flag here.
   */
  enabled?: boolean;
  /**
   * Optional refetch cadence in milliseconds. Defaults to `false`
   * (no polling). The unlock notifier opts into a 2-minute interval
   * so users who keep the tab open still see new-unlock toasts; the
   * card stays passive because both consumers share the same cache
   * cell.
   */
  refetchInterval?: number | false;
}

async function fetchAchievements(): Promise<AchievementsPayload> {
  const res = await fetch("/api/gamification/achievements");
  if (!res.ok) {
    throw new Error(`Failed to load achievements (${res.status})`);
  }
  const json = (await res.json()) as { data: AchievementsPayload };
  return json.data;
}

/**
 * Shared hook. Returns the unwrapped `data` payload typed as
 * `AchievementsPayload`. Consumers narrow at the call site.
 */
export function useAchievementsQuery(
  options: UseAchievementsQueryOptions = {},
): UseQueryResult<AchievementsPayload, Error> {
  const { isAuthenticated } = useAuth();
  const enabled =
    options.enabled !== undefined ? options.enabled : isAuthenticated;
  const refetchInterval = options.refetchInterval ?? false;

  return useQuery({
    queryKey: queryKeys.gamificationAchievements(),
    queryFn: fetchAchievements,
    enabled,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchInterval,
  });
}
