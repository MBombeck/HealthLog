"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import type { BpTimeOfDaySummary } from "@/lib/analytics/bp-time-of-day";
import { queryKeys } from "@/lib/query-keys";

/** `GET /api/measurements/blood-pressure/time-of-day` as the server resolved it. */
export interface BpTimeOfDayDto extends BpTimeOfDaySummary {
  days: number;
  from: string;
  to: string;
}

/**
 * Blood pressure by part of the day over the last `days` local days (#1331).
 * Every figure comes from the server; the card renders it as given.
 */
export function useBpTimeOfDay(days: number) {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: queryKeys.bpTimeOfDay(days),
    queryFn: () =>
      apiGet<BpTimeOfDayDto>(
        `/api/measurements/blood-pressure/time-of-day?days=${days}`,
      ),
    // A range change re-keys the read; the previous range stays painted
    // (dimmed) until the new one lands, like the chart above it.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled: isAuthenticated,
  });
}
