import type { ReactNode } from "react";

import { InsightsLayoutShell } from "@/components/insights/insights-layout-shell";

/**
 * v1.4.25 W4 — shared layout for the routed `/insights` sub-pages.
 *
 * Hosts the sticky `<InsightsTabStrip>` so the metric pills + (mother-
 * page-only) regenerate affordance stay reachable while a user drills
 * into a sub-page. The actual page body still owns its own data fetches
 * — the layout is a thin presentational frame.
 *
 * Critical design rule (Marc directive 2026-05-11):
 *   The `<CoachDrawer>` is NOT mounted in this layout. It stays inside
 *   `src/app/insights/page.tsx` body so navigating into a sub-page
 *   unmounts the drawer (matches the Apple Health convention that AI/
 *   coach surfaces only live on the overview, never on a metric page).
 */
export default function InsightsLayout({ children }: { children: ReactNode }) {
  return <InsightsLayoutShell>{children}</InsightsLayoutShell>;
}
