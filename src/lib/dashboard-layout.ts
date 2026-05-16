/**
 * Dashboard widget layout — persisted in User.dashboardWidgetsJson.
 *
 * Single source of truth for which widgets show on /, what order, and
 * what the default layout is for new users. Null / missing = default.
 */

/**
 * Every widget the dashboard layout knows about. The order of
 * entries here is irrelevant — `DEFAULT_DASHBOARD_LAYOUT.widgets[].order`
 * is the visual order. This array is exported so the API Zod
 * `widgetIdEnum` (in `src/app/api/dashboard/widgets/route.ts`) can be
 * built from a single source of truth — v1.4.16 Fix A5 root cause was
 * the enum drifting away from the default-layout list, which silently
 * 422'd every save.
 */
export const DASHBOARD_WIDGET_IDS = [
  "weight",
  "bp",
  "pulse",
  "bodyFat",
  "mood",
  "medications",
  "sleep",
  "steps",
  "glucose",
  "totalBodyWater",
  "boneMass",
  "bpInTarget",
  "oxygenSaturation",
  "achievements",
  // v1.4.25 W8d — VO2 max trend tile (opt-in, secondary-metric pattern).
  // Self-gates on having any VO2_MAX sample; default-invisible so
  // existing dashboards stay unchanged until the user enables it in
  // Settings → Dashboard. Only the tile-strip surface; chart row
  // lands alongside the iOS-app body-composition sub-page in v1.5.
  "vo2Max",
] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];

export interface DashboardWidgetConfig {
  id: DashboardWidgetId;
  /**
   * Whether the widget shows up in the *charts* row (the lower section
   * of the dashboard with the line graphs). The legacy single-toggle
   * field — kept on the wire for back-compat with users who saved a
   * layout pre-v1.4.15.
   */
  visible: boolean;
  /**
   * v1.4.15 Fix 5 — independent visibility for the *strip tile* (the
   * upper row of trend cards). When omitted, the resolver mirrors
   * `visible` so existing saved layouts keep their previous behaviour
   * (one toggle controls both surfaces). When set explicitly the user
   * can show the chart but hide the tile, or show the tile but hide
   * the chart, which is what the maintainer asked for in the v1.4.15 follow-up
   * (memory `feedback_dashboard_top_tiles_selectable.md`).
   */
  tileVisible?: boolean;
  order: number;
}

/**
 * v1.4.16 phase B8 — comparison baseline persisted alongside widgets.
 *
 * Research §7 Q3 settled on piggy-backing the comparison preference
 * onto the existing `User.dashboardWidgetsJson` blob rather than
 * carving a dedicated Prisma column — the field is ephemeral (a UI
 * affordance, not an analytical attribute) and a JSON pivot here
 * keeps the v1.4.16 release migration-free.
 *
 * Values:
 *   - "none"      — comparison is off (default; pre-B8 behaviour).
 *   - "lastMonth" — overlay the matching window from 30 days earlier.
 *   - "lastYear"  — overlay the matching window from 365 days earlier.
 *
 * The resolver defaults to "none" when the field is missing so legacy
 * users see no behavioural change until they explicitly flip the
 * toggle in Settings → Dashboard. Unknown values are clamped back to
 * "none" so a stale client cannot poison the dashboard with a value
 * the renderer doesn't know how to draw.
 */
export const COMPARISON_BASELINES = ["none", "lastMonth", "lastYear"] as const;
export type ComparisonBaseline = (typeof COMPARISON_BASELINES)[number];

export function isComparisonBaseline(
  value: unknown,
): value is ComparisonBaseline {
  return (
    typeof value === "string" &&
    (COMPARISON_BASELINES as readonly string[]).includes(value)
  );
}

/**
 * v1.4.18 — per-chart overlay-prefs.
 *
 * the maintainer rolled back B1a's always-on chart overlays (gradient fill,
 * personal-baseline reference line, target-zone shading) and asked for
 * a per-chart switch surface so each chart can be tuned independently.
 * The three toggles (7-day trend / Trend arrow / Target range) live in
 * a popover on each chart card; their state persists per user via this
 * map keyed by chart id.
 *
 * Defaults: every flag is `false`. Clean line is the new default;
 * overlays are user-opt-in. Missing chart keys behave the same way
 * (the chart wrapper fills in the default).
 *
 * The map piggy-backs on `User.dashboardWidgetsJson` instead of
 * carving a new column — same pragmatism as the B8 comparison baseline.
 */
export const CHART_OVERLAY_KEYS = [
  "bp",
  "weight",
  "bmi",
  "pulse",
  "bodyFat",
  "mood",
  "medications",
  "sleep",
  "steps",
  // v1.4.25 W16a — VO2 max chart-row on /insights/puls. Independent
  // overlay-prefs slot so the cardio sub-page's VO2 chart-cog state
  // doesn't bleed into the pulse chart sitting directly above it.
  "vo2Max",
] as const;
export type ChartOverlayKey = (typeof CHART_OVERLAY_KEYS)[number];

export interface ChartOverlayPrefs {
  showTrendIndicator: boolean;
  showTrendArrow: boolean;
  showTargetRange: boolean;
  comparisonBaseline: ComparisonBaseline;
}

export const DEFAULT_CHART_OVERLAY_PREFS: ChartOverlayPrefs = {
  showTrendIndicator: false,
  showTrendArrow: false,
  showTargetRange: false,
  comparisonBaseline: "none",
};

export type ChartOverlayPrefsMap = Partial<
  Record<ChartOverlayKey, ChartOverlayPrefs>
>;

function isChartOverlayKey(value: string): value is ChartOverlayKey {
  return (CHART_OVERLAY_KEYS as readonly string[]).includes(value);
}

function coerceChartOverlayPrefs(value: unknown): ChartOverlayPrefs {
  if (!value || typeof value !== "object") return DEFAULT_CHART_OVERLAY_PREFS;
  const candidate = value as Partial<Record<keyof ChartOverlayPrefs, unknown>>;
  return {
    showTrendIndicator: candidate.showTrendIndicator === true,
    showTrendArrow: candidate.showTrendArrow === true,
    showTargetRange: candidate.showTargetRange === true,
    comparisonBaseline: isComparisonBaseline(candidate.comparisonBaseline)
      ? candidate.comparisonBaseline
      : "none",
  };
}

function coerceChartOverlayPrefsMap(value: unknown): ChartOverlayPrefsMap {
  if (!value || typeof value !== "object") return {};
  const out: ChartOverlayPrefsMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isChartOverlayKey(key)) continue;
    out[key] = coerceChartOverlayPrefs(raw);
  }
  return out;
}

export interface DashboardLayout {
  version: number;
  widgets: DashboardWidgetConfig[];
  /** v1.4.16 phase B8 — see `COMPARISON_BASELINES` doc. */
  comparisonBaseline?: ComparisonBaseline;
  /** v1.4.18 — per-chart overlay-prefs (3 toggles per chart card). */
  chartOverlayPrefs?: ChartOverlayPrefsMap;
}

export const DASHBOARD_LAYOUT_VERSION = 1;

/**
 * Default layout mirrors v1.1 behavior: core vitals always on, mood +
 * body-fat show if data exists (see dashboard page for the data-conditional
 * rendering). Ordering matches the visual order on / today.
 */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: DASHBOARD_LAYOUT_VERSION,
  widgets: [
    { id: "weight", visible: true, tileVisible: true, order: 0 },
    { id: "bp", visible: true, tileVisible: true, order: 1 },
    { id: "pulse", visible: true, tileVisible: true, order: 2 },
    { id: "bodyFat", visible: true, tileVisible: true, order: 3 },
    { id: "mood", visible: true, tileVisible: true, order: 4 },
    { id: "bpInTarget", visible: true, tileVisible: true, order: 5 },
    { id: "medications", visible: true, tileVisible: true, order: 6 },
    { id: "sleep", visible: false, tileVisible: false, order: 7 },
    { id: "steps", visible: false, tileVisible: false, order: 8 },
    { id: "glucose", visible: false, tileVisible: false, order: 9 },
    { id: "totalBodyWater", visible: false, tileVisible: false, order: 10 },
    { id: "boneMass", visible: false, tileVisible: false, order: 11 },
    { id: "oxygenSaturation", visible: false, tileVisible: false, order: 12 },
    // v1.4.15 phase-B4 — recent-unlocks card (dashboard surface for the
    // gamification feature). Visible by default — the card is small,
    // self-gates on having any achievements (otherwise it shows a brief
    // "no achievements yet" + link), and maintainer-asked-for-it explicitly.
    // `tileVisible` is forced false because there is no tile surface
    // for this widget; only the chart-row card.
    { id: "achievements", visible: true, tileVisible: false, order: 13 },
    // v1.4.25 W8d — VO2 max trend tile. Default-invisible on both
    // surfaces; opt-in via Settings → Dashboard. Only the tile-strip
    // representation today (`visible` stays false so the chart-row
    // gate never fires; the chart card lands in v1.5).
    { id: "vo2Max", visible: false, tileVisible: false, order: 14 },
  ],
};

export function resolveDashboardLayout(raw: unknown): DashboardLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_DASHBOARD_LAYOUT;
  const candidate = raw as Partial<DashboardLayout>;
  if (
    typeof candidate.version !== "number" ||
    !Array.isArray(candidate.widgets)
  ) {
    return DEFAULT_DASHBOARD_LAYOUT;
  }

  // Drop widget ids the current build does not know about. v1.4.28
  // retired the `glp1` tile; any user who saved a layout before then
  // still has the orphan id in `dashboardWidgetsJson`, and the PUT
  // route's Zod enum rejects the entire blob on the next save round-
  // trip. Filtering on read keeps the GET shape current-build-safe
  // and lets the Settings UI re-PUT a clean array.
  const knownIds = new Set<string>(DASHBOARD_WIDGET_IDS);
  const filtered = candidate.widgets.filter((w) => knownIds.has(w.id));

  // Merge with defaults so new widgets introduced in later versions show up
  // automatically (invisible by default, users opt-in).
  const savedIds = new Set(filtered.map((w) => w.id));
  const missing = DEFAULT_DASHBOARD_LAYOUT.widgets.filter(
    (w) => !savedIds.has(w.id),
  );
  const maxOrder = Math.max(0, ...filtered.map((w) => w.order));
  const appended = missing.map((w, i) => ({
    ...w,
    visible: false, // default-invisible on auto-upgrade
    tileVisible: false,
    order: maxOrder + 1 + i,
  }));

  // Default `tileVisible` to mirror `visible` for legacy entries that
  // never had the field (the v1.4.15 schema upgrade). Users who saved
  // a layout before this release see no behavioural change until they
  // explicitly toggle the new strip switch.
  const normalized = filtered.map((w) => ({
    ...w,
    tileVisible: typeof w.tileVisible === "boolean" ? w.tileVisible : w.visible,
  }));

  return {
    version: DASHBOARD_LAYOUT_VERSION,
    widgets: [...normalized, ...appended].sort((a, b) => a.order - b.order),
    // v1.4.16 phase B8 — clamp unknown / missing comparison values to
    // "none" so the dashboard renders the pre-B8 behaviour for legacy
    // layouts and refuses to act on a value it doesn't recognise.
    comparisonBaseline: isComparisonBaseline(candidate.comparisonBaseline)
      ? candidate.comparisonBaseline
      : "none",
    // v1.4.18 — per-chart overlay prefs. Drop unknown chart keys and
    // coerce non-boolean toggle values back to false so a stale
    // client cannot poison the dashboard with values the renderer
    // doesn't know how to draw.
    chartOverlayPrefs: coerceChartOverlayPrefsMap(candidate.chartOverlayPrefs),
  };
}

export function serializeDashboardLayout(
  layout: DashboardLayout,
): DashboardLayout {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    widgets: layout.widgets
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((w, i) => ({
        ...w,
        // Persist tileVisible explicitly so a follow-up read of the
        // saved layout doesn't have to re-mirror from `visible` and
        // discard the user's actual choice.
        tileVisible:
          typeof w.tileVisible === "boolean" ? w.tileVisible : w.visible,
        order: i, // normalize to 0-based dense order
      })),
    // v1.4.16 phase B8 — persist the comparison baseline explicitly.
    comparisonBaseline: isComparisonBaseline(layout.comparisonBaseline)
      ? layout.comparisonBaseline
      : "none",
    // v1.4.18 — persist per-chart overlay prefs verbatim through the
    // same coercion the resolver runs so the wire shape is stable.
    chartOverlayPrefs: coerceChartOverlayPrefsMap(layout.chartOverlayPrefs),
  };
}
