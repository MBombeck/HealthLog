"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import {
  TrendAnnotation,
  type TrendAnnotationConfidenceBand,
} from "./trend-annotation";

/**
 * v1.4.20 phase B3 — Trends row.
 *
 * Renders three small charts (BP / Weight / Mood) above a one-sentence
 * AI annotation each. Recharts is ~108 KiB Brotli, so we mirror the
 * `<ScatterCorrelationChart>` defer-load pattern from `/insights` for
 * the two HealthChart-backed cards. The MoodChart already has its own
 * fetch wired so it composes naturally.
 *
 * Layout:
 *   - `<md`: single column, full width
 *   - `>=md`: 3-up grid, equal column tracks
 *
 * Annotations come from `trendAnnotations.{bp,weight,mood}` on the AI
 * advisor payload. When a metric's annotation is null, the
 * `<TrendAnnotation>` empty state hints at the gap without breaking
 * the row's visual rhythm.
 */

// v1.4.22 W5 reconcile (S-04) — both `dynamic()` calls used the same
// pulse-skeleton placeholder. Hoist so the loading affordance stays
// in lock-step (cleared against `feedback_charts_visual_identity.md`
// — placeholder only, no chart visual change).
const ChartSkeleton = () => (
  <div className="bg-muted/40 h-[220px] w-full animate-pulse rounded-md motion-reduce:animate-none" />
);

const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false, loading: ChartSkeleton },
);

const MoodChart = dynamic(
  () =>
    import("@/components/charts/mood-chart").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: ChartSkeleton },
);

interface TrendsRowProps {
  /**
   * AI-authored one-sentence annotations, keyed by metric. Optional —
   * legacy advisor payloads (pre-PROMPT_VERSION 4.20.1) won't carry
   * the field.
   */
  annotations?: {
    bp?: string | null;
    weight?: string | null;
    mood?: string | null;
  } | null;
  /**
   * Optional per-metric confidence bands surfaced as small chips below
   * each annotation. When omitted, the annotation renders without a
   * chip.
   */
  confidence?: {
    bp?: TrendAnnotationConfidenceBand;
    weight?: TrendAnnotationConfidenceBand;
    mood?: TrendAnnotationConfidenceBand;
  };
}

export function TrendsRow({ annotations, confidence }: TrendsRowProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const userTimezone = user?.timezone;
  const bpAnnotation = annotations?.bp ?? null;
  const weightAnnotation = annotations?.weight ?? null;
  const moodAnnotation = annotations?.mood ?? null;

  return (
    <section
      data-slot="trends-row"
      aria-label={t("insights.trendsRow.title")}
      className="space-y-3"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          {t("insights.trendsRow.title")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("insights.trendsRow.subtitle")}
        </p>
      </div>
      {/* v1.4.22 A4 — equal-height cards. The AI annotation prose
          below each chart varies in length, which used to leave the
          three cards on visibly different baselines. Each card is now
          a flex column with `min-h-[300px]` so the chart anchors to
          the top and the annotation grows downward into a shared
          minimum height.
          v1.4.25 W3 — strengthen the equal-height contract with
          `md:auto-rows-fr` + `md:items-stretch` on the grid and
          `h-full` on each card so the tallest annotation still pins
          every row member to a single baseline. The `min-h-[300px]`
          floor stays in place for the single-column mobile view. */}
      <div className="grid grid-cols-1 gap-4 md:auto-rows-fr md:grid-cols-3 md:items-stretch">
        <div
          data-slot="trends-row-card"
          data-metric="bp"
          className="flex h-full min-h-[300px] flex-col gap-2"
        >
          <HealthChart
            types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
            title={t("charts.bloodPressure")}
            colors={["#ff79c6", "#8be9fd"]}
            unit="mmHg"
            yAxisUnit="Hg"
            mini
            userTimezone={userTimezone}
          />
          <TrendAnnotation
            metric="bp"
            annotation={bpAnnotation}
            confidence={confidence?.bp}
          />
        </div>
        <div
          data-slot="trends-row-card"
          data-metric="weight"
          className="flex h-full min-h-[300px] flex-col gap-2"
        >
          <HealthChart
            types={["WEIGHT"]}
            title={t("charts.weight")}
            colors={["#bd93f9"]}
            unit="kg"
            mini
            userTimezone={userTimezone}
          />
          <TrendAnnotation
            metric="weight"
            annotation={weightAnnotation}
            confidence={confidence?.weight}
          />
        </div>
        <div
          data-slot="trends-row-card"
          data-metric="mood"
          className="flex h-full min-h-[300px] flex-col gap-2"
        >
          <MoodChart
            title={t("charts.mood")}
            mini
            userTimezone={userTimezone}
          />
          <TrendAnnotation
            metric="mood"
            annotation={moodAnnotation}
            confidence={confidence?.mood}
          />
        </div>
      </div>
    </section>
  );
}
