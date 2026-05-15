"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";

/**
 * v1.4.27 R3d MB4 — Coach launch button.
 *
 * Decision F: every routed Insights sub-page mounts this button so the
 * Coach drawer (mounted at the layout root) is always reachable. The
 * button renders as a sticky-bottom FAB on `<lg` viewports (so a phone
 * user always sees it within thumb range) and as an inline header
 * action on `lg+` (where the desktop drawer slides in from the right
 * edge and the FAB would overlap the chart legend).
 *
 * The button is a thin wrapper around `useCoachLaunch()` — it only
 * renders when the context provider is mounted (so dropping the button
 * onto a non-Insights page is a no-op rather than a crash).
 */
export interface CoachLaunchButtonProps {
  /** Optional override for the visual label. Defaults to the shared CTA. */
  label?: string;
  /** Optional prefill seed for the next Coach turn. */
  prefill?: string;
  /** Optional className passthrough for inline overrides. */
  className?: string;
}

export function CoachLaunchButton({
  label,
  prefill,
  className,
}: CoachLaunchButtonProps) {
  const { t } = useTranslations();
  const launch = useCoachLaunch();

  if (!launch) {
    // The button only makes sense beneath the provider. Render nothing
    // so the sub-page doesn't paint a dead control.
    return null;
  }

  const accessibleLabel = label ?? t("insights.heroActionAskCoach");

  return (
    <>
      {/* Sticky FAB on `<lg` viewports — pinned to the bottom-right so
          the user's thumb always finds it. `bottom-20` clears the
          mobile bottom navigation; `safe-area-inset-bottom` plus the
          existing app shell padding keep it clear of the iOS home bar.
          Hidden on `lg+` where the inline button below takes over. */}
      <Button
        type="button"
        size="lg"
        data-slot="coach-launch-fab"
        onClick={() => launch.askCoach(prefill ?? null)}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        className={cn(
          "fixed right-4 bottom-20 z-40 h-12 rounded-full px-4 shadow-lg",
          "from-dracula-purple to-dracula-pink bg-gradient-to-br text-white",
          "hover:from-dracula-purple/90 hover:to-dracula-pink/90",
          "lg:hidden",
          className,
        )}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        <span>{accessibleLabel}</span>
      </Button>
      {/* Inline header-style action on `lg+`. Lives in the page body so
          it picks up the sub-page layout's spacing instead of fighting
          a sticky header overlay. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-slot="coach-launch-inline"
        onClick={() => launch.askCoach(prefill ?? null)}
        className={cn(
          "hidden h-10 gap-2 self-end lg:inline-flex",
          className,
        )}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        <span>{accessibleLabel}</span>
      </Button>
    </>
  );
}
