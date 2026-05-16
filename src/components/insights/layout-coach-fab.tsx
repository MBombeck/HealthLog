"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";

import { useChartTooltipActive } from "./use-chart-tooltip-active";

/**
 * Layout-level mobile Coach launch FAB.
 *
 * v1.4.28 R3c — promoted out of `<CoachLaunchButton>` (which previously
 * rendered both the FAB and the inline pill from a single component;
 * each sub-page mount therefore painted a duplicate FAB into the DOM
 * before `fixed` positioning collapsed them visually). Mounting the
 * FAB once at the layout level keeps the affordance reachable from
 * every routed Insights surface while leaving the a11y tree with a
 * single button.
 *
 * Hidden on `lg+` viewports — desktop users reach the Coach via the
 * inline `<CoachLaunchButton>` pill that each page mounts in its
 * action row.
 *
 * v1.4.33 (F15) — the FAB sits at `bottom-right` and used to overlay
 * Recharts tooltips on the bottom-right of any insight chart, so a
 * mobile user tapping a data point near the chart's lower-right
 * couldn't read the bubble. The button now auto-hides while a chart
 * tooltip is active (the wrapper's `visibility: visible` flips us
 * to fade-out + pointer-events-none). When the user releases / scrolls
 * away the tooltip clears and the FAB fades back in.
 */
export function LayoutCoachFab() {
  const { t } = useTranslations();
  const launch = useCoachLaunch();
  const flags = useFeatureFlags();
  const tooltipActive = useChartTooltipActive();
  if (!launch) return null;
  // v1.4.31 — operator can hide the Coach surface app-wide. The
  // FAB returns null when the master OR the coach sub-flag is off.
  if (!flags.coach) return null;

  const accessibleLabel = t("insights.heroActionAskCoach");

  return (
    <Button
      type="button"
      size="lg"
      data-slot="coach-launch-fab"
      data-chart-tooltip-active={tooltipActive ? "true" : undefined}
      onClick={() => launch.askCoach(null)}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      // v1.4.33 (F15) — `aria-hidden` + `tabIndex={-1}` while a chart
      // tooltip is painted so screen-reader users + keyboard users
      // don't trip over a button that's visually faded; pointer-events
      // are gone, so a tap can't land on the invisible FAB either.
      aria-hidden={tooltipActive ? true : undefined}
      tabIndex={tooltipActive ? -1 : undefined}
      className={cn(
        "fixed right-4 bottom-20 z-40 h-12 rounded-full px-4 shadow-lg",
        "from-dracula-purple to-dracula-pink bg-gradient-to-br text-white",
        "hover:from-dracula-purple/90 hover:to-dracula-pink/90",
        "lg:hidden",
        // v1.4.33 (F15) — fade out while a Recharts tooltip is open.
        // 150 ms transition matches the rest of the Coach drawer's
        // fade timing; `motion-reduce:transition-none` honours user
        // preference. `pointer-events-none` keeps the faded FAB from
        // intercepting taps that should reach the tooltip behind.
        "transition-opacity duration-150 motion-reduce:transition-none",
        tooltipActive && "pointer-events-none opacity-0",
      )}
    >
      <Sparkles className="size-4" aria-hidden="true" />
      <span>{accessibleLabel}</span>
    </Button>
  );
}
