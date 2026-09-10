/**
 * v1.18.6 — dashboard first-paint / skeleton-reservation gates.
 *
 * Extracted verbatim from `src/app/page.tsx` so the page component reads
 * as a thinner orchestrator and these pure helpers (already unit-tested)
 * live in one cohesive module. `page.tsx` re-exports them so the existing
 * `../page` test imports stay valid.
 */
import type { DataSummary } from "@/lib/analytics/trends";
import {
  GLUCOSE_CONTEXT_BUCKETS,
  type GlucoseContextBucket,
} from "@/lib/glucose";
import type { DashboardLayout } from "@/lib/dashboard-layout";

/**
 * v1.7.0 — first-paint gate for the dashboard tile strip.
 *
 * `primaryLoading` must come from whichever query actually drives the
 * tiles: the snapshot cell by default, the slim analytics cell when
 * `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false`. A disabled TanStack query reports
 * `isLoading: false` (idle fetch status), so keying off the wrong
 * source flashes the empty state for the whole fetch. Pure + exported
 * so the gate has direct unit coverage without mounting the page.
 */
export function resolveDashboardFirstPaintGate(input: {
  trendCardCount: number;
  chartCount: number;
  configuredTileCount: number;
  primaryLoading: boolean;
}): { showTileStripSkeleton: boolean; showEmptyState: boolean } {
  const showTileStripSkeleton =
    input.trendCardCount === 0 &&
    input.primaryLoading &&
    input.configuredTileCount > 0;
  const showEmptyState =
    input.trendCardCount === 0 &&
    input.chartCount === 0 &&
    !showTileStripSkeleton &&
    !input.primaryLoading;
  return { showTileStripSkeleton, showEmptyState };
}

/**
 * v1.16.8 — widget ids that actually paint a tile in the strip on the
 * web dashboard, mirrored from the per-id render blocks below.
 * `medications` / `recentWorkouts` / `achievements` carry NO strip tile
 * (chart-row cards only), and the iOS-pin-only ids have no web render
 * path at all — counting any of them over-reserved the loading
 * silhouette and made the strip reshuffle when the data landed.
 */
const TILE_CAPABLE_WIDGET_IDS = new Set<string>([
  "weight",
  "bp",
  "pulse",
  "bodyFat",
  "mood",
  "sleep",
  "steps",
  "glucose",
  "bpInTarget",
  "vo2Max",
  // v1.28.52 — vitals + body-composition strip tiles: each paints one
  // strip card and self-gates on having a sample of its MeasurementType.
  "hrv",
  "oxygenSaturation",
  "respiratoryRate",
  "wristTemperature",
  "muscleMass",
  "totalBodyWater",
  "boneMass",
  // v1.29 — fluid intake strip tile: paints one strip card and self-gates
  // on having a NUTRIENT_WATER sample.
  "waterIntake",
]);

/**
 * v1.16.8 — silhouette count for the tile-strip skeleton: one card per
 * tile-capable, tile-visible widget. `bp` paints TWO tiles (sys + dia,
 * see the render block below) so it counts double; `glucose` can fan
 * out to one tile per logged context, but the contexts are unknown
 * until the snapshot lands, so it reserves one card (the sane floor).
 * Pure + exported for direct unit coverage.
 */
export function resolveConfiguredTileCount(layout: DashboardLayout): number {
  let count = 0;
  for (const widget of layout.widgets) {
    if (!TILE_CAPABLE_WIDGET_IDS.has(widget.id)) continue;
    if (!(widget.tileVisible ?? widget.visible)) continue;
    count += widget.id === "bp" ? 2 : 1;
  }
  return count;
}

/**
 * v1.16.8 — widget ids with a chart-row surface on the web dashboard,
 * mirrored from the `charts[]` entries below. The achievements +
 * recent-workouts cards stay out: they self-skeleton, carry no
 * chart-shaped footprint, and gate on `layoutResolved`.
 */
const CHART_CAPABLE_WIDGET_IDS = new Set<string>([
  "weight",
  "bp",
  "pulse",
  "bodyFat",
  "mood",
  "sleep",
  "steps",
  "medications",
  // v1.18.2 — Vorsorge preventive-care summary card (chart-row only).
  "vorsorge",
]);

/**
 * v1.16.8 — expected chart-row card count while the snapshot is still
 * in flight. Every chart gate below needs `count > 0` from snapshot
 * data, so the cold page used to render NO chart row at all and then
 * grow ~1000 px when the snapshot landed. The best available signal
 * before data arrives is the layout config (the user's saved layout
 * when cached, the default otherwise): one card per chart-visible
 * widget, plus the BMI card that rides the weight gate when the
 * profile carries a height. Pure + exported for direct unit coverage.
 */
export function resolveChartRowPlaceholderCount(
  layout: DashboardLayout,
  opts?: { hasHeightCm?: boolean },
): number {
  let count = 0;
  for (const widget of layout.widgets) {
    if (!CHART_CAPABLE_WIDGET_IDS.has(widget.id)) continue;
    if (!widget.visible) continue;
    count += 1;
    if (widget.id === "weight" && opts?.hasHeightCm) count += 1;
  }
  return count;
}

/** The two measurement types the HRV surface reads, primary first. */
export type HrvSummaryType = "HEART_RATE_VARIABILITY" | "HRV_RMSSD";

/**
 * The i18n key naming each HRV series. One key per series, never a base
 * label with the measure concatenated on: the tile label paints truncated,
 * uppercase and on a single line, so an appended marker is the first thing
 * dropped in the longer locales — and the marker is the part a reader needs
 * to tell a 40 ms RMSSD night from a collapsed SDNN one. Both keys are
 * translated in all seven locales.
 */
export const HRV_LABEL_KEY: Record<HrvSummaryType, string> = {
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  HRV_RMSSD: "measurements.typeHrvRmssd",
};

/**
 * Which HRV series backs the dashboard tile.
 *
 * HRV is stored under two types and they are not the same measure: Apple
 * Health / Fitbit / Google Health write SDNN as `HEART_RATE_VARIABILITY`,
 * while Oura / Polar / WHOOP — and a Garmin-style feed pushed in through a
 * bridge — write nightly RMSSD as `HRV_RMSSD`. Every other HRV surface
 * already unions the two: `/insights/hrv` passes `fallbackMeasurementType`
 * (`app/insights/hrv/page.tsx`), the Coach resolves both
 * (`COACH_SOURCE_MEASUREMENT_TYPES.hrv`), and the MCP reads swap through
 * `withHrvFallback` (`lib/mcp/rich-reads.ts`). The catalogue entry in
 * `lib/insights/sub-page-metric.ts` even says listing both is what "keeps the
 * tab, pill, and dashboard tile lit whichever source the user has" — but the
 * tile read SDNN alone, so an RMSSD-only account got a Settings toggle that
 * silently rendered nothing while the insights page charted the data.
 *
 * Same rule as `withHrvFallback`: the primary wins whenever it has ANY rows,
 * and the fallback is taken only when it has none. Deliberately not a merge —
 * SDNN and RMSSD share `ms` but measure different things, so blending them
 * would invent a number no device reported. That is why the caller is handed
 * the winning `type` back: the freshness caption has to read the series being
 * shown, and the label has to name the measure when it is not SDNN.
 *
 * Module gating belongs upstream and must NOT be repeated here. `HRV_RMSSD`
 * is a `recovery`-owned type, so `SUMMARY_TYPE_MODULE` carries it and
 * `gateSummariesByModules()` strips it out of `tiles.summaries` before the
 * client sees anything — a `recovery`-off account has no key to fall back to.
 * That entry was added WITH this helper: while the tile read SDNN alone the
 * omission was inert, and a client-side gate here would be a second source of
 * truth that drifts from the server's.
 */
export function pickHrvSummary(
  summaries: Record<string, DataSummary> | undefined,
): { summary: DataSummary | null; type: HrvSummaryType; labelKey: string } {
  const pick = (
    summary: DataSummary | null,
    type: HrvSummaryType,
  ): {
    summary: DataSummary | null;
    type: HrvSummaryType;
    labelKey: string;
  } => ({
    summary,
    type,
    labelKey: HRV_LABEL_KEY[type],
  });
  const primary = summaries?.HEART_RATE_VARIABILITY;
  if ((primary?.count ?? 0) > 0) {
    return pick(primary ?? null, "HEART_RATE_VARIABILITY");
  }
  const fallback = summaries?.HRV_RMSSD;
  if ((fallback?.count ?? 0) > 0) {
    return pick(fallback ?? null, "HRV_RMSSD");
  }
  // Neither has rows. Report the primary type so the caller's stale-days
  // lookup and label stay on SDNN for the empty case — the tile is hidden
  // either way, and reporting the fallback here would make an account with
  // no HRV at all look like a ring user.
  return pick(primary ?? null, "HEART_RATE_VARIABILITY");
}

/**
 * The i18n key naming each glucose bucket on the tile strip. The untagged
 * bucket is named, not blank: a strip of cards where one carries no label
 * reads as a rendering fault, and the user needs to know the readings behind
 * it are the ones their meter never tagged.
 */
export const GLUCOSE_TILE_LABEL_KEY: Record<GlucoseContextBucket, string> = {
  FASTING: "targets.glucoseFasting",
  POSTPRANDIAL: "targets.glucosePostprandial",
  RANDOM: "targets.glucoseRandom",
  BEDTIME: "targets.glucoseBedtime",
  UNSPECIFIED: "targets.glucoseUnspecified",
};

/** One resolved glucose strip tile. */
export interface GlucoseTile {
  bucket: GlucoseContextBucket;
  labelKey: string;
  summary: DataSummary;
}

/**
 * Which glucose tiles the strip paints, in the canonical bucket order. An
 * empty result means the tile is not eligible and the whole glucose block is
 * omitted.
 *
 * #943 — the untagged bucket is in the loop, not outside it. Gating on the
 * four named contexts alone hid the tile from every account whose source
 * writes no meal-time tag, with no warning anywhere: the module was on, the
 * layout toggle was on, the readings were current, and the strip was empty.
 */
export function resolveGlucoseTiles(
  byContext: Record<string, DataSummary> | undefined,
): GlucoseTile[] {
  const tiles: GlucoseTile[] = [];
  for (const bucket of GLUCOSE_CONTEXT_BUCKETS) {
    const summary = byContext?.[bucket];
    if (!summary || summary.count <= 0) continue;
    tiles.push({ bucket, labelKey: GLUCOSE_TILE_LABEL_KEY[bucket], summary });
  }
  return tiles;
}
