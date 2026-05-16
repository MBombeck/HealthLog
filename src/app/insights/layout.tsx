import type { ReactNode } from "react";

import { InsightsLayoutShell } from "@/components/insights/insights-layout-shell";
import { LayoutCoachFab } from "@/components/insights/layout-coach-fab";

/**
 * v1.4.25 W4 — shared layout for the routed `/insights` sub-pages.
 *
 * Hosts the sticky `<InsightsTabStrip>` so the metric pills + (mother-
 * page-only) regenerate affordance stay reachable while a user drills
 * into a sub-page. The actual page body still owns its own data fetches
 * — the layout is a thin presentational frame.
 *
 * v1.4.27 R3d MB4 — the Coach drawer mounts above the routed children
 * inside a `<CoachLaunchProvider>` so navigating into a sub-page no
 * longer unmounts the drawer. Every sub-page mounts a
 * `<CoachLaunchButton>` that calls `askCoach()` on the same context;
 * the mother `/insights/page.tsx` consumes the same hook for its hero
 * strip + suggested-prompt chips.
 *
 * v1.4.28 R3c — the mobile FAB also lives here via `<LayoutCoachFab>`
 * (carved out of `<CoachLaunchButton>` so each sub-page mount no
 * longer duplicates the FAB into the a11y tree). The inline
 * `<CoachLaunchButton>` pill stays on the per-page action rows where
 * copy + position matter.
 *
 * v1.4.34 IW-B — `<CoachLaunchProvider>` + `<LayoutCoachMount>` now
 * live on the global `<AuthShell>` (`src/components/layout/auth-shell.tsx`)
 * so every authenticated route (dashboard included) can open the drawer
 * from the same context. The FAB stays scoped to `/insights/**` only —
 * the floating action would distract from the dashboard hero on
 * surfaces where a contextual inline button already covers the same
 * affordance.
 */
export default function InsightsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <InsightsLayoutShell>{children}</InsightsLayoutShell>
      <LayoutCoachFab />
    </>
  );
}
