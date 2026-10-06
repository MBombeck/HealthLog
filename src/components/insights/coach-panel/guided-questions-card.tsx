"use client";

/**
 * v1.16.5 — entry card for the guided clarifying-questions flow.
 *
 * Replaces the v1.16.0 loose composer chips: when pending self-context
 * questions exist, this quiet card sits above the composer and offers
 * the guided sequence instead of scattering tappable chips. Three
 * choices, mirroring common scripted-onboarding chat patterns:
 *
 *   - "Answer now" starts the in-chat sequence (machine START).
 *   - "Later" hides the offer for this session; the questions stay
 *     pending and the card returns on the next mount.
 *   - "Don't ask again" dismisses every pending question server-side
 *     (existing DELETE with empty body).
 *
 * Renders nothing when no questions pend — zero vertical cost.
 */
import { MessageCircleQuestion } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

export interface GuidedQuestionsCardProps {
  /** Pending-question count (1–3); the parent hides the card at 0. */
  count: number;
  onStart: () => void;
  onLater: () => void;
  onDismissAll: () => void;
  /** Disabled while a reply streams or the dismiss request is in flight. */
  disabled?: boolean;
}

export function GuidedQuestionsCard({
  count,
  onStart,
  onLater,
  onDismissAll,
  disabled = false,
}: GuidedQuestionsCardProps) {
  const { t } = useTranslations();

  return (
    <div
      data-slot="coach-guided-offer"
      className={cn(
        "border-primary/30 from-primary/10 to-brand-pink/5",
        "mb-2 rounded-lg border bg-gradient-to-r px-3 py-2.5",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div
          aria-hidden="true"
          className="from-primary to-brand-pink mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
        >
          <MessageCircleQuestion className="text-background size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {count === 1
              ? t("insights.coach.guided.offerTitleOne")
              : t("insights.coach.guided.offerTitle", { count })}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("insights.coach.guided.offerBody")}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-slot="coach-guided-offer-start"
              disabled={disabled}
              onClick={onStart}
              className={cn(
                "bg-primary/15 text-primary inline-flex min-h-8 items-center rounded-full px-3 text-xs font-medium",
                "hover:bg-primary/25 focus-visible:ring-input-focus focus-visible:ring-2 focus-visible:outline-none",
                "disabled:opacity-60",
              )}
            >
              {t("insights.coach.guided.offerStart")}
            </button>
            <button
              type="button"
              data-slot="coach-guided-offer-later"
              disabled={disabled}
              onClick={onLater}
              className={cn(
                "text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center rounded-full px-2.5 text-xs",
                "hover:bg-primary/10 focus-visible:ring-input-focus focus-visible:ring-2 focus-visible:outline-none",
                "disabled:opacity-60",
              )}
            >
              {t("insights.coach.guided.offerLater")}
            </button>
            <button
              type="button"
              data-slot="coach-guided-offer-dismiss"
              disabled={disabled}
              onClick={onDismissAll}
              className={cn(
                "text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center rounded-full px-2.5 text-xs",
                "hover:bg-primary/10 focus-visible:ring-input-focus focus-visible:ring-2 focus-visible:outline-none",
                "disabled:opacity-60",
              )}
            >
              {t("insights.coach.guided.offerDismiss")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
