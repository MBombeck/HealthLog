"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import type {
  DateKey,
  DayIndexResponse,
  DayResponse,
} from "@/lib/day/contract";
import { queryKeys } from "@/lib/query-keys";

/**
 * One local day, from `GET /api/day/{date}`.
 *
 * The server cuts the day in the record's zone and decides everything the
 * view shows: which sections there are, the usual range of a value, the
 * running-day counts and the notable observations. Nothing here recomputes
 * any of it.
 */
export function useDay(date: DateKey | null) {
  return useQuery({
    queryKey: queryKeys.day(date ?? ""),
    queryFn: () => apiGet<DayResponse>(`/api/day/${date}`),
    enabled: date !== null,
    // A past day changes only when something is written into it, and every
    // record write evicts the `["day"]` root.
    staleTime: 5 * 60_000,
  });
}

/**
 * Which days of a window hold anything, from `GET /api/day/index`. Feeds the
 * row of dots under a chart and the visit preparation. `null` bounds keep the
 * query idle.
 */
export function useDayIndex(
  from: DateKey | null,
  to: DateKey | null,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.dayIndex(from ?? "", to ?? ""),
    queryFn: () => {
      const params = new URLSearchParams({
        from: from as string,
        to: to as string,
      });
      return apiGet<DayIndexResponse>(`/api/day/index?${params}`);
    },
    enabled: enabled && from !== null && to !== null && from <= to,
    staleTime: 5 * 60_000,
  });
}
