"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import { retryOnceOnTransientError } from "@/lib/queries/retry-transient";
import type { DailyMorning } from "@/lib/daily/morning";

/**
 * `GET /api/daily/morning`: the start page's sleep and readiness tiles, on
 * the digest's refresh cadence so the score row and the asks move together.
 */
export function useDailyMorning(enabled = true) {
  return useQuery({
    queryKey: queryKeys.dailyMorning(),
    queryFn: () => apiGet<DailyMorning>("/api/daily/morning"),
    enabled,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: "always",
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: retryOnceOnTransientError,
  });
}
