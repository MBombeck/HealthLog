"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight, TrendingUp } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { SectionHeading } from "@/components/ui/section-heading";
import { HealthChartDynamicMini } from "@/components/charts/health-chart-dynamic";
import type { DailyBriefing } from "@/lib/ai/schema";
import {
  selectTrendCharts,
  type TrendAnnotationKey,
  type TrendChartConfig,
  type SelectTrendChartsOptions,
} from "@/lib/insights/trend-chart-select";
import {
  TrendAnnotation,
  TrendCaptionCard,
  TrendDescriptorCaption,
  type TrendAnnotationConfidenceBand,
  type TrendAnnotationStatus,
} from "./trend-annotation";

/**
 * Trends row — a small chart per metric above a one-sentence
 * assessment. Recharts is ~108 KiB Brotli, so the charts ride the
 * shared lazy-import boundary (`<HealthChartDynamicMini>` for every
 * measurement series; `<MoodChart>` resolves locally because no shared
 * re-export exists for it yet).
 *
 * v1.8.5 — the chart set is DYNAMIC. It mirrors the daily briefing:
 * the row charts exactly the metrics the briefing flags, in the
 * briefing's priority order, deduped and capped (top three). When no
 * briefing is available — cold mount, web-only account with no
 * findings, or a pre-briefing cached payload — `selectTrendCharts`
 * falls back to the legacy BP / weight / mood triple so the row never
 * paints empty. Selection lives in `@/lib/insights/trend-chart-select`
 * (pure + unit-tested); this component is the renderer.
 *
 * Layout:
 *   - `<md`: single column, full width
 *   - `>=md`: 3-up grid, equal column tracks
 *
 * Annotations come from `trendAnnotations.{bp,weight,mood}` on the
 * Insights payload and only attach to those three slots (the advisor
 * authors annotations for the legacy triple). When a slot's annotation
 * is null, `<TrendAnnotation>`'s empty state hints at the gap without
 * breaking the row's rhythm.
 *
 * v1.8.6 W8 — every card carries a caption. Additive metrics (the
 * briefing-driven slots beyond the legacy triple) carry no advisor
 * annotation, so they fall back to a standard one-line description
 * (`config.captionKey`). Before this every additive card painted the
 * chart with empty space underneath; now the row never shows a
 * caption-less card.
 */

const MoodChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton mini /> },
);

interface TrendsRowProps {
  /**
   * Metrics to leave out because their module is switched off (for
   * example `mood`). Passed straight to `selectTrendCharts`.
   */
  hiddenMetrics?: SelectTrendChartsOptions["hiddenMetrics"];
  /**
   * Daily briefing payload. Drives the chart set: the row charts the
   * metrics the briefing flags, in order, deduped + capped. `null` /
   * omitted → the default BP / weight / mood triple.
   */
  briefing?: DailyBriefing | null;
  /**
   * Assistant-authored one-sentence annotations, keyed by metric. Only
   * the legacy triple (bp / weight / mood) carries annotations.
   * Optional — legacy advisor payloads (pre-PROMPT_VERSION 4.20.1)
   * won't carry the field.
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

function MetricChart({
  config,
  title,
}: {
  config: TrendChartConfig;
  title: string;
}) {
  const { user } = useAuth();
  const userTimezone = user?.timezone;
  if (config.kind === "mood") {
    return <MoodChart title={title} mini />;
  }
  return (
    <HealthChartDynamicMini
      types={config.types}
      title={title}
      colors={config.colors}
      unit={config.unit}
      yAxisUnit={config.yAxisUnit}
      mini
      userTimezone={userTimezone}
    />
  );
}

export function TrendsRow({
  briefing,
  annotations,
  confidence,
  loading = false,
  hiddenMetrics,
}: TrendsRowProps) {
  const { t } = useTranslations();

  // v1.8.5 — derive the chart set from the briefing. No new fetch: the
  // briefing payload is already on the page (advisor cache), so this is
  // a pure read that respects the v1.8.3 anti-freeze contract.
  const charts = selectTrendCharts(briefing, { hiddenMetrics });

  // v1.4.36 W2 T3 — derive the tri-state status per metric from the
  // advisor's loading flag + the annotation presence. Pending wins
  // over needs_data so a mid-generation regenerate doesn't flash the
  // empty hint between the spinner and the new prose.
  const statusFor = (annotation: string | null): TrendAnnotationStatus => {
    if (loading) return "pending";
    return annotation ? "generated" : "needs_data";
  };

  const annotationFor = (key: TrendAnnotationKey): string | null =>
    annotations?.[key] ?? null;

  // v1.11.4 item J — three-tier caption precedence for the legacy triple
  // (the only slots that carry an advisor annotation):
  //   1. advisor in flight        → `<TrendAnnotation status="pending">`
  //                                  shimmer (loading flag).
  //   2. advisor annotation present → the AI sentence.
  //   3. NO annotation (cold briefing) → a deterministic, rule-based
  //      descriptor computed from the SAME series the mini-chart plots
  //      (`<TrendDescriptorCaption>`), instead of the old static
  //      "Awaiting more data" hint. That component itself falls back to
  //      the real empty hint only when the series is genuinely too sparse.
  const renderLegacyCaption = (config: TrendChartConfig) => {
    const annotationKey = config.annotationKey as TrendAnnotationKey;
    const annotation = annotationFor(annotationKey);
    const status = statusFor(annotation);

    // Tiers 1 + 2 — keep the existing pending shimmer / AI prose path.
    if (status === "pending" || status === "generated") {
      return (
        <TrendAnnotation
          metric={annotationKey}
          annotation={annotation}
          confidence={confidence?.[annotationKey]}
          status={status}
        />
      );
    }

    // Tier 3 — deterministic descriptor (falls through to the real empty
    // hint internally when the series is too sparse).
    return (
      <TrendDescriptorCaption
        metric={config.metric}
        emptyMetric={annotationKey}
        kind={config.kind === "mood" ? "mood" : "numeric"}
        types={config.types}
      />
    );
  };

  return (
    <section
      data-slot="trends-row"
      aria-label={t("insights.trendsRow.title")}
      className="space-y-3"
    >
      <SectionHeading
        icon={TrendingUp}
        title={t("insights.trendsRow.title")}
        subtitle={t("insights.trendsRow.subtitle")}
      />
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
          fixed-height shell so the series paint at the same vertical
          position; the annotation slot clamps via `<TrendAnnotation>`
          so long captions can't pull the row taller than the design
          constant.

          v1.8.5 — the cards are now rendered from the dynamic chart
          set instead of three hard-coded tiles. The grid + slot
          contract is unchanged; the card count tracks the briefing
          (capped at three so the 3-up template still holds). */}
      <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-3 md:items-stretch">
        {charts.map((config) => {
          const title = t(config.titleKey);
          return (
            <div
              key={config.metric}
              data-slot="trends-row-card"
              data-metric={config.metric}
              // v1.15.12 D1 — drop the `md:min-h-[300px]` floor. The chart
              // slot is a fixed 180 px and the caption is `line-clamp-3`, so a
              // card's natural height tops out around 270 px; the 300 px floor
              // padded ~30 px of dead space below every caption, which read as
              // an oversized Trends→Rückblick seam (the `space-y-6` gap is even,
              // the empty card tail was the culprit). `auto-rows-fr` +
              // `md:items-stretch` on the grid already pin every card to a
              // single baseline, and the fixed chart slot aligns the charts, so
              // the floor was redundant. Cards now size to content.
              className="flex h-full flex-col gap-2"
            >
              {/* v1.4.28 R3c-Insights — fixed chart slot. The mini
                  chart paints its own band; this wrapper pins the
                  total chart-envelope height so every tile lines up on
                  a single baseline regardless of the chart kind.

                  v1.11.4 item I — the slot is now the hard bound for
                  every chart kind. Two changes close the mood-card
                  overflow (its categorical y-axis + date x-axis bled
                  the tick labels out the bottom, overlapping the
                  caption, and the `<Card>` shell ran taller than the
                  flat `<HealthChart mini>` siblings):

                    - `overflow-hidden` clips anything the inner chart
                      paints past the 180 px envelope, so a stray axis
                      label can never escape into the caption row.
                    - `[--chart-height:120px]` drives BOTH mini charts'
                      internal band (they read `h-[var(--chart-height,
                      140px)]`) down to a shared 120 px. 120 px + the
                      mood `<Card>` header/padding chrome (~36 px) + the
                      x-axis tick band (~16 px) lands inside the 180 px
                      envelope, so the mood card no longer overflows and
                      the three tiles share one chart-band baseline. No
                      chart-component edit, no token churn — the bound
                      lives entirely on this slot. */}
              <div
                data-slot="trends-row-chart-slot"
                // v1.22.0 — the slot height is responsive to the viewport so a
                // rotated phone doesn't lose half the screen to a fixed 180 px
                // band. `clamp(140px,32vh,180px)` pins the same 180 px envelope
                // on desktop + portrait (where 32vh clears 180 px) and only
                // shrinks toward the 140 px floor on short landscape viewports.
                // `overflow-hidden` already clips any stray axis label, so the
                // tighter band stays tidy.
                className="h-[clamp(140px,32vh,180px)] shrink-0 overflow-hidden [--chart-height:120px]"
              >
                <MetricChart config={config} title={title} />
              </div>
              {config.annotationKey ? (
                renderLegacyCaption(config)
              ) : (
                // v1.8.6 W8 — additive metrics carry no advisor
                // annotation. Paint the metric's standard one-line
                // description so the card is never caption-less.
                // v1.8.7 W-E — render that description through the same
                // `<TrendCaptionCard>` shell the advisor caption uses, so
                // the fallback caption shares the bordered card, Sparkles
                // affordance, and `text-foreground` typography rather than
                // standing out as a plain muted line.
                <TrendCaptionCard
                  slot="trends-row-caption"
                  metric={config.metric}
                  text={t(config.captionKey)}
                />
              )}
              {/* v1.18.6 — drill-in link to the metric's detail page. The
                  overview charted these metrics but never offered a way INTO
                  their detail pages — notably the steps page, which exists and
                  is used but was unreachable from Insights. The link sits below
                  the caption so the chart keeps its own interactions. */}
              {config.detailHref ? (
                <Link
                  href={config.detailHref}
                  data-slot="trends-row-detail-link"
                  data-metric={config.metric}
                  className="text-muted-foreground hover:text-foreground mt-auto inline-flex items-center gap-1 self-start text-xs font-medium transition-colors"
                >
                  {t("insights.trendsRow.viewDetail", { metric: title })}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
