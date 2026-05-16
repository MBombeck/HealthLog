"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import type { CoachScope, CoachScopeSource } from "@/lib/ai/coach/types";

/**
 * v1.4.25 W3e — per-card "Ask Coach about this" CTA.
 *
 * Only renders when the parent passes `aiEnabled === true`. The gate
 * lives one level up (the `TargetsPage` reads `/api/insights/provider-chain`
 * and threads the flag down); this component is dumb on purpose so
 * tests can pin both branches.
 *
 * On click the button fires `onAskCoach({ prefill, scope })`. The
 * parent owns the `CoachDrawer` state; this button doesn't know about
 * the drawer at all.
 *
 * v1.4.28 R3c FB-L1 — collapsed to an icon-only affordance. The card
 * footer was carrying a labelled pill ("Coach fragen"); on a card with
 * a status pill, range bar, consistency strip, headline number, edit
 * cog and a source link, the labelled pill dominated the visual
 * hierarchy. Dropping the label retains the affordance via the
 * Sparkles glyph + `aria-label` while shrinking the optical weight
 * to a per-card icon button. UI-H2 — the glyph is the same Sparkles
 * the hero strip, the inline pill and the layout-level FAB use, so
 * the per-card Coach launch reads on one icon vocabulary across the
 * app.
 */
export interface TargetCoachButtonProps {
  /**
   * Pre-formatted question to seed the Coach drawer's composer. Locale
   * pre-resolved by the caller (per `buildTargetPrompt(targetType,
   * locale)` in `src/lib/ai/coach/target-prompts.ts`).
   */
  prefill: string;
  /**
   * The single CoachScope.sources entry to narrow the snapshot to this
   * metric. Empty array means "do not narrow"; the caller decides.
   */
  sources: ReadonlyArray<CoachScopeSource>;
  onAskCoach: (payload: { prefill: string; scope: CoachScope }) => void;
  /**
   * Renders ONLY when this is true. The parent gates on
   * `chainData?.activeProvider != null` so a user with no provider
   * configured never sees a button that opens an empty drawer.
   */
  aiEnabled: boolean;
  className?: string;
}

export function TargetCoachButton({
  prefill,
  sources,
  onAskCoach,
  aiEnabled,
  className,
}: TargetCoachButtonProps) {
  const { t } = useTranslations();

  if (!aiEnabled) return null;

  const accessibleLabel = t("targets.coach.cta");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() =>
        onAskCoach({
          prefill,
          scope: {
            sources: [...sources],
            window: "last30days",
          },
        })
      }
      data-slot="target-coach-cta"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      // Lift the icon button to the 44 px WCAG 2.5.5 floor. The
      // shadcn `icon` variant ships `size-10` (40 px); the project
      // floor is 44 px (matches the medication-history button and the
      // Coach drawer cluster). Glyph stays `size-4`.
      className={cn("min-h-11 min-w-11", className)}
    >
      <Sparkles className="size-4" aria-hidden="true" />
    </Button>
  );
}
