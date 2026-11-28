"use client";

import dynamic from "next/dynamic";

import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useAiCapability } from "@/hooks/use-ai-capability";

/**
 * v1.4.31 — defer the Coach drawer subtree behind `next/dynamic` so
 * the SSE machinery (chat reader, suggested-prompts chip rail,
 * source-chip thread, persistent settings sheet) doesn't load on
 * every cold /insights mount. The drawer renders nothing until the
 * user opens it, but the legacy direct import still ran every
 * `useState` initialiser + the Sheet portal scaffolding inside the
 * mother-page render window.
 */
const CoachDrawer = dynamic(
  () =>
    import("@/components/insights/coach-panel/coach-drawer").then((mod) => ({
      default: mod.CoachDrawer,
    })),
  { ssr: false, loading: () => null },
);

/**
 * v1.4.27 — bridge between the layout-level
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
  const coach = useAiCapability("coach");
  if (!launch) return null;
  // The drawer subtree (SSE chat reader, portal scaffolding) mounts only
  // while the `coach` capability is available: the operator's switch, the
  // person's Hide Coach, a missing provider and missing consent all keep it
  // out, so nothing offers a Coach that cannot answer.
  if (!coach.available) return null;
  return (
    <CoachDrawer
      open={launch.open}
      onOpenChange={launch.setOpen}
      prefill={launch.prefill}
      // v1.21.0 — carry the launch scope so a conversation
      // opened from a metric surface or insight card is pre-narrowed to
      // the relevant source(s).
      scope={launch.scope}
      // Auto-send the prefill as the first turn when the launch requested it
      // (assessment hand-off), so the answer lands without a manual send.
      autoSend={launch.autoSend}
      // v1.28.52 (Documents R3) — carry the stored-document scope so the vault
      // "Ask the Coach" action opens the REAL fenced conversation in the drawer
      // scoped to that document (maximizing then preserves the scope).
      documentId={launch.documentId}
      // v1.31.0 — carry the workout scope so the workout-detail "Ask why"
      // action opens a conversation whose first turn reads that session's own
      // numbers.
      workoutId={launch.workoutId}
    />
  );
}
