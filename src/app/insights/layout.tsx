import type { ReactNode } from "react";

import { InsightsLayoutShell } from "@/components/insights/insights-layout-shell";
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
 */
export default function InsightsLayout({ children }: { children: ReactNode }) {
  return (
    <CoachLaunchProvider>
      <InsightsLayoutShell>{children}</InsightsLayoutShell>
      <LayoutCoachMount />
    </CoachLaunchProvider>
  );
}
