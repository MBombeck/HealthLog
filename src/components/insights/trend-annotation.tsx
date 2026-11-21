"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import {
  computeTrendDescriptor,
  moodDescriptorCopy,
  numericDescriptorCopy,
  MOOD_DESCRIPTOR_CONFIG,
  TREND_SLOT_DESCRIPTOR_META,
  type TrendDescriptorPoint,
} from "@/lib/insights/trend-descriptor";
import { CONFIDENCE_TONE, ScorePill } from "@/components/ui/score-pill";
import { apiGet } from "@/lib/api/api-fetch";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { dayKeyToTimestamp } from "@/components/charts/health-chart/series-math";

/**
 * v1.4.20 — single-sentence AI annotation rendered directly
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
 * v1.4.36 — render-state contract (`status`). Pre-fix the
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

/**
 * Shared presentational shell for a filled trend caption — the bordered
 * card + Sparkles affordance + `text-foreground` prose treatment. Both
 * the advisor-authored annotation (the legacy triple) and the additive
 * metric's standard description (`captionKey`) render through this shell
 * so the Trends row reads with a single typographic rhythm and the two
 * paths can't drift apart. `children` carries the line(s) below the
 * caption prose (e.g. a confidence chip). `slot` / `metric` pass through
 * to the wrapper's `data-*` hooks so each call site keeps its own
 * test-stable selector.
 */
export function TrendCaptionCard({
  text,
  slot,
  metric,
  children,
}: {
  text: string;
  slot: string;
  metric: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-slot={slot}
      data-metric={metric}
      className="border-border/60 bg-card/40 flex items-start gap-2 rounded-md border p-3"
    >
      <Sparkles
        className="text-primary mt-0.5 h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">
        {/* v1.4.28 — `line-clamp-3` bounds caption
            variance (FB-K2). A 1-sentence BP annotation paints
            ~3 lines wrapped; a 4-line mood annotation used to push
            the cell taller, which `auto-rows-fr` propagated to
            every neighbour cell. With the clamp the longest
            annotation ends with an ellipsis at 3 lines and the
            row stays at a single visual rhythm. */}
        <p className="text-foreground line-clamp-3 text-xs leading-snug">
          {text}
        </p>
        {children}
      </div>
    </div>
  );
}

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

  // v1.4.36 — render-state contract. When `status` is supplied
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
        <Skeleton className="h-2.5 w-11/12 rounded" />
        <Skeleton className="h-2.5 w-9/12 rounded" />
        <Skeleton className="h-2.5 w-7/12 rounded" />
      </div>
    );
  }

  if (resolvedStatus === "needs_data" || !annotation) {
    return (
      <p
        data-slot="trend-annotation-empty"
        data-metric={metric}
        // v1.4.28 — `line-clamp-3` on both states. The
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
    <TrendCaptionCard
      slot="trend-annotation"
      metric={metric}
      text={stripChartTokens(annotation)}
    >
      {confidence ? (
        <ScorePill
          data-slot="trend-annotation-confidence"
          tone={CONFIDENCE_TONE[confidence]}
        >
          {t(CONFIDENCE_LABEL_KEY[confidence])}
        </ScorePill>
      ) : null}
    </TrendCaptionCard>
  );
}

// ── v1.11.4 item J — deterministic Trends-row caption ──────────────────

/** Trailing window the descriptor reads. Matches the Trends row's
 *  "Last 30 days at a glance" subtitle. */
const DESCRIPTOR_WINDOW_DAYS = 30;

interface MeasurementApiRow {
  value: number;
  measuredAt: string;
}

interface MoodAnalyticsRow {
  date: string;
  score: number;
}

/**
 * Caption that prefers a deterministic, rule-based trend descriptor over
 * the static "Awaiting more data" hint.
 *
 * Precedence (item J):
 *   1. `pending` → shimmer (advisor in flight) — handled by the parent,
 *      which keeps rendering `<TrendAnnotation status="pending">` so this
 *      component only mounts on the resolved path.
 *   2. advisor annotation present → the parent renders `<TrendAnnotation>`
 *      with the AI sentence; this component is not mounted.
 *   3. NO advisor annotation but a computable series → this component
 *      shows the deterministic descriptor (direction + magnitude over the
 *      window) derived from the SAME series the mini-chart plots.
 *   4. series too sparse (< 2 points) → the real "not enough data yet"
 *      empty hint, keeping the `trend-annotation-empty` contract so the
 *      row reads honestly when there genuinely isn't a trend to describe.
 *
 * Tone is observational + neutral by construction (see
 * `trend-descriptor.ts`): direction + magnitude only, no value judgement.
 */
export function TrendDescriptorCaption({
  metric,
  emptyMetric,
  kind,
  types,
}: {
  /** Stable slot id (`TrendChartConfig.metric`) — drives the descriptor
   *  config + the `data-metric` test hook. */
  metric: string;
  /** Which empty-state copy to show when the series is too sparse. */
  emptyMetric: TrendAnnotationProps["metric"];
  /** `mood` reads the categorical mood analytics; everything else reads
   *  the numeric measurement series for its primary type. */
  kind: "mood" | "numeric";
  /** Measurement types for the numeric path. The descriptor reads the
   *  FIRST type (the chart's primary line, e.g. systolic for BP). */
  types: string[];
}) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { toDisplay, toDisplayDelta, unitFor } = useUnitDisplay();

  const isMood = kind === "mood";
  const primaryType = types[0] ?? "";

  // Mood reuses the exact `moodAnalytics()` cache slot the MoodChart
  // already populates, so the descriptor reads from the same series with
  // zero extra round-trip. Numeric metrics take a small, dedicated
  // 30-day daily-aggregate read keyed under `trend-series` (bounded to
  // ≤ 30 rollup rows) rather than re-deriving the chart's heavyweight,
  // state-dependent `chart-data` key.
  const moodQuery = useQuery({
    queryKey: queryKeys.moodAnalytics(),
    queryFn: async () => {
      return apiGet<{ entries: MoodAnalyticsRow[] }>("/api/mood/analytics");
    },
    enabled: isAuthenticated && isMood,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const numericQuery = useQuery({
    queryKey: queryKeys.insightsTrendSeries(primaryType),
    queryFn: async () => {
      const to = new Date();
      const from = new Date(to.getTime() - DESCRIPTOR_WINDOW_DAYS * 86_400_000);
      const params = new URLSearchParams({
        type: primaryType,
        sortBy: "measuredAt",
        sortDir: "asc",
        from: from.toISOString(),
        to: to.toISOString(),
        limit: "5000",
        aggregate: "daily",
        source: "rollup",
      });
      const data = await apiGet<{ measurements?: MeasurementApiRow[] }>(
        `/api/measurements?${params}`,
      );
      return data?.measurements ?? [];
    },
    enabled: isAuthenticated && !isMood && primaryType.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const points = useMemo<TrendDescriptorPoint[]>(() => {
    if (isMood) {
      // Mood analytics returns the full history; the MoodChart mini
      // defaults to its trailing 30-point window, so mirror that here by
      // taking the last `DESCRIPTOR_WINDOW_DAYS` daily entries rather than
      // a wall-clock date filter (keeps the memo pure — no `Date.now()`).
      const entries = moodQuery.data?.entries ?? [];
      return entries.slice(-DESCRIPTOR_WINDOW_DAYS).map((row) => ({
        timestamp: dayKeyToTimestamp(row.date),
        value: row.score,
      }));
    }
    // The numeric series is already server-bounded to the trailing
    // 30-day window by the fetch, so every returned row is in-window.
    // Described in the reader's unit, the same one the chart above plots.
    return (numericQuery.data ?? []).map((row) => ({
      timestamp: new Date(row.measuredAt).getTime(),
      value: toDisplay(primaryType, row.value),
    }));
  }, [isMood, moodQuery.data, numericQuery.data, toDisplay, primaryType]);

  const descriptor = useMemo(() => {
    const meta = TREND_SLOT_DESCRIPTOR_META[metric];
    // A slot that converts its series converts its noise floor with it: the
    // floor is declared canonically and is a difference (factor only).
    const config = isMood
      ? MOOD_DESCRIPTOR_CONFIG
      : meta?.unitType
        ? {
            ...meta.config,
            absoluteFloor: toDisplayDelta(
              meta.unitType,
              meta.config.absoluteFloor,
            ),
          }
        : meta?.config;
    return computeTrendDescriptor(points, config);
  }, [points, isMood, metric, toDisplayDelta]);

  // Tier 4 — genuinely too few points (also covers the in-flight window
  // before the small series lands). Surface the real empty hint so the
  // caption reads honestly when there is no trend to describe. The
  // advisor-pending shimmer is the parent's job; this fallback path only
  // mounts when the advisor produced no annotation, so a brief empty
  // hint during the small series fetch is the right transient state.
  if (!descriptor) {
    return (
      <p
        data-slot="trend-annotation-empty"
        data-metric={metric}
        className="text-muted-foreground line-clamp-3 text-xs italic"
      >
        {t(EMPTY_KEY[emptyMetric])}
      </p>
    );
  }

  // Tier 3 — deterministic descriptor. Mood uses the categorical
  // "improved / declined / stable" copy; every numeric metric uses the
  // "{delta}{unit}" template. `numericDescriptorCopy` returns null for a
  // slot with no numeric meta, in which case we fall back to mood-style
  // copy defensively (should not happen for the legacy triple).
  const copy = isMood
    ? moodDescriptorCopy(descriptor)
    : (numericDescriptorCopy(metric, descriptor, unitFor) ??
      moodDescriptorCopy(descriptor));

  return (
    <TrendCaptionCard
      slot="trend-annotation-descriptor"
      metric={metric}
      text={t(copy.key, copy.params)}
    />
  );
}
