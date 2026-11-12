"use client";

import dynamic from "next/dynamic";
import { Activity } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { CorrelationResult } from "@/lib/insights/correlations";
import type { CoachScopeSource } from "@/lib/ai/coach/types";
import { CONFIDENCE_TONE, ScorePill } from "@/components/ui/score-pill";
import { AskCoachAction } from "./ask-coach-action";
import {
  PatternDismissButton,
  PatternDismissedNotice,
  usePatternDismissalOverrides,
} from "./pattern-dismiss-action";

/**
 * v1.4.20 — single Correlation card.
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
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.ScatterCorrelationChart,
    })),
  {
    ssr: false,
    loading: () => (
      // v1.4.43 — mirror the loaded chart's responsive aspect-
      // ratio classes (`scatter-correlation-chart.tsx:100`) so the
      // skeleton reserves the same space across breakpoints. The
      // legacy `h-[180px]` was ~60 px shorter than the painted chart
      // at `sm+` and caused a visible CLS shift on insights mount.
      <Skeleton className="bg-muted/40 aspect-square min-h-[180px] w-full sm:aspect-[3/2] sm:h-auto" />
    ),
  },
);

interface CorrelationCardProps {
  /** Correlation runner output. `kind` drives title + subtitle copy. */
  result: CorrelationResult;
}

const TONE_BAR_CLASSNAME: Record<CorrelationResult["kind"], string> = {
  "bp-compliance": "bg-brand-pink",
  "mood-pulse": "bg-info",
  "weight-weekday": "bg-primary",
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

// v1.21.0 — the two sources each correlation pair spans, so the
// Coach hand-off narrows its snapshot to exactly the relationship the
// card describes.
const COACH_SOURCES_BY_KIND: Record<
  CorrelationResult["kind"],
  CoachScopeSource[]
> = {
  "bp-compliance": ["bp", "compliance"],
  "mood-pulse": ["mood", "pulse"],
  "weight-weekday": ["weight"],
};

// v1.22 — i18n keys (resolved at the call site), not hardcoded English.
const COACH_QUESTION_BY_KIND: Record<CorrelationResult["kind"], string> = {
  "bp-compliance": "insights.coach.seed.correlationBpCompliance",
  "mood-pulse": "insights.coach.seed.correlationMoodPulse",
  "weight-weekday": "insights.coach.seed.correlationWeightWeekday",
};

export function CorrelationCard({ result }: CorrelationCardProps) {
  const { t } = useTranslations();
  const dismissal = usePatternDismissalOverrides();
  const patternId = result.status === "ok" ? result.patternId : undefined;
  const dismissed = dismissal.isDismissed(
    patternId,
    result.status === "ok" && result.dismissed === true,
  );
  const title = t(TITLE_KEY[result.kind]);
  const subtitle = t(SUBTITLE_KEY[result.kind]);
  const coachSources = COACH_SOURCES_BY_KIND[result.kind];
  const coachScope =
    coachSources.length > 0
      ? { metric: coachSources[0], also: coachSources.slice(1) }
      : undefined;

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
      <CardHeader>
        <div className="space-y-0.5">
          <TileHeader
            size="sm"
            title={title}
            right={
              result.status === "ok" ? (
                <ScorePill
                  data-slot="correlation-card-confidence"
                  tone={CONFIDENCE_TONE[result.confidenceBand.label]}
                >
                  {t(CONFIDENCE_LABEL_KEY[result.confidenceBand.label])}
                </ScorePill>
              ) : undefined
            }
          />
          <p className="text-muted-foreground text-xs">{subtitle}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {dismissed && result.status === "ok" && patternId ? (
          <PatternDismissedNotice
            patternId={patternId}
            onRestored={() => dismissal.setDismissed(patternId, false)}
            onSettled={() => dismissal.clearDismissed(patternId, false)}
          />
        ) : result.status === "ok" ? (
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
              className="text-muted-foreground text-xs"
            >
              {t("insights.correlationRow.sourceChip", {
                n: result.n,
                window: t("insights.correlationRow.sourceWindowLast30"),
              })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {/* The Coach hand-off scopes to both sources in the pair. */}
              <AskCoachAction
                question={t(COACH_QUESTION_BY_KIND[result.kind])}
                scope={coachScope}
              />
              {patternId ? (
                <PatternDismissButton
                  patternId={patternId}
                  onDismissed={() => dismissal.setDismissed(patternId, true)}
                  onSettled={() => dismissal.clearDismissed(patternId, true)}
                />
              ) : null}
            </div>
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
  // Keep in step with TONE_BAR_CLASSNAME above — same token per kind.
  switch (kind) {
    case "bp-compliance":
      return "var(--brand-pink)";
    case "mood-pulse":
      return "var(--info)";
    case "weight-weekday":
      return "var(--primary)";
  }
}
