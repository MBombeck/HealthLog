"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import type { ChartContextResponse } from "@/lib/charts/context-markers-contract";
import { queryKeys } from "@/lib/query-keys";

/**
 * Where metric charts draw what happened around the metric.
 *
 * A page opts in once (`SubPageShell chartContext`), and every full-size
 * `HealthChart` under it reads the marks: no prop to thread through each
 * chart, and a chart elsewhere (a dashboard tile, a mini chart) never asks.
 * One read per page, the whole record, cached under the timeline root so a
 * medication, illness or cycle write refreshes it.
 */
const ChartContextScope = createContext(false);

export function ChartContextProvider({ children }: { children: ReactNode }) {
  return (
    <ChartContextScope.Provider value>{children}</ChartContextScope.Provider>
  );
}

/** Five minutes: the marks change on a record write, which evicts them. */
const CONTEXT_STALE_MS = 5 * 60_000;

/**
 * The context marks for a chart inside an opted-in page, else null. A failed
 * read draws no marks rather than an error: the chart stands on its own.
 */
export function useChartContext(enabled: boolean): ChartContextResponse | null {
  const scoped = useContext(ChartContextScope);
  const on = scoped && enabled;
  const query = useQuery({
    queryKey: queryKeys.chartContext(),
    queryFn: () => apiGet<ChartContextResponse>("/api/insights/context"),
    enabled: on,
    staleTime: CONTEXT_STALE_MS,
    retry: false,
  });
  return on ? (query.data ?? null) : null;
}

const CYCLE_STORAGE_KEY = "healthlog.chart-context.cycle";

function readCycleChoice(): boolean {
  try {
    return window.localStorage.getItem(CYCLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The cycle-phase switch, off until switched on, remembered in this browser
 * for every chart (a reading preference, not part of the record).
 */
export function useCyclePhaseChoice(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState(() =>
    typeof window === "undefined" ? false : readCycleChoice(),
  );
  const set = (next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(CYCLE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Storage refused (private mode): the choice holds for this page.
    }
  };
  return [on, set];
}
