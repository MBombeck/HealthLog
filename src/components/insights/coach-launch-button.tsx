"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";

/**
 * Inline desktop Coach launch button.
 *
 * v1.4.28 R3c — the legacy implementation rendered BOTH a sticky FAB
 * (visible `<lg`) and the inline pill (`lg+`) from the same component.
 * Every sub-page that mounted `<CoachLaunchButton>` therefore painted a
 * second FAB into the DOM, collapsing to one visible button only
 * because of `fixed` positioning — the duplicates still landed in the
 * a11y tree. The FAB now lives once at the layout level (see
 * `<LayoutCoachFab>` in `src/app/insights/layout.tsx`); this component
 * keeps only the inline `lg+` pill that sub-pages mount inside their
 * action rows.
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

  // Inline header-style action on `lg+`. Hidden below `lg` because the
  // layout-level FAB (`<LayoutCoachFab>`) covers that breakpoint —
  // mounting both at the same time would put two affordances in front
  // of the user.
  return (
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
  );
}
