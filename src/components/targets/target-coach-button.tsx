"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
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
   * `chainData?.activeProvider != null` so a user with no AI provider
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

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
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
      className={className}
    >
      <Sparkles className="size-3.5" aria-hidden="true" />
      <span>{t("targets.coach.cta")}</span>
    </Button>
  );
}
