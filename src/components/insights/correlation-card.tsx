"use client";

import dynamic from "next/dynamic";
import { Activity, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { CorrelationResult } from "@/lib/insights/correlations";
import { CONFIDENCE_BADGE_CLASS } from "./confidence-badge";

/**
 * v1.4.20 phase B3 — single Correlation card.
 *
 * Each card surfaces ONE pre-defined hypothesis (BP × compliance,
 * mood × pulse, weight × weekday). Below-threshold results render an
 * EmptyState rather than a misleading near-zero scatter.
 *
 * Recharts is dynamic-imported behind the existing
 * `<ScatterCorrelationChart>` wrapper so each card pays the bundle
 * cost only when it actually paints a chart.
 */

const ScatterCorrelationChart = dynamic(
  () =>
    import("@/components/charts/scatter-correlation-chart").then((mod) => ({
      default: mod.ScatterCorrelationChart,
    })),
  {
    ssr: false,
    loading: () => (
      // v1.4.43 W11 — mirror the loaded chart's responsive aspect-
      // ratio classes (`scatter-correlation-chart.tsx:100`) so the
      // skeleton reserves the same space across breakpoints. The
      // legacy `h-[180px]` was ~60 px shorter than the painted chart
      // at `sm+` and caused a visible CLS shift on insights mount.
      <div className="bg-muted/40 aspect-square min-h-[180px] w-full animate-pulse rounded-md motion-reduce:animate-none sm:aspect-[3/2] sm:h-auto" />
    ),
  },
);

interface CorrelationCardProps {
  /** Correlation runner output. `kind` drives title + subtitle copy. */
  result: CorrelationResult;
}

const TONE_BAR_CLASSNAME: Record<CorrelationResult["kind"], string> = {
  "bp-compliance": "bg-dracula-pink",
  "mood-pulse": "bg-dracula-cyan",
  "weight-weekday": "bg-dracula-purple",
};

const TITLE_KEY: Record<CorrelationResult["kind"], string> = {
  "bp-compliance": "insights.correlationRow.card.bpComplianceTitle",
  "mood-pulse": "insights.correlationRow.card.moodPulseTitle",
  "weight-weekday": "insights.correlationRow.card.weightWeekdayTitle",
};

const SUBTITLE_KEY: Record<CorrelationResult["kind"], string> = {
  "bp-compliance": "insights.correlationRow.card.bpComplianceSubtitle",
  "mood-pulse": "insights.correlationRow.card.moodPulseSubtitle",
  "weight-weekday": "insights.correlationRow.card.weightWeekdaySubtitle",
};

const CONFIDENCE_LABEL_KEY: Record<"low" | "moderate" | "high", string> = {
  high: "insights.correlationRow.confidenceHigh",
  moderate: "insights.correlationRow.confidenceModerate",
  low: "insights.correlationRow.confidenceLow",
};

export function CorrelationCard({ result }: CorrelationCardProps) {
  const { t } = useTranslations();
  const title = t(TITLE_KEY[result.kind]);
  const subtitle = t(SUBTITLE_KEY[result.kind]);

  return (
    <Card
      data-slot="correlation-card"
      data-kind={result.kind}
      className="relative overflow-hidden"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-3 bottom-3 left-0 w-[3px] rounded-r",
          TONE_BAR_CLASSNAME[result.kind],
        )}
      />
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-0.5">
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            <p className="text-muted-foreground text-xs">{subtitle}</p>
          </div>
          {result.status === "ok" && (
            <Badge
              data-slot="correlation-card-confidence"
              variant="outline"
              className={cn(
                "shrink-0 text-[10px]",
                CONFIDENCE_BADGE_CLASS[result.confidenceBand.label],
              )}
            >
              {t(CONFIDENCE_LABEL_KEY[result.confidenceBand.label])}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {result.status === "ok" ? (
          <>
            <ScatterCorrelationChart
              data={result.points}
              fill={tonesByKind(result.kind)}
              xAxis={{ dataKey: "x", name: result.xLabel }}
              yAxis={{ dataKey: "y", name: result.yLabel }}
              height={180}
            />
            <p
              data-slot="correlation-card-interpretation"
              className="text-foreground text-sm leading-snug"
            >
              {result.interpretation}
            </p>
            <p
              data-slot="correlation-card-source"
              className="text-muted-foreground text-[11px]"
            >
              {t("insights.correlationRow.sourceChip", {
                n: result.n,
                window: t("insights.correlationRow.sourceWindowLast30"),
              })}
            </p>
            <Button
              type="button"
              size="sm"
              // Outline variant so the disabled placeholder reads as
              // "this is on the roadmap" rather than "the system is
              // broken right now". Flip back to default when the
              // 7-day experiment feature ships in v1.5.
              variant="outline"
              disabled
              data-slot="correlation-card-cta"
              className="gap-1.5"
              title={t("insights.correlationRow.experimentTooltip")}
              aria-label={t("insights.correlationRow.experimentTooltip")}
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t("insights.correlationRow.experimentCta")}</span>
            </Button>
          </>
        ) : (
          <EmptyState
            variant="plain"
            size="compact"
            icon={<Activity className="size-5" />}
            title={t("insights.correlationRow.emptyTitle")}
            description={t("insights.correlationRow.sourceChip", {
              n: result.n,
              window: t("insights.correlationRow.sourceWindowLast30"),
            })}
          />
        )}
      </CardContent>
    </Card>
  );
}

function tonesByKind(kind: CorrelationResult["kind"]): string {
  switch (kind) {
    case "bp-compliance":
      return "var(--dracula-pink)";
    case "mood-pulse":
      return "var(--dracula-cyan)";
    case "weight-weekday":
      return "var(--dracula-purple)";
  }
}
