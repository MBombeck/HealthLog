"use client";

import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { cn } from "@/lib/utils";
import { CONFIDENCE_BADGE_CLASS } from "./confidence-badge";

/**
 * v1.4.20 phase B3 — single-sentence AI annotation rendered directly
 * below a Trends-row chart.
 *
 * Pure presentational. The annotation string is sourced from the AI
 * advisor payload's `trendAnnotations.{bp,weight,mood}` block (see
 * `src/lib/ai/schema.ts`). When the model omits the field, the parent
 * passes `annotation={null}` and we render an empty-state hint.
 *
 * Confidence band is optional — surfaced as a small `Badge` chip when
 * a backing correlation gives us one. The chip is purely visual and
 * never adds new copy beyond the `low / moderate / high` translation.
 *
 * v1.4.36 W2 T3 — render-state contract (`status`). Pre-fix the
 * component derived empty vs filled from `annotation == null` alone,
 * which painted "Mehr Daten nötig" on every cold mount and every
 * regenerate-in-flight, even when the advisor was about to deliver an
 * annotation. The status prop now distinguishes:
 *
 *   - `"pending"`     — advisor query in flight or regenerate firing.
 *                       Renders a 3-line shimmer block matching the
 *                       filled-state row contract.
 *   - `"needs_data"`  — advisor returned `annotation = null`. Renders
 *                       the "Mehr Daten nötig" hint.
 *   - `"generated"`   — advisor returned a string. Renders the prose +
 *                       optional confidence chip.
 *
 * Back-compat: when `status` is omitted, the legacy
 * `annotation == null → empty` mapping still applies so existing call
 * sites that don't pass the prop keep their current behaviour.
 */

export type TrendAnnotationConfidenceBand = "low" | "moderate" | "high";

export type TrendAnnotationStatus = "pending" | "needs_data" | "generated";

interface TrendAnnotationProps {
  /** The metric this annotation describes. Drives the empty-state copy. */
  metric: "bp" | "weight" | "mood";
  /** AI-authored sentence. `null` renders the empty-state hint (legacy path). */
  annotation: string | null;
  /** Optional discrete confidence band. */
  confidence?: TrendAnnotationConfidenceBand;
  /**
   * Tri-state render contract. When supplied, drives the branch
   * directly (and overrides the legacy `annotation == null` empty
   * fallback). Default `undefined` keeps the legacy two-state mapping
   * for back-compat with existing call sites.
   */
  status?: TrendAnnotationStatus;
}

const CONFIDENCE_LABEL_KEY: Record<TrendAnnotationConfidenceBand, string> = {
  high: "insights.trendAnnotation.confidenceHigh",
  moderate: "insights.trendAnnotation.confidenceModerate",
  low: "insights.trendAnnotation.confidenceLow",
};

const EMPTY_KEY: Record<TrendAnnotationProps["metric"], string> = {
  bp: "insights.trendAnnotation.emptyBp",
  weight: "insights.trendAnnotation.emptyWeight",
  mood: "insights.trendAnnotation.emptyMood",
};

export function TrendAnnotation({
  metric,
  annotation,
  confidence,
  status,
}: TrendAnnotationProps) {
  const { t } = useTranslations();

  // v1.4.36 W2 T3 — render-state contract. When `status` is supplied
  // it drives the branch directly; otherwise we fall back on the
  // legacy `annotation == null → empty` mapping so existing callers
  // (tests, isolated mounts) keep their previous behaviour.
  const resolvedStatus: TrendAnnotationStatus =
    status ?? (annotation ? "generated" : "needs_data");

  if (resolvedStatus === "pending") {
    return (
      <div
        data-slot="trend-annotation-pending"
        data-metric={metric}
        role="status"
        aria-busy="true"
        aria-live="polite"
        className="border-border/60 bg-card/40 space-y-1.5 rounded-md border p-3 motion-reduce:animate-none"
        aria-label={t("insights.trendAnnotation.pendingLabel")}
      >
        <div className="bg-muted/60 h-2.5 w-11/12 animate-pulse motion-reduce:animate-none rounded" />
        <div className="bg-muted/60 h-2.5 w-9/12 animate-pulse motion-reduce:animate-none rounded" />
        <div className="bg-muted/60 h-2.5 w-7/12 animate-pulse motion-reduce:animate-none rounded" />
      </div>
    );
  }

  if (resolvedStatus === "needs_data" || !annotation) {
    return (
      <p
        data-slot="trend-annotation-empty"
        data-metric={metric}
        // v1.4.28 R3c-Insights — `line-clamp-3` on both states. The
        // empty-state copy is short by construction but the row
        // contract still pins the slot's height so the chart slot
        // above stays aligned with the filled-state neighbour
        // tiles. The empty caption never inflates the row.
        className="text-muted-foreground line-clamp-3 text-xs italic"
      >
        {t(EMPTY_KEY[metric])}
      </p>
    );
  }

  return (
    <div
      data-slot="trend-annotation"
      data-metric={metric}
      className="border-border/60 bg-card/40 flex items-start gap-2 rounded-md border p-3"
    >
      <Sparkles
        className="text-dracula-purple mt-0.5 h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">
        {/* v1.4.28 R3c-Insights — `line-clamp-3` bounds caption
            variance (FB-K2). A 1-sentence BP annotation paints
            ~3 lines wrapped; a 4-line mood annotation used to push
            the cell taller, which `auto-rows-fr` propagated to
            every neighbour cell. With the clamp the longest
            annotation ends with an ellipsis at 3 lines and the
            row stays at a single visual rhythm. */}
        <p className="text-foreground line-clamp-3 text-xs leading-snug">
          {stripChartTokens(annotation)}
        </p>
        {confidence ? (
          <Badge
            data-slot="trend-annotation-confidence"
            variant="outline"
            className={cn("text-[10px]", CONFIDENCE_BADGE_CLASS[confidence])}
          >
            {t(CONFIDENCE_LABEL_KEY[confidence])}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
