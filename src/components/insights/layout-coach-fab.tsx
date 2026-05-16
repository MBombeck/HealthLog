"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";

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
 */
export function LayoutCoachFab() {
  const { t } = useTranslations();
  const launch = useCoachLaunch();
  const flags = useFeatureFlags();
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
      onClick={() => launch.askCoach(null)}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className={cn(
        "fixed right-4 bottom-20 z-40 h-12 rounded-full px-4 shadow-lg",
        "from-dracula-purple to-dracula-pink bg-gradient-to-br text-white",
        "hover:from-dracula-purple/90 hover:to-dracula-pink/90",
        "lg:hidden",
      )}
    >
      <Sparkles className="size-4" aria-hidden="true" />
      <span>{accessibleLabel}</span>
    </Button>
  );
}
