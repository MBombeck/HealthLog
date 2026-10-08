"use client";

import { useCallback, useRef, useState } from "react";

import type { MetricWindowStats } from "@/lib/charts/window-stats";

/**
 * v1.12.8 — chart-reactive metric statistics.
 *
 * A metric sub-page lifts this hook so its `<HealthChart>` and its
 * `<MetricStatStrip>` read the same window. The chart reports the per-type
 * Min / Max / Median / Mean for the data currently visible under its active
 * range tab (the 7 / 30 / 90 / All selector) through `onVisibleStats`; the
 * strip reads `statsByType[type]` and renders those windowed numbers.
 *
 * `null` (no data, or mini mode) means "show the full range" — the strip
 * falls back to the precomputed summary. The chart owns the maths (it already
 * holds the bucketed series), so the hook only stores what it is handed and
 * exposes a stable callback.
 *
 * The callback is referentially stable across renders so it can sit in the
 * chart's effect dependency list without re-firing. A shallow guard skips the
 * state write when the chart reports the same window twice in a row, keeping a
 * re-render that recomputes the same slice from thrashing the strip.
 */
export interface ChartDomainStats {
  /**
   * Per-type windowed stats, keyed by `MeasurementType`. Null means the chart
   * has not reported a slice yet (or has no data). A type may be absent from
   * the map when its series has no readings in the visible range — the strip
   * falls back to the full-range summary for that series.
   */
  statsByType: Record<string, MetricWindowStats> | null;
  /**
   * False until the chart has settled and reported once (even an empty
   * window). The strip holds its cells until then rather than painting the
   * full-range summary and swapping to the chart's window a beat later.
   */
  statsSettled: boolean;
  /** Stable callback handed to `<HealthChart onVisibleStats>`. */
  onVisibleStats: (stats: Record<string, MetricWindowStats> | null) => void;
}

export function useChartDomainStats(): ChartDomainStats {
  const [statsByType, setStatsByType] = useState<Record<
    string,
    MetricWindowStats
  > | null>(null);
  const [statsSettled, setStatsSettled] = useState(false);
  const lastRef = useRef<string>("null");

  const onVisibleStats = useCallback(
    (stats: Record<string, MetricWindowStats> | null) => {
      setStatsSettled(true);
      // Cheap shallow signature so an identical window (a re-render that
      // recomputes the same slice) doesn't re-set state and re-render the
      // strip.
      const signature = stats === null ? "null" : JSON.stringify(stats);
      if (signature === lastRef.current) return;
      lastRef.current = signature;
      setStatsByType(stats);
    },
    [],
  );

  return {
    statsByType,
    statsSettled,
    onVisibleStats,
  };
}
