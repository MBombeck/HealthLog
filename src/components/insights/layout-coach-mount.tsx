"use client";

import { CoachDrawer } from "@/components/insights/coach-panel/coach-drawer";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";

/**
 * v1.4.27 R3d MB4 — bridge between the layout-level
 * `<CoachLaunchProvider>` and the Coach drawer mount.
 *
 * The layout file is a server component (it lives next to other server
 * components and feeds the `metadata` chain), so the actual `useState`
 * + `<CoachDrawer>` consumer has to live inside a client island. This
 * file is intentionally tiny — its only job is to read the context and
 * render the drawer at the layout's mount site.
 */
export function LayoutCoachMount() {
  const launch = useCoachLaunch();
  if (!launch) return null;
  return (
    <CoachDrawer
      open={launch.open}
      onOpenChange={launch.setOpen}
      prefill={launch.prefill}
    />
  );
}
