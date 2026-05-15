import type { ReactNode } from "react";

import { InsightsLayoutShell } from "@/components/insights/insights-layout-shell";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";
import { LayoutCoachMount } from "@/components/insights/layout-coach-mount";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";

/**
 * v1.4.25 W4 — shared layout for the routed `/insights` sub-pages.
 *
 * Hosts the sticky `<InsightsTabStrip>` so the metric pills + (mother-
 * page-only) regenerate affordance stay reachable while a user drills
 * into a sub-page. The actual page body still owns its own data fetches
 * — the layout is a thin presentational frame.
 *
 * v1.4.27 R3d MB4 — the Coach drawer now mounts here (above the routed
 * children) inside a `<CoachLaunchProvider>` so navigating into a sub-
 * page no longer unmounts the drawer. Every sub-page mounts a
 * `<CoachLaunchButton>` that calls `askCoach()` on the same context;
 * the mother `/insights/page.tsx` consumes the same hook for its hero
 * strip + suggested-prompt chips. Decision F (audit MA3) drove the
 * promotion: a mobile user who navigates from `/insights` to
 * `/insights/blutdruck` keeps a one-tap path back into the Coach.
 *
 * v1.4.28 R3c — the mobile FAB now also lives here via
 * `<LayoutCoachFab>` (carved out of `<CoachLaunchButton>` so each sub-
 * page mount no longer duplicates the FAB into the a11y tree). The
 * inline `<CoachLaunchButton>` pill stays on the per-page action rows
 * where copy + position matter.
 */
export default function InsightsLayout({ children }: { children: ReactNode }) {
  return (
    <CoachLaunchProvider>
      <InsightsLayoutShell>{children}</InsightsLayoutShell>
      <LayoutCoachFab />
      <LayoutCoachMount />
    </CoachLaunchProvider>
  );
}
