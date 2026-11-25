"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import type { ChartBucketType } from "@/lib/charts/bucket-time-series";
import type { ChartContextResponse } from "@/lib/charts/context-markers-contract";
import { queryKeys } from "@/lib/query-keys";

import { resolveContextMarks } from "./context-marks";

/**
 * Where metric charts draw what happened around the metric.
 *
 * A page opts in once (`SubPageShell chartContext`), and every full-size
 * `HealthChart` under it reads the marks: no prop to thread through each
 * chart, and a chart elsewhere (a dashboard tile, a mini chart) never asks.
 * One read per page, the whole record, cached under the timeline root so a
 * medication, illness or cycle write refreshes it.
 */
const ChartContextScope = createContext<ChartContextResponse | null>(null);

/** Five minutes: the marks change on a record write, which evicts them. */
const CONTEXT_STALE_MS = 5 * 60_000;

/**
 * Reads the marks once for the page. A failed read draws no marks rather
 * than an error: every chart stands on its own.
 */
export function ChartContextProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return enabled ? (
    <ChartContextReader>{children}</ChartContextReader>
  ) : (
    children
  );
}

function ChartContextReader({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.chartContext(),
    queryFn: () => apiGet<ChartContextResponse>("/api/insights/context"),
    enabled: isAuthenticated,
    staleTime: CONTEXT_STALE_MS,
    retry: false,
  });
  return (
    <ChartContextScope.Provider value={query.data ?? null}>
      {children}
    </ChartContextScope.Provider>
  );
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
function useCyclePhaseChoice(): [boolean, (next: boolean) => void] {
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

/**
 * The marks of the page's context on one chart, and its cycle switch. Null
 * marks outside an opted-in page, on a mini chart, and whenever nothing
 * falls in the drawn window: the chart then draws as it always did.
 */
export function useChartContextMarks(args: {
  enabled: boolean;
  points: readonly { timestamp: number }[] | undefined;
  bucket: ChartBucketType;
  plotWidth: number;
}) {
  const context = useContext(ChartContextScope);
  const [showCycle, setShowCycle] = useCyclePhaseChoice();
  const marks = resolveContextMarks(
    args.enabled ? context : null,
    args.points,
    { bucket: args.bucket, showCycle, plotWidth: args.plotWidth },
  );
  return { marks, showCycle, setShowCycle };
}
