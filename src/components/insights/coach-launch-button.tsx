"use client";

import { DESTINATION_ICONS } from "@/components/layout/destination-icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import type { CoachLaunchScope } from "@/lib/insights/coach-launch-context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useAiCapability } from "@/hooks/use-ai-capability";

const CoachIcon = DESTINATION_ICONS.coach;

/**
 * Inline desktop Coach launch button.
 *
 * v1.4.28 — the legacy implementation rendered BOTH a sticky FAB
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
  /**
   * 2026-07-17 UX-flows audit F6-1 — optional scope so the conversation this
   * button opens narrows to the relevant source(s) instead of starting from
   * a blank, unscoped chat. Passed straight through to `askCoach`'s second
   * argument (mirrors every other ambient-scope call site).
   */
  scope?: CoachLaunchScope;
  /**
   * v1.31.0 — optional workout scope. When set, the opened conversation's
   * FIRST turn carries one bounded, numbers-only evidence section about that
   * session, so "Ask why" on a workout answers about THAT workout rather than
   * about the user's training in general.
   */
  workoutId?: string;
  /**
   * v1.31.0 — auto-send the prefill as the conversation's first turn instead
   * of only seeding the composer, so the answer lands directly. Mirrors
   * `<AskCoachAction>`'s flag; defaults to false (seed-only).
   */
  autoSend?: boolean;
  /** Optional className passthrough for inline overrides. */
  className?: string;
  /**
   * v1.8.6 — render the launch as an icon-only affordance instead of the
   * labelled pill. The sub-page shell mounts this variant at heading
   * height in the page header so "Coach fragen" sits top-right, aligned
   * with the title, rather than at the foot of the page. The accessible
   * label still resolves the shared CTA copy via `aria-label`. The icon
   * variant stays visible across breakpoints — it is the header's own
   * Coach entry, not the `lg+`-only inline pill the old foot placement
   * used (the mobile FAB covers `<lg` for that legacy surface).
   */
  variant?: "inline" | "icon";
}

export function CoachLaunchButton({
  label,
  prefill,
  scope,
  workoutId,
  autoSend,
  className,
  variant = "inline",
}: CoachLaunchButtonProps) {
  const { t } = useTranslations();
  const launch = useCoachLaunch();
  const coach = useAiCapability("coach");

  if (!launch) {
    // The button only makes sense beneath the provider. Render nothing
    // so the sub-page doesn't paint a dead control.
    return null;
  }
  // Hidden while the `coach` capability is unavailable for any reason. See
  // `<LayoutCoachFab>` for the matching FAB gate.
  if (!coach.available) return null;

  const accessibleLabel = label ?? t("insights.heroActionAskCoach");

  if (variant === "icon") {
    // v1.8.6 — heading-height icon button mounted by the sub-page shell.
    // Icon-only so it reads as a compact action beside the title; the
    // CTA copy moves to `aria-label` + a native tooltip.
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-slot="coach-launch-icon"
        aria-label={accessibleLabel}
        title={accessibleLabel}
        onClick={() =>
          launch.askCoach(prefill ?? null, scope, autoSend, null, workoutId)
        }
        className={cn("text-muted-foreground hover:text-foreground", className)}
      >
        <CoachIcon className="size-4" aria-hidden="true" />
      </Button>
    );
  }

  // Inline header-style action. v1.16.1 — visible on every viewport:
  // the layout-level FAB is no longer a permanent launcher (it only
  // surfaces an unseen proactive nudge), so the pill is the everyday
  // Coach entry point on mobile too.
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-slot="coach-launch-inline"
      onClick={() =>
        launch.askCoach(prefill ?? null, scope, autoSend, null, workoutId)
      }
      className={cn("inline-flex h-10 gap-2 self-end", className)}
    >
      <CoachIcon className="size-4" aria-hidden="true" />
      <span>{accessibleLabel}</span>
    </Button>
  );
}
