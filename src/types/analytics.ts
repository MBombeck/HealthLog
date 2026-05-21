/**
 * Shared analytics DTOs.
 *
 * Pre-v1.4.41, three structurally-distinct `interface AnalyticsData {…}`
 * declarations lived inline in `src/app/page.tsx` (dashboard), in
 * `src/app/insights/page.tsx` (insights-mother), and in
 * `src/components/onboarding/getting-started-checklist.tsx` (checklist).
 * The names collided across files even though the shapes did not, which
 * made "where does the analytics payload live?" un-discoverable.
 *
 * v1.4.41 W-ORG (org-audit rec #2) hoists every shape into this module
 * under a name that says which surface it describes. The header below
 * documents the relationships so a future contract change has one
 * place to land.
 *
 *   - `SubPageAnalyticsData` — slim shape consumed by every
 *     `/insights/<metric>/page.tsx`; just `summaries`.
 *   - `DashboardAnalyticsData` — dashboard root (`src/app/page.tsx`);
 *     carries the `bpInTargetPct*` aggregates the sub-pages don't use
 *     plus `glucoseByContext` and `lastSeenByType`.
 *   - `InsightsAnalyticsData` — insights mother page
 *     (`src/app/insights/page.tsx`); carries `correlations` +
 *     `healthScore` blocks that the sub-pages also don't use.
 *   - `ChecklistAnalyticsData` — onboarding checklist component;
 *     ultra-loose shape that only checks per-type `count` for
 *     "do you have any data of this kind yet?".
 *
 * NOTE: we keep four shapes (rather than collapsing into one with
 * everything optional) because the call-sites use TypeScript control
 * flow to *demand* the fields they need — the slim sub-pages should
 * not be able to type-pass an access to `bpInTargetPct`, the checklist
 * should not be able to read `correlations`, and the dashboard should
 * not be reading `healthScore` without going through the insights
 * surface. Three named shapes capture the contract; one swiss-army
 * shape loses it.
 */
import type { DataSummary } from "@/lib/analytics/trends";
import type { CorrelationResult } from "@/lib/insights/correlations";

/** Shape consumed by every `/insights/<metric>/page.tsx`. */
export interface SubPageAnalyticsData {
  /** `Record<MeasurementType, DataSummary>` — sentinel value for "not loaded yet" is `undefined`. */
  summaries: Record<string, DataSummary>;
}

/**
 * Shape consumed by the dashboard root (`src/app/page.tsx`).
 *
 * `bpInTargetPct*` drive the BD-Zielbereich tile; `lastSeenByType`
 * keeps stale-but-still-relevant tiles visible with an explicit
 * "Letzter Wert vor …" caption.
 */
export interface DashboardAnalyticsData {
  summaries: Record<string, DataSummary>;
  bpInTargetPct: number | null;
  /**
   * v1.4.18 A1 — share of paired BP readings inside target over the
   * last 7 / 30 days. Drive the BD-Zielbereich tile's `7T:` / `30T:`
   * sub-values; render "—" when the field is null (no paired readings
   * in the window).
   */
  bpInTargetPct7d?: number | null;
  bpInTargetPct30d?: number | null;
  /**
   * v1.4.22 A1 — long-arc all-time aggregate. After the headline
   * re-anchor to last-30-days the all-time number lives as a sub-value
   * on the BD-Zielbereich tile (alongside `7d` and `30d`).
   */
  bpInTargetPctAllTime?: number | null;
  /**
   * v1.4.22 W5 reconcile (Code-H2) — period-aligned prior-window
   * pcts. The BD-Zielbereich tile's comparison-overlay caption picks
   * `priorMonth` for `comparisonBaseline === "lastMonth"` and
   * `priorYear` for `lastYear` so the rendered "Δ X% vs. last month"
   * stays honest. Null when the prior window has no paired readings.
   */
  bpInTargetPctPriorMonth?: number | null;
  bpInTargetPctPriorYear?: number | null;
  glucoseByContext?: Record<string, DataSummary>;
  /**
   * v1.4.34 IW-B — per-type freshness map from `/api/analytics`. The
   * tile-strip helper reads `lastSeenByType[type]?.daysAgo` and forwards
   * it to each `<TrendCard staleDays>` so a metric the user hasn't
   * logged in a while keeps its tile visible (with an explicit
   * "Letzter Wert vor …" caption) instead of disappearing.
   */
  lastSeenByType?: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  >;
}

/**
 * Shape consumed by the insights mother page
 * (`src/app/insights/page.tsx`). Carries the correlation + health-score
 * blocks the sub-pages don't use.
 */
export interface InsightsAnalyticsData {
  summaries: Record<string, DataSummary>;
  correlations?: {
    bpCompliance: CorrelationResult;
    moodPulse: CorrelationResult;
    weightWeekday: CorrelationResult;
  } | null;
  healthScore?: {
    score: number;
    band: "green" | "yellow" | "red";
    components: {
      // v1.4.25 W8e — the optional `source`/`asOf` slots feed the
      // provenance accordion. Older clients reading this payload
      // happily ignore the extras (additive contract).
      bp: {
        value: number | null;
        weight: number;
        source?: "manual" | "withings" | "appleHealth" | "mixed" | "none";
        asOf?: string;
      };
      weight: {
        value: number | null;
        weight: number;
        source?: "manual" | "withings" | "appleHealth" | "mixed" | "none";
        asOf?: string;
      };
      mood: {
        value: number | null;
        weight: number;
        source?: "manual" | "withings" | "appleHealth" | "mixed" | "none";
        asOf?: string;
      };
      compliance: {
        value: number | null;
        weight: number;
        source?: "manual" | "withings" | "appleHealth" | "mixed" | "none";
        asOf?: string;
      };
    };
    delta: number | null;
  } | null;
}

/**
 * Shape consumed by the onboarding checklist
 * (`src/components/onboarding/getting-started-checklist.tsx`).
 * Intentionally loose — the checklist only asks
 * "does any per-type bucket have a non-zero count?".
 */
export interface ChecklistAnalyticsData {
  summaries?: Record<string, { count?: number } | undefined>;
}
