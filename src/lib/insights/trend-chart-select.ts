import type { DailyBriefing, DailyBriefingKeyFinding } from "@/lib/ai/schema";

/**
 * v1.8.5 — derive the Insights overview "Trends" chart set from the
 * daily briefing.
 *
 * The Trends row used to be a fixed BP / weight / mood triple. The
 * briefing already surfaces the day's load-bearing findings (each one
 * tied to a `sourceMetric`), so the row should chart exactly those
 * flagged metrics — in the briefing's own priority order, deduped,
 * capped, with the legacy triple as the fallback when the briefing is
 * empty or unavailable.
 *
 * This module is the pure mapping layer:
 *   - `TREND_CHART_CONFIG` maps every briefing `sourceMetric` to a
 *     concrete chart descriptor (which measurement series to plot, its
 *     colour + unit + i18n title key, and whether the advisor supplies
 *     a one-sentence annotation for it).
 *   - `selectTrendCharts(briefing, opts)` walks the briefing findings,
 *     resolves each to a chart slot, dedupes, caps, and falls back to
 *     the default triple when nothing usable surfaces.
 *
 * Kept free of React/Recharts so the selection logic is unit-testable
 * in isolation and the renderer stays a thin consumer.
 */

/**
 * The annotation key the advisor populates for a slot, when one exists.
 * Only the legacy triple (bp / weight / mood) carries AI annotations in
 * `trendAnnotations`; every additive metric renders chart-only.
 */
export type TrendAnnotationKey = "bp" | "weight" | "mood";

/**
 * How the slot's chart is rendered. `mood` resolves to the bespoke
 * `<MoodChart>` (self-fetching, no measurement-type series); every
 * other slot resolves to `<HealthChart>` driven by `types`.
 */
export type TrendChartKind = "health-chart" | "mood";

export interface TrendChartConfig {
  /** Stable slot id — used as the `data-metric` attribute + React key. */
  metric: string;
  /** Which chart component to mount. */
  kind: TrendChartKind;
  /**
   * Measurement series for the `health-chart` kind. Empty for `mood`
   * (the mood chart self-fetches its own aggregate).
   */
  types: string[];
  /** Recharts stroke colours, positionally matched to `types`. */
  colors: string[];
  /** Display unit (chart legend / tooltip). */
  unit?: string;
  /** Y-axis unit label when it differs from the value unit. */
  yAxisUnit?: string;
  /** i18n key for the chart title (`charts.*`). */
  titleKey: string;
  /**
   * i18n key for the slot's standard one-line description
   * (`insights.trendsRow.caption.*`). Every slot carries one so a card
   * never paints caption-less. For the legacy triple it is the
   * fallback the renderer shows when the advisor supplies no
   * annotation; for additive metrics it is the only caption (those
   * slots carry no advisor annotation).
   */
  captionKey: string;
  /**
   * When set, the slot carries an advisor annotation under the chart
   * and uses the typed `<TrendAnnotation>` empty-state copy. Omitted
   * for additive metrics, which fall back to {@link captionKey}.
   */
  annotationKey?: TrendAnnotationKey;
  /**
   * Routed detail page for the metric (`/insights/<slug>`), when one exists.
   * The Trends-row card links to it so the overview can drill into the metric
   * — notably the one cross-link to `/insights/steps`, which the overview
   * otherwise never offered despite the steps page existing and being used.
   * Omitted for slots with no dedicated page (mood routes through its own
   * surface; metabolic re-frames live on their composite pages).
   */
  detailHref?: string;
}

/**
 * Per-`sourceMetric` chart descriptor. `null` marks a metric that has
 * no standalone trend chart in this row (compliance + the GLP-1
 * plateau finding are adherence-context observations, not a single
 * plottable series), so a finding on that metric is skipped during
 * selection and the next finding fills the slot instead.
 *
 * Colours + units mirror the dedicated sub-pages so a metric looks
 * identical whether the user lands on it here or on `/insights/<slug>`.
 */
export const TREND_CHART_CONFIG: Record<
  DailyBriefingKeyFinding["sourceMetric"],
  TrendChartConfig | null
> = {
  bp: {
    metric: "bp",
    kind: "health-chart",
    types: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
    colors: ["var(--chart-3)", "var(--chart-4)"],
    unit: "mmHg",
    yAxisUnit: "mmHg",
    titleKey: "charts.bloodPressure",
    captionKey: "insights.trendsRow.caption.bp",
    annotationKey: "bp",
    detailHref: "/insights/blood-pressure",
  },
  weight: {
    metric: "weight",
    kind: "health-chart",
    types: ["WEIGHT"],
    colors: ["var(--chart-1)"],
    unit: "kg",
    titleKey: "charts.weight",
    captionKey: "insights.trendsRow.caption.weight",
    annotationKey: "weight",
    detailHref: "/insights/weight",
  },
  pulse: {
    metric: "pulse",
    kind: "health-chart",
    types: ["PULSE"],
    colors: ["var(--chart-2)"],
    unit: "bpm",
    yAxisUnit: "bpm",
    titleKey: "charts.pulse",
    captionKey: "insights.trendsRow.caption.pulse",
    detailHref: "/insights/pulse",
  },
  mood: {
    metric: "mood",
    kind: "mood",
    types: [],
    colors: [],
    titleKey: "charts.mood",
    captionKey: "insights.trendsRow.caption.mood",
    annotationKey: "mood",
    detailHref: "/insights/mood",
  },
  sleep: {
    metric: "sleep",
    kind: "health-chart",
    types: ["SLEEP_DURATION"],
    colors: ["var(--chart-4)"],
    unit: "h",
    yAxisUnit: "h",
    titleKey: "charts.sleep",
    captionKey: "insights.trendsRow.caption.sleep",
    detailHref: "/insights/sleep",
  },
  steps: {
    metric: "steps",
    kind: "health-chart",
    types: ["ACTIVITY_STEPS"],
    colors: ["var(--chart-2)"],
    unit: "steps",
    yAxisUnit: "steps",
    titleKey: "charts.steps",
    captionKey: "insights.trendsRow.caption.steps",
    detailHref: "/insights/steps",
  },
  hrv: {
    metric: "hrv",
    kind: "health-chart",
    types: ["HEART_RATE_VARIABILITY"],
    colors: ["var(--chart-1)"],
    unit: "ms",
    yAxisUnit: "ms",
    titleKey: "charts.hrv",
    captionKey: "insights.trendsRow.caption.hrv",
    detailHref: "/insights/hrv",
  },
  resting_hr: {
    metric: "resting_hr",
    kind: "health-chart",
    types: ["RESTING_HEART_RATE"],
    colors: ["var(--chart-3)"],
    unit: "bpm",
    yAxisUnit: "bpm",
    titleKey: "charts.restingHeartRate",
    captionKey: "insights.trendsRow.caption.resting_hr",
    detailHref: "/insights/resting-pulse",
  },
  active_energy: {
    metric: "active_energy",
    kind: "health-chart",
    types: ["ACTIVE_ENERGY_BURNED"],
    colors: ["var(--chart-5)"],
    unit: "kcal",
    yAxisUnit: "kcal",
    titleKey: "charts.activeEnergy",
    captionKey: "insights.trendsRow.caption.active_energy",
    detailHref: "/insights/active-energy",
  },
  flights: {
    metric: "flights",
    kind: "health-chart",
    types: ["FLIGHTS_CLIMBED"],
    colors: ["var(--dracula-yellow)"],
    unit: "flights",
    yAxisUnit: "flights",
    titleKey: "charts.flights",
    captionKey: "insights.trendsRow.caption.flights",
    detailHref: "/insights/flights-climbed",
  },
  distance: {
    metric: "distance",
    kind: "health-chart",
    types: ["WALKING_RUNNING_DISTANCE"],
    colors: ["var(--chart-4)"],
    unit: "km",
    yAxisUnit: "km",
    titleKey: "charts.distance",
    captionKey: "insights.trendsRow.caption.distance",
    detailHref: "/insights/walking-distance",
  },
  vo2_max: {
    metric: "vo2_max",
    kind: "health-chart",
    types: ["VO2_MAX"],
    colors: ["var(--chart-2)"],
    unit: "mL/kg·min",
    yAxisUnit: "mL/kg·min",
    titleKey: "charts.vo2Max",
    captionKey: "insights.trendsRow.caption.vo2_max",
    detailHref: "/insights/cardio-fitness",
  },
  body_temp: {
    metric: "body_temp",
    kind: "health-chart",
    types: ["BODY_TEMPERATURE"],
    colors: ["var(--destructive)"],
    unit: "°C",
    yAxisUnit: "°C",
    titleKey: "charts.bodyTemperature",
    captionKey: "insights.trendsRow.caption.body_temp",
    detailHref: "/insights/body-temperature",
  },
  // Adherence-context findings — no single plottable trend series in
  // this row. A finding on one of these is skipped during selection so
  // the next finding (or the default fallback) takes the slot.
  compliance: null,
  glp1_plateau: null,
  // ── v1.10.0 derived-wellness additive ──
  // The wellness scores are 0–100 composites whose deeper view is the
  // score-anatomy page, not a single plottable trend series in this row.
  readiness: null,
  recovery: null,
};

/**
 * Default chart set when the briefing is empty / unavailable. Mirrors
 * the legacy fixed Trends triple so a cold mount, a web-only account
 * with no findings, or a pre-briefing payload keeps the familiar
 * BP / weight / mood row.
 */
export const DEFAULT_TREND_METRICS: ReadonlyArray<
  DailyBriefingKeyFinding["sourceMetric"]
> = ["bp", "weight", "mood"];

/** Max charts the row renders. Three keeps the equal-height 3-up grid. */
export const DEFAULT_TREND_CHART_CAP = 3;

export interface SelectTrendChartsOptions {
  /** Max number of charts to return. Defaults to {@link DEFAULT_TREND_CHART_CAP}. */
  cap?: number;
  /**
   * Metrics whose module is switched off. They are skipped on both the
   * briefing path and the fallback triple, so a disabled module never
   * charts on the overview.
   */
  hiddenMetrics?: ReadonlyArray<DailyBriefingKeyFinding["sourceMetric"]>;
}

function configsFor(
  metrics: ReadonlyArray<DailyBriefingKeyFinding["sourceMetric"]>,
  cap: number,
  hidden: ReadonlySet<string>,
): TrendChartConfig[] {
  const seen = new Set<string>();
  const out: TrendChartConfig[] = [];
  for (const metric of metrics) {
    if (out.length >= cap) break;
    if (hidden.has(metric)) continue; // module switched off
    const config = TREND_CHART_CONFIG[metric];
    if (!config) continue; // metric has no standalone trend chart
    if (seen.has(config.metric)) continue; // dedupe
    seen.add(config.metric);
    out.push(config);
  }
  return out;
}

/**
 * Resolve the Trends-row chart set from a daily briefing.
 *
 * Order follows the briefing's own `keyFindings` ordering (the model
 * emits the most load-bearing finding first). Metrics are deduped on
 * their chart slot and the result is capped. When the briefing is
 * `null`, carries no findings, or every finding maps to a
 * chartless metric, the default BP / weight / mood triple is returned
 * so the row never paints empty.
 */
export function selectTrendCharts(
  briefing: DailyBriefing | null | undefined,
  options: SelectTrendChartsOptions = {},
): TrendChartConfig[] {
  const cap = Math.max(1, options.cap ?? DEFAULT_TREND_CHART_CAP);
  const hidden = new Set<string>(options.hiddenMetrics ?? []);

  const findingMetrics =
    briefing?.keyFindings?.map((f) => f.sourceMetric) ?? [];
  const fromBriefing = configsFor(findingMetrics, cap, hidden);

  if (fromBriefing.length > 0) {
    return fromBriefing;
  }

  return configsFor(DEFAULT_TREND_METRICS, cap, hidden);
}
