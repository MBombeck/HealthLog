"use client";

import { useSyncExternalStore } from "react";

import {
  getChartTooltipActive,
  getChartTooltipActiveServer,
  subscribeChartTooltipActive,
} from "./chart-tooltip-observer";

/**
 * v1.4.33 (F15) — read the live "is a Recharts tooltip painted right
 * now" boolean. Backed by a singleton `MutationObserver` that watches
 * every `.recharts-tooltip-wrapper` on the page for inline-style
 * `visibility` changes; see `chart-tooltip-observer.ts` for the
 * full contract.
 *
 * Returns `false` on the server so the FAB renders fully on the SSR
 * pass; the client takes over after hydration.
 */
export function useChartTooltipActive(): boolean {
  return useSyncExternalStore(
    subscribeChartTooltipActive,
    getChartTooltipActive,
    getChartTooltipActiveServer,
  );
}
