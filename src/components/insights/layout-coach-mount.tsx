"use client";

import dynamic from "next/dynamic";

import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";

/**
 * v1.4.31 — defer the Coach drawer subtree behind `next/dynamic` so
 * the SSE machinery (chat reader, suggested-prompts chip rail,
 * source-chip thread, persistent settings sheet) doesn't load on
 * every cold /insights mount. The drawer renders nothing until the
 * user opens it, but the legacy direct import still ran every
 * `useState` initialiser + the Sheet portal scaffolding inside the
 * mother-page render window. Per
 * `.planning/research/v15-insights-blocking-bug.md` fix 4.
 */
const CoachDrawer = dynamic(
  () =>
    import("@/components/insights/coach-panel/coach-drawer").then((mod) => ({
      default: mod.CoachDrawer,
    })),
  { ssr: false, loading: () => null },
);

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
  const flags = useFeatureFlags();
  if (!launch) return null;
  // v1.4.31 — operator can hide the Coach drawer app-wide; suppress
  // the entire SSE mount when the flag is off.
  if (!flags.coach) return null;
  return (
    <CoachDrawer
      open={launch.open}
      onOpenChange={launch.setOpen}
      prefill={launch.prefill}
    />
  );
}
