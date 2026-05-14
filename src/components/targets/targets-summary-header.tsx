"use client";

import { CheckCircle2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.25 W3e — page-level summary line.
 *
 * "4 of 6 targets met this week" (DE: "4 von 6 Zielwerten diese Woche
 * erreicht"). When every target hits the bar we surface a calm check
 * mark + "All N targets met this week" copy — no animation, no
 * celebration. Marc directive: stay quieter than the v1.4.20 Insights
 * hero.
 *
 * Optional streak highlight chip when one metric has a current ≥ 3 day
 * streak; the metric label is resolved from the targets.label.* i18n
 * map so it renders in the user's locale.
 */
export interface TargetsSummaryHeaderProps {
  targetsMetThisWeek: number;
  totalTargets: number;
  streakHighlight: { metric: string; days: number } | null;
  className?: string;
}

export function TargetsSummaryHeader({
  targetsMetThisWeek,
  totalTargets,
  streakHighlight,
  className,
}: TargetsSummaryHeaderProps) {
  const { t } = useTranslations();

  if (totalTargets === 0) return null;

  const allMet = targetsMetThisWeek === totalTargets;
  const headline = allMet
    ? t("targets.summary.weekTitleAll", { total: String(totalTargets) })
    : t("targets.summary.weekTitle", {
        met: String(targetsMetThisWeek),
        total: String(totalTargets),
      });

  let highlightCopy: string | null = null;
  if (streakHighlight && streakHighlight.days >= 3) {
    const metricLabel = t(`targets.label.${streakHighlight.metric}`);
    const resolvedMetric =
      metricLabel === `targets.label.${streakHighlight.metric}`
        ? streakHighlight.metric
        : metricLabel;
    highlightCopy = t("targets.summary.streakHighlight", {
      count: String(streakHighlight.days),
      metric: resolvedMetric,
    });
  }

  return (
    <section
      data-slot="targets-summary-header"
      className={cn(
        "flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {allMet && (
          <CheckCircle2
            className="size-4 shrink-0 text-[var(--dracula-green)]"
            aria-hidden="true"
          />
        )}
        <p
          className="text-foreground text-sm font-medium"
          data-slot="targets-summary-title"
        >
          {headline}
        </p>
      </div>
      {highlightCopy && (
        <span
          className="text-muted-foreground text-xs sm:before:mx-1 sm:before:content-['·']"
          data-slot="targets-summary-streak"
        >
          {highlightCopy}
        </span>
      )}
    </section>
  );
}
