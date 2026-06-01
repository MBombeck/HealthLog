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
  // v1.4.32 — "Recent workouts" tile. Surfaces the three most-recent
  // canonical workouts; self-gates on at least one row. Default-on
  // (`visible: true`) because the maintainer wants new accounts to
  // see the surface even when empty so the Apple-Health onboarding
  // cue is discoverable from the dashboard rather than hidden
  // behind Settings.
  "recentWorkouts",
] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];

/**
 * v1.7.0 — iOS-only widget ids the native client materialises in its
 * own default layout but the server PUT enum does NOT yet accept. These
 * are the HK-completeness tiles the iOS app added in its v0.5.2 / v0.7.0
 * sweeps (`DashboardWidgetLayout.swift`); each maps 1:1 to a HealthLog
 * `MeasurementType` the server already stores.
 *
 * They are deliberately kept OUT of `DASHBOARD_WIDGET_IDS` so the
 * widgets PUT route's Zod enum + the on-read resolver are unchanged —
 * widening the writable enum is a separate decision. This constant
 * exists only so the dashboard snapshot can publish the full 27-id
 * catalogue (`DASHBOARD_WIDGET_CATALOGUE_IDS`) the iOS cold-launch seed
 * needs, letting the layout round-trip in one key without a second
 * round-trip. See `.planning/ios-coord/v1.7.0-ios-convergence-locks.md`
 * §2b.
 */
export const DASHBOARD_IOS_ONLY_WIDGET_IDS = [
  "restingHeartRate",
  "hrv",
  "walkingSpeed",
  "walkingAsymmetry",
  "walkingStepLength",
  "bmi",
  "bodyTemperature",
  "walkingDoubleSupport",
  "respiratoryRate",
  "audioExposureEnvironment",
  "audioExposureHeadphone",
] as const;

/**
 * v1.7.0 — full widget-id catalogue: the 16 server-known ids plus the
 * 11 iOS-only ids = 27 distinct ids. This is the authoritative set the
 * iOS client expects in the snapshot's catalogue block so a cold-launch
 * first-paint can seed every tile without a second round-trip. Pure
 * superset of `DASHBOARD_WIDGET_IDS`; never used to gate the writable
 * PUT enum.
 */
export const DASHBOARD_WIDGET_CATALOGUE_IDS = [
  ...DASHBOARD_WIDGET_IDS,
  ...DASHBOARD_IOS_ONLY_WIDGET_IDS,
] as const;

export type DashboardWidgetCatalogueId =
  (typeof DASHBOARD_WIDGET_CATALOGUE_IDS)[number];

export interface DashboardWidgetConfig {
  // v1.7.0 — widened to the full 27-id catalogue so iOS-only ids
  // round-trip through the stored layout. The web render path only
  // looks up its own 16 ids; the other 11 ride along untouched.
  id: DashboardWidgetCatalogueId;
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

function isComparisonBaseline(
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
  // v1.4.25 W16a — VO2 max chart-row on /insights/pulse. Independent
  // overlay-prefs slot so the cardio sub-page's VO2 chart-cog state
  // doesn't bleed into the pulse chart sitting directly above it.
  "vo2Max",
  // v1.4.32 — wave-A HealthKit chart cards. Each one owns its own
  // overlay-prefs slot so the chart-cog popover (7-day trend / Trend
  // arrow / Target range / Comparison baseline) persists per metric.
  "hrv",
  "restingHr",
  "oxygenSaturation",
  "bodyTemperature",
  "activeEnergy",
  // v1.7.0 — chart-overlay slots for the previously-orphan metric
  // sub-pages. Each card owns its own slot so the chart-cog popover
  // persists per metric. Camel-case keys mirror the existing
  // convention; one per new chart surface.
  "bloodGlucose",
  "totalBodyWater",
  "boneMass",
  "flightsClimbed",
  "walkingRunningDistance",
  "fatFreeMass",
  "fatMass",
  "muscleMass",
  "skinTemperature",
  "pulseWaveVelocity",
  "vascularAge",
  "visceralFat",
  "audioExposureEnv",
  "audioExposureHeadphone",
  "timeInDaylight",
  "walkingSteadiness",
  "audioExposureEvent",
  "respiratoryRate",
  "leanBodyMass",
  "walkingHeartRateAverage",
  "walkingAsymmetry",
  "walkingDoubleSupport",
  "walkingStepLength",
  "walkingSpeed",
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

const DASHBOARD_LAYOUT_VERSION = 1;

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
    // v1.4.32 — Recent workouts dashboard tile. Default-visible so
    // brand-new accounts discover the workout surface without
    // hunting through Settings; the tile self-gates on a non-empty
    // workouts list and renders an Apple-Health onboarding hint
    // otherwise.
    { id: "recentWorkouts", visible: true, tileVisible: true, order: 15 },
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

  // Drop widget ids outside the full 27-id catalogue. v1.4.28 retired
  // the `glp1` tile; any user who saved a layout before then still has
  // the orphan id in `dashboardWidgetsJson`, and a stale-enum PUT would
  // reject the entire blob on the next save round-trip. Filtering on
  // read keeps the GET shape current-build-safe and lets the Settings
  // UI re-PUT a clean array.
  //
  // v1.7.0 — the catalogue is the 27-id superset (16 web-known + 11
  // iOS-only). The 11 iOS-only ids are RETAINED here so a layout the
  // native client persisted round-trips intact on GET; the web render
  // path looks up only its own 16 ids and silently ignores the rest
  // (it never iterates id→component generically). A genuinely-unknown
  // id (typo / retired tile) outside the 27 still drops.
  const knownIds = new Set<string>(DASHBOARD_WIDGET_CATALOGUE_IDS);
  const filtered = candidate.widgets.filter((w) => knownIds.has(w.id));

  // Merge with defaults so new WEB widgets introduced in later versions
  // show up automatically (invisible by default, users opt-in). Only the
  // 16 web defaults are auto-appended — iOS-only ids only ever appear in
  // a layout once a native client has explicitly sent them, so they are
  // never seeded for a web-only account.
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
