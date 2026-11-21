"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { recentEntryTypes } from "@/lib/measurements/recent-entry-types";

import type { Measurement } from "../list/list-model";

/** Enough manual rows to see three types through a busy blood-pressure week. */
const RECENT_MANUAL_ROWS = 60;
/** The last reading for the hint, and enough glucose ones to find a habit. */
const TYPE_HISTORY_ROWS = 20;

type ListAnswer = { measurements: Measurement[] };

/**
 * The entry types the person logs by hand, most recent first, from their own
 * manual readings on the server (so every device agrees). Empty while it
 * loads or when the read fails: the form and picker then simply show no
 * shortcuts, which is the honest fallback for a convenience.
 */
export function useRecentEntryTypes(
  offered: ReadonlyArray<string>,
  enabled: boolean,
  max = 3,
): string[] {
  const query = useQuery({
    queryKey: queryKeys.measurementsRecentManual(),
    queryFn: () =>
      apiGet<ListAnswer>(
        `/api/measurements?sourceEq=MANUAL&limit=${RECENT_MANUAL_ROWS}`,
      ),
    enabled,
    staleTime: 60_000,
  });
  return recentEntryTypes(query.data?.measurements ?? [], offered, max);
}

/**
 * The latest stored readings of one type, newest first (any source: a scale
 * that syncs is still "my last weight"). `null` type reads nothing.
 */
export function useTypeHistory(type: string | null): Measurement[] {
  const query = useQuery({
    queryKey: queryKeys.measurementsTypeHistory(type ?? ""),
    queryFn: () =>
      apiGet<ListAnswer>(
        `/api/measurements?type=${encodeURIComponent(type ?? "")}&limit=${TYPE_HISTORY_ROWS}`,
      ),
    enabled: type !== null,
    staleTime: 60_000,
  });
  return query.data?.measurements ?? [];
}
