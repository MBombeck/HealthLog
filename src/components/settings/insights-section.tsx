"use client";

import { InsightsOverviewArrangeSection } from "@/components/settings/insights-overview-arrange-section";
import { InsightsPillOrderSection } from "@/components/settings/insights-pill-order-section";
import { RevealWhenSettled } from "@/components/ui/reveal-when-settled";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * v1.15.18 — the "Insights" settings section (analogous to the Dashboard
 * section). Hosts two blocks:
 *   1. Arrange the OVERVIEW — section show/hide + order, persisted to
 *      `insightsLayoutJson.sections` (the v1.15.11 inline edit mode).
 *   2. Sort the navigation PILLS — pill order, persisted to
 *      `insightsLayoutJson.tiles[].order` (already a separate field in v2).
 *
 * Both write through the same `/api/insights/layout` contract the tab strip
 * and the overview share, so a save here repaints both surfaces in lockstep.
 *
 * v1.18.6 (W9) — the visible "Insights" heading + subtitle now come from the
 * shared `<SettingsSectionFrame>`, and the "← back to hub" link rides the
 * frame's `topSlot`. The body is the two arrange cards only.
 */
export function InsightsSection() {
  return (
    // The arrange list grows from its loading card to the full set of
    // sections, which pushed the pill-order card below it down the page.
    // Both reveal together once their reads settle.
    <RevealWhenSettled
      fallback={<Skeleton className="h-[28rem] w-full rounded-xl" />}
    >
      <InsightsOverviewArrangeSection id="insights-overview-arrange" />
      <InsightsPillOrderSection id="insights-pill-order" />
    </RevealWhenSettled>
  );
}
