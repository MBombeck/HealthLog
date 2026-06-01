"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { HealthChartDynamicMini } from "@/components/charts/health-chart-dynamic";
import {
  TrendAnnotation,
  type TrendAnnotationConfidenceBand,
  type TrendAnnotationStatus,
} from "./trend-annotation";

/**
 * Trends row — three small charts (BP / Weight / Mood) above a
 * one-sentence assessment each. Recharts is ~108 KiB Brotli, so the
 * three charts ride the shared lazy-import boundary
 * (`<HealthChartDynamicDynamic>` for BP + weight; MoodChart still resolves
 * locally because no shared re-export exists yet for it).
 *
 * Layout:
 *   - `<md`: single column, full width
 *   - `>=md`: 3-up grid, equal column tracks
 *
 * Annotations come from `trendAnnotations.{bp,weight,mood}` on the
 * Insights payload. When a metric's annotation is null, the
 * `<TrendAnnotation>` empty state hints at the gap without breaking
 * the row's visual rhythm.
 */

const MoodChart = dynamic(
  () =>
    import("@/components/charts/mood-chart").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton mini /> },
);

interface TrendsRowProps {
  /**
   * Assistant-authored one-sentence annotations, keyed by metric. Optional —
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
  /**
   * v1.4.36 W2 T3 — advisor query / mutation in flight. When true,
   * every per-metric annotation slot paints a pending shimmer instead
   * of the "Mehr Daten nötig" empty hint. Resolves the recurring
   * complaint where the empty hint flashed across all three metrics
   * while the advisor was generating fresh annotations.
   */
  loading?: boolean;
}

export function TrendsRow({
  annotations,
  confidence,
  loading = false,
}: TrendsRowProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const userTimezone = user?.timezone;
  const bpAnnotation = annotations?.bp ?? null;
  const weightAnnotation = annotations?.weight ?? null;
  const moodAnnotation = annotations?.mood ?? null;
  // v1.4.36 W2 T3 — derive the tri-state status per metric from the
  // advisor's loading flag + the annotation presence. Pending wins
  // over needs_data so a mid-generation regenerate doesn't flash the
  // empty hint between the spinner and the new prose.
  const statusFor = (annotation: string | null): TrendAnnotationStatus => {
    if (loading) return "pending";
    return annotation ? "generated" : "needs_data";
  };

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
      {/* v1.4.22 A4 — equal-height cards. The annotation prose
          below each chart varies in length, which used to leave the
          three cards on visibly different baselines. Each card is now
          a flex column with `min-h-[300px]` so the chart anchors to
          the top and the annotation grows downward into a shared
          minimum height.
          v1.4.25 W3 — strengthen the equal-height contract with
          `md:auto-rows-fr` + `md:items-stretch` on the grid and
          `h-full` on each card so the tallest annotation still pins
          every row member to a single baseline.

          v1.4.27 MB7 / CF-71 — drop the unconditional `min-h-[300px]`
          floor to `md:min-h-[300px]` so mobile single-column doesn't
          eat dead space below a short chart; the floor stays on `md+`
          to preserve the equal-height baseline across the row.

          v1.4.28 R3c-Insights (FB-K1/K2) — three-slot template.
          `auto-rows-fr` covers every viewport, not just `md+`, so the
          mobile single-column path picks up the same row contract
          when the user expands the strip side-by-side via the
          orientation-change. The chart slot is now wrapped in a
          fixed-height shell so BP / weight / mood all paint the
          series at the same vertical position; the annotation slot
          clamps via `<TrendAnnotation>` so long captions can't pull
          the row taller than the design constant. */}
      <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-3 md:items-stretch">
        <div
          data-slot="trends-row-card"
          data-metric="bp"
          className="flex h-full flex-col gap-2 md:min-h-[300px]"
        >
          {/* v1.4.28 R3c-Insights — fixed chart slot. `<HealthChartDynamic>`
              mini paints its own 140 px chart band; this wrapper pins
              the total chart-envelope height so the mood tile's Card
              wrapper (which carries a heavier shell on a default
              shadcn Card) lines up with the BP/weight tiles' lighter
              shell. Both chart types ship the same data-slot now. */}
          <div data-slot="trends-row-chart-slot" className="h-[180px] shrink-0">
            <HealthChartDynamicMini
              types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
              title={t("charts.bloodPressure")}
              colors={["#ff79c6", "#8be9fd"]}
              unit="mmHg"
              yAxisUnit="mmHg"
              mini
              userTimezone={userTimezone}
            />
          </div>
          <TrendAnnotation
            metric="bp"
            annotation={bpAnnotation}
            confidence={confidence?.bp}
            status={statusFor(bpAnnotation)}
          />
        </div>
        <div
          data-slot="trends-row-card"
          data-metric="weight"
          className="flex h-full flex-col gap-2 md:min-h-[300px]"
        >
          <div data-slot="trends-row-chart-slot" className="h-[180px] shrink-0">
            <HealthChartDynamicMini
              types={["WEIGHT"]}
              title={t("charts.weight")}
              colors={["#bd93f9"]}
              unit="kg"
              mini
              userTimezone={userTimezone}
            />
          </div>
          <TrendAnnotation
            metric="weight"
            annotation={weightAnnotation}
            confidence={confidence?.weight}
            status={statusFor(weightAnnotation)}
          />
        </div>
        <div
          data-slot="trends-row-card"
          data-metric="mood"
          className="flex h-full flex-col gap-2 md:min-h-[300px]"
        >
          <div data-slot="trends-row-chart-slot" className="h-[180px] shrink-0">
            <MoodChart
              title={t("charts.mood")}
              mini
              userTimezone={userTimezone}
            />
          </div>
          <TrendAnnotation
            metric="mood"
            annotation={moodAnnotation}
            confidence={confidence?.mood}
            status={statusFor(moodAnnotation)}
          />
        </div>
      </div>
    </section>
  );
}
