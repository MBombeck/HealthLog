/**
 * Dashboard widget layout — persisted in User.dashboardWidgetsJson.
 *
 * Single source of truth for which widgets show on /, what order, and
 * what the default layout is for new users. Null / missing = default.
 */
import {
  PRIORITY_ITEM_KINDS,
  isPriorityItemKind,
  type PriorityItemKind,
} from "@/lib/daily/priority-item";

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
  // v1.28.52 — muscle mass joins the body-composition strip tiles
  // (totalBodyWater / boneMass). Maps 1:1 to the MUSCLE_MASS
  // MeasurementType the server already stores; self-gates on data.
  "muscleMass",
  "bpInTarget",
  "oxygenSaturation",
  // v1.28.52 — HRV + respiratory rate graduate from the iOS-only
  // catalogue to first-class web-writable widgets with a strip tile.
  // Each maps 1:1 to a MeasurementType the server already surfaces via
  // the summaries slice; both self-gate on having a sample.
  "hrv",
  "respiratoryRate",
  "achievements",
  // v1.4.25 W8d — VO2 max trend tile (secondary-metric pattern). The
  // strip tile is on by default and self-gates on having any VO2_MAX
  // sample, so accounts that sync cardio fitness see it without enabling
  // it in Settings → Dashboard, while empty accounts get a clean tile
  // strip. Only the tile-strip surface; the chart row lives on the
  // /insights/cardio-fitness sub-page.
  "vo2Max",
  // v1.4.32 — "Recent workouts" tile. Surfaces the three most-recent
  // canonical workouts; self-gates on at least one row. Default-on
  // (`visible: true`) because the maintainer wants new accounts to
  // see the surface even when empty so the Apple-Health onboarding
  // cue is discoverable from the dashboard rather than hidden
  // behind Settings.
  "recentWorkouts",
  // v1.11.2 B5 — the v1.10 additive HealthKit signals become pinnable.
  // Each maps 1:1 to a MeasurementType the server already stores;
  // default-invisible so existing dashboards stay unchanged until the
  // user opts in via Settings → Dashboard.
  "cardioRecovery",
  "sixMinuteWalk",
  "stairAscentSpeed",
  "stairDescentSpeed",
  "breathingDisturbances",
  "wristTemperature",
  "falls",
  "walkingSteadiness",
  // v1.18.2 — Vorsorge (preventive-care reminders) becomes a first-class
  // dashboard widget, exactly like `medications`: a chart-row summary card
  // (no strip tile). Default-off so existing dashboards are unchanged; the
  // user opts in via Settings → Dashboard. Always-on data surface (no
  // toggleable module gate), so it behaves as a core opt-in tile.
  "vorsorge",
  // v1.29 — fluid intake (drinking water). Nutrients-store-backed (see
  // `NUTRIENT_WATER` in the dashboard snapshot), gated on the `nutrients`
  // module; self-gates on data like the v1.28.52 strip tiles.
  "waterIntake",
] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];

/**
 * v1.11.2 B5 / HIGH-1 — widget ids that are WRITABLE (members of
 * `DASHBOARD_WIDGET_IDS`, so the iOS pin PUT validates them) but have NO
 * web render path: `src/app/page.tsx` renders strip tiles via hardcoded
 * per-id blocks and never iterates an id→component map, so these ids draw
 * nothing on the web dashboard. They are surfaced and pinned by the native
 * iOS client only.
 *
 * They MUST stay in `DASHBOARD_WIDGET_IDS` (the iOS v0.14 Home-pin request
 * needs the widgets PUT enum to accept them), but the web Settings →
 * Dashboard list filters them out (see `dashboard-layout-section.tsx`) so a
 * web user is never offered a toggle that silently does nothing on web.
 *
 * The 11 `DASHBOARD_IOS_ONLY_WIDGET_IDS` below are a separate concern: those
 * are NOT writable (not in `DASHBOARD_WIDGET_IDS`) so they never reached the
 * web Settings list in the first place. This set is specifically the
 * writable-but-not-web-rendered ids that B5 introduced.
 */
export const IOS_PIN_ONLY_WIDGET_IDS = [
  "cardioRecovery",
  "sixMinuteWalk",
  "stairAscentSpeed",
  "stairDescentSpeed",
  "breathingDisturbances",
  // v1.28.52 — `wristTemperature` graduated to a web-rendered strip tile,
  // so it is no longer pin-only (the Settings list now offers its toggle).
  "falls",
  "walkingSteadiness",
] as const satisfies readonly DashboardWidgetId[];

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
  // v1.28.52 — `hrv` + `respiratoryRate` graduated to web-writable widgets
  // (now members of DASHBOARD_WIDGET_IDS), so they leave the iOS-only set to
  // avoid double-booking the catalogue.
  "walkingSpeed",
  "walkingAsymmetry",
  "walkingStepLength",
  "bmi",
  "bodyTemperature",
  "walkingDoubleSupport",
  "audioExposureEnvironment",
  "audioExposureHeadphone",
  // The four clinical signals the v1.25 sub-pages already chart
  // (`/insights/grip-strength`, `/insights/pain`, `/insights/waist`,
  // `/insights/waist-to-height`). The native client offers a dashboard tile
  // for each; before they joined the catalogue the widgets PUT dropped them
  // through the unknown-id filter, so every native layout save silently lost
  // the user's placement of those four tiles.
  //
  // They live here rather than in `DASHBOARD_WIDGET_IDS` because the web
  // dashboard has no render path for them — the chart lives on the insights
  // sub-page, not on the Startseite. That keeps them out of the web Settings
  // list (built from `DASHBOARD_WIDGET_IDS`) while the PUT enum, the on-read
  // resolver, and the snapshot catalogue all accept and retain them.
  //
  // `painNRS` matches the id the native client sends. The sibling
  // chart-overlay slot spells it `painNrs` (see `CHART_OVERLAY_KEYS`); the
  // two namespaces are independent and neither is derived from the other, so
  // the casing difference is deliberate rather than a typo.
  "gripStrength",
  "painNRS",
  "waistCircumference",
  "waistToHeight",
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

function isComparisonBaseline(value: unknown): value is ComparisonBaseline {
  return (
    typeof value === "string" &&
    (COMPARISON_BASELINES as readonly string[]).includes(value)
  );
}

/**
 * v1.4.18 — per-chart overlay-prefs.
 *
 * The maintainer rolled back B1a's always-on chart overlays (gradient fill,
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
  // v1.10.0 — additive HealthKit signals (WX-A). One overlay-prefs slot
  // per new chart surface; camel-case keys mirror the existing convention.
  "cardioRecovery",
  "wristTemperature",
  "fallCount",
  "sixMinuteWalkDistance",
  "stairAscentSpeed",
  "stairDescentSpeed",
  "breathingDisturbances",
  // v1.18.1 — chart-overlay slots for the rebuilt `/insights/recovery`
  // page's device-native signal charts. One per chart surface.
  "ansCharge",
  "dayStrain",
  "workoutStrain",
  "cardioLoad",
  "averageHeartRate",
  "maxHeartRate",
  "energyExpenditureKj",
  // v1.25 — chart-overlay slots for the physical / clinical signal sub-pages.
  // One per chart surface; camel-case keys mirror the existing convention.
  "gripStrength",
  "painNrs",
  "waistCircumference",
  "waistToHeight",
  // v1.42 — the score pages' history charts. Each remembers only its range
  // tab (the charts mount no overlay dropdown), one slot per score page.
  "scoreHealth",
  "scoreReadiness",
  "scoreRecovery",
  "scoreSleep",
  "scoreStress",
  "scoreStrain",
] as const;
export type ChartOverlayKey = (typeof CHART_OVERLAY_KEYS)[number];

/**
 * v1.30.1 — the range tabs (`7 / 30 / 90 / All`) every chart card
 * exposes. `0` means "All". Shared here so both the client hook and
 * the server route validate against the same closed set instead of
 * each chart component re-declaring it.
 */
export const CHART_RANGE_POINTS = [0, 7, 30, 90] as const;
export type ChartRangePoints = (typeof CHART_RANGE_POINTS)[number];

export interface ChartOverlayPrefs {
  showTrendIndicator: boolean;
  showTrendArrow: boolean;
  showTargetRange: boolean;
  comparisonBaseline: ComparisonBaseline;
  // v1.30.1 — persisted range-tab selection. Undefined = never saved
  // for this chart yet, so the chart falls back to its own 30 d
  // default rather than forcing every unopened chart to look "saved".
  rangePoints?: ChartRangePoints;
}

export const DEFAULT_CHART_OVERLAY_PREFS: ChartOverlayPrefs = {
  showTrendIndicator: false,
  showTrendArrow: false,
  showTargetRange: false,
  comparisonBaseline: "none",
};

function isChartRangePoints(value: unknown): value is ChartRangePoints {
  return (
    typeof value === "number" &&
    (CHART_RANGE_POINTS as readonly number[]).includes(value)
  );
}

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
    rangePoints: isChartRangePoints(candidate.rangePoints)
      ? candidate.rangePoints
      : undefined,
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

/**
 * v1.27.7 — selectable hero score rings. The closed id set the hero's
 * ring row can render next to the health score:
 *
 *   - `READINESS` / `RECOVERY_SCORE` / `SLEEP_SCORE` resolve through the
 *     derived registry's engines (module-gated like the derived routes);
 *   - `MED_COMPLIANCE` is TODAY's dose progress (taken of scheduled) from
 *     the snapshot's own `medsToday` block — the ring that absorbs the
 *     retired hero dose row's information role. The v1.27.7 first cut put
 *     the pooled 7-day adherence percentage here; it has been today's
 *     progress since v1.27.8. Resolution lives in
 *     `@/lib/dashboard/score-rings`.
 *
 * The preference piggy-backs on the layout blob like `chartOverlayPrefs`
 * (a UI affordance, no Prisma migration). The resolver drops unknown ids,
 * dedupes, and clamps to `MAX_SELECTED_SCORE_RINGS`; a missing /
 * malformed field falls back to the default single MED_COMPLIANCE ring,
 * while an explicitly-saved empty array stays empty (the user chose no
 * extra rings).
 */
export const SCORE_RING_IDS = [
  "READINESS",
  "RECOVERY_SCORE",
  "SLEEP_SCORE",
  "MED_COMPLIANCE",
] as const;
export type ScoreRingId = (typeof SCORE_RING_IDS)[number];

export const MAX_SELECTED_SCORE_RINGS = 3;

export const DEFAULT_SELECTED_SCORE_RINGS: ScoreRingId[] = ["MED_COMPLIANCE"];

/**
 * v1.27.27 — hero ring ORDER. The health-score ring is a first-class,
 * always-present member of the hero ring row that the user can position
 * anywhere in the sequence (it has no on/off toggle — it is the anchor
 * ring). `HERO_RING_IDS` is the health-score id plus the selectable score
 * rings; `HeroRingId` is the union the persisted order carries.
 */
export const HEALTH_SCORE_RING_ID = "HEALTH_SCORE" as const;
export const HERO_RING_IDS = [HEALTH_SCORE_RING_ID, ...SCORE_RING_IDS] as const;
export type HeroRingId = (typeof HERO_RING_IDS)[number];

/** The order carries the health-score ring plus up to three score rings. */
export const MAX_HERO_RING_ORDER = MAX_SELECTED_SCORE_RINGS + 1;

/**
 * Default hero ring order: the health-score ring leads, then the default
 * selected score rings in their default order. The maintainer's contract —
 * "always start with the health score by default, but let the user
 * reorder" — lives here: a user who never opens the picker gets the
 * health-score ring on the leading edge.
 */
export const DEFAULT_HERO_RING_ORDER: HeroRingId[] = [
  HEALTH_SCORE_RING_ID,
  ...DEFAULT_SELECTED_SCORE_RINGS,
];

function isHeroRingId(value: unknown): value is HeroRingId {
  return (
    typeof value === "string" &&
    (HERO_RING_IDS as readonly string[]).includes(value)
  );
}

/**
 * Reconcile the persisted hero ring order against the CURRENT available
 * ring set (the always-present health-score ring plus the passed selected
 * score rings). The order is the single source of truth for how the hero
 * sequences its rings:
 *
 *   - a missing / malformed order → the default: health score first, then
 *     the selected rings in selection order (the maintainer's contract);
 *   - a stored order is filtered to the available set — deselected /
 *     unknown ids drop, duplicates collapse;
 *   - any available ring the stored order didn't place (a newly-selected
 *     ring, or the health-score ring a corrupt order somehow omits) is
 *     appended so a ring never silently vanishes.
 *
 * Passing the RESOLVED score rings (what actually renders) lets the hero
 * order only the rings it draws; passing the SELECTED score rings lets the
 * Settings picker and the layout resolver share the identical reconciler.
 */
export function resolveHeroRingOrder(
  rawOrder: unknown,
  selected: ScoreRingId[],
): HeroRingId[] {
  const available: HeroRingId[] = [HEALTH_SCORE_RING_ID, ...selected];
  if (!Array.isArray(rawOrder)) {
    // Default — health score leads, selected rings follow in order.
    return available;
  }
  const availableSet = new Set<HeroRingId>(available);
  const seen = new Set<HeroRingId>();
  const out: HeroRingId[] = [];
  for (const entry of rawOrder) {
    if (!isHeroRingId(entry)) continue;
    if (!availableSet.has(entry)) continue;
    if (seen.has(entry)) continue;
    out.push(entry);
    seen.add(entry);
  }
  // Append available rings the stored order didn't place (new ring, or a
  // health-score ring a corrupt order lacks), preserving `available` order.
  for (const id of available) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

function isScoreRingId(value: unknown): value is ScoreRingId {
  return (
    typeof value === "string" &&
    (SCORE_RING_IDS as readonly string[]).includes(value)
  );
}

/**
 * Coerce the persisted `selectedScoreRings` field: unknown ids drop,
 * duplicates collapse (first occurrence wins), the list clamps to
 * `MAX_SELECTED_SCORE_RINGS`. A non-array (missing field, legacy blob,
 * malformed client) falls back to the default; an array — even an empty
 * one — is respected as an explicit choice.
 */
function coerceSelectedScoreRings(value: unknown): ScoreRingId[] {
  if (!Array.isArray(value)) return [...DEFAULT_SELECTED_SCORE_RINGS];
  const out: ScoreRingId[] = [];
  for (const entry of value) {
    if (!isScoreRingId(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
    if (out.length >= MAX_SELECTED_SCORE_RINGS) break;
  }
  return out;
}

/**
 * Configurable hero primary content — what the dashboard hero card leads
 * with. `"score"` is the long-standing composition (health-score ring +
 * the day's read); `"reminders"` promotes the worth-a-look rail into the
 * hero slot. Closed two-value set, deliberately no further options.
 *
 * The preference piggy-backs on the layout blob like `comparisonBaseline`
 * (a UI affordance, no Prisma migration). The resolver drops unknown
 * values back to the default `"score"`; the serializer omits the default
 * so an untouched account's stored blob is unchanged.
 */
export const HERO_PRIMARY_CONTENTS = ["score", "reminders"] as const;
export type HeroPrimaryContent = (typeof HERO_PRIMARY_CONTENTS)[number];

export const DEFAULT_HERO_PRIMARY_CONTENT: HeroPrimaryContent = "score";

function coerceHeroPrimaryContent(value: unknown): HeroPrimaryContent {
  return typeof value === "string" &&
    (HERO_PRIMARY_CONTENTS as readonly string[]).includes(value)
    ? (value as HeroPrimaryContent)
    : DEFAULT_HERO_PRIMARY_CONTENT;
}

/**
 * Resolve the Today hero's item-kind visibility against the current closed
 * catalogue. Legacy or malformed values enable every current kind. Arrays are
 * explicit choices, including an empty array, and resolve in catalogue order.
 */
function coerceEnabledHeroItemKinds(value: unknown): PriorityItemKind[] {
  if (!Array.isArray(value)) return [...PRIORITY_ITEM_KINDS];
  const enabled = new Set<PriorityItemKind>();
  for (const entry of value) {
    if (isPriorityItemKind(entry)) enabled.add(entry);
  }
  return PRIORITY_ITEM_KINDS.filter((kind) => enabled.has(kind));
}

export interface DashboardLayout {
  version: number;
  widgets: DashboardWidgetConfig[];
  /** v1.4.16 phase B8 — see `COMPARISON_BASELINES` doc. */
  comparisonBaseline?: ComparisonBaseline;
  /** v1.4.18 — per-chart overlay-prefs (3 toggles per chart card). */
  chartOverlayPrefs?: ChartOverlayPrefsMap;
  /**
   * v1.27.7 — hero score rings (max 3, closed `SCORE_RING_IDS` set)
   * rendered next to the health-score ring. See the doc on
   * `SCORE_RING_IDS`; the resolver clamps/dedupes/drops-unknown.
   */
  selectedScoreRings?: ScoreRingId[];
  /**
   * v1.27.27 — hero ring display ORDER over the health-score ring plus the
   * selected score rings. The single source of truth for the hero ring
   * sequence; defaults to health-score first (see `resolveHeroRingOrder` +
   * `DEFAULT_HERO_RING_ORDER`). The resolver reconciles it against the
   * selected set on every read.
   */
  heroRingOrder?: HeroRingId[];
  /**
   * Item kinds allowed in the Today hero rail. Missing legacy data enables
   * every current kind; an explicit empty array keeps the rail off.
   */
  enabledHeroItemKinds?: PriorityItemKind[];
  /**
   * Primary hero-card content: `"score"` (default — health-score ring plus
   * the day's read) or `"reminders"` (the worth-a-look rail promoted into
   * the hero slot). Optional and additive so clients that predate the
   * field round-trip the blob untouched; unknown values resolve to
   * `"score"`.
   */
  hero?: HeroPrimaryContent;
  /**
   * v1.42 — whether the dashboard shows its top card (the Today card above
   * the tiles) at all. Optional and additive: missing resolves to `true`,
   * and the serializer omits the default, so an untouched account's blob
   * stays as it was and clients that predate the field round-trip it
   * untouched. Deliberately not `heroVisible`: that name belonged to the
   * retired opt-in hero and old blobs may still carry it.
   */
  todayCardVisible?: boolean;
}

/**
 * How the widgets PUT treats each top-level layout field when the client
 * omits it.
 *
 * - `"replace"` — the field is the point of the request. A PUT that omits it
 *   is rejected by Zod (`version` is required) — the caller always has
 *   something to say about a `"replace"` field.
 * - `"preserve"` — the field is owned by a surface OTHER than the one making
 *   this request, so an omission means "I don't know about this", never
 *   "clear it". The route reads the stored layout and carries the existing
 *   value forward.
 *
 * The preserve set exists because clients legitimately do not know every
 * field. Chart overlays also write through their own endpoint. An omitted
 * field must therefore keep the stored choice instead of falling through to
 * a serializer default. `widgets` is preserved too so a partial client can
 * update one preference without resending a potentially stale widget list.
 *
 * `satisfies Record<keyof DashboardLayout, …>` is the load-bearing part.
 * Adding a field to `DashboardLayout` without adding it here is a TYPE error,
 * so the next field cannot repeat the `comparisonBaseline` mistake by
 * omission — somebody has to make the decision explicitly.
 */
export const LAYOUT_FIELD_MERGE_DISPOSITION = {
  version: "replace",
  widgets: "preserve",
  comparisonBaseline: "preserve",
  chartOverlayPrefs: "preserve",
  selectedScoreRings: "preserve",
  heroRingOrder: "preserve",
  enabledHeroItemKinds: "preserve",
  hero: "preserve",
  todayCardVisible: "preserve",
} as const satisfies Record<keyof DashboardLayout, "replace" | "preserve">;

/**
 * The top-level layout fields the widgets PUT carries forward from the stored
 * layout when the request omits them. Derived from
 * `LAYOUT_FIELD_MERGE_DISPOSITION` so the two can never drift.
 */
export const PRESERVED_LAYOUT_FIELDS = (
  Object.keys(LAYOUT_FIELD_MERGE_DISPOSITION) as Array<keyof DashboardLayout>
).filter(
  (field) => LAYOUT_FIELD_MERGE_DISPOSITION[field] === "preserve",
) as ReadonlyArray<keyof DashboardLayout>;

/**
 * True when the incoming layout omits at least one preserved field, i.e. the
 * route has to read the stored layout to merge. Lets the common full-layout
 * save from Settings skip the extra query.
 */
export function layoutNeedsPreserveRead(
  incoming: Partial<DashboardLayout>,
): boolean {
  return PRESERVED_LAYOUT_FIELDS.some((field) => incoming[field] === undefined);
}

/**
 * Carry every omitted preserved field forward from the stored layout.
 * Fields the client DID send win untouched; `"replace"` fields are never
 * consulted here. One stored-layout read covers all of them.
 */
export function mergePreservedLayoutFields(
  incoming: Partial<DashboardLayout>,
  existing: DashboardLayout,
): Partial<DashboardLayout> {
  const merged: Partial<DashboardLayout> = { ...incoming };
  for (const field of PRESERVED_LAYOUT_FIELDS) {
    if (merged[field] === undefined) {
      // Each key maps to its own value type; the loop is homogeneous over
      // `keyof DashboardLayout`, which TypeScript cannot express per-key.
      (merged as Record<string, unknown>)[field] = existing[field];
    }
  }
  return merged;
}

/**
 * The shape every GET / PUT `/api/dashboard/widgets` response returns.
 * `updatedAt` is the optional optimistic-concurrency token.
 */
export type DashboardLayoutWithToken = DashboardLayout & {
  updatedAt?: string;
  /**
   * Widget ids the server resolved as unavailable for this account — a
   * toggle that cannot do anything, which Settings must not offer. See
   * `unavailableWidgetIds`. Optional and additive: a client that ignores
   * it behaves exactly as before.
   */
  unavailableWidgetIds?: string[];
};

const DASHBOARD_LAYOUT_VERSION = 1;

/**
 * Default layout mirrors v1.1 behavior: core vitals always on, mood +
 * body-fat show if data exists (see dashboard page for the data-conditional
 * rendering). Ordering matches the visual order on / today.
 */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: DASHBOARD_LAYOUT_VERSION,
  // The stored score-ring contracts remain available to snapshot and native
  // consumers even though the web layout settings do not edit them.
  selectedScoreRings: [...DEFAULT_SELECTED_SCORE_RINGS],
  heroRingOrder: [...DEFAULT_HERO_RING_ORDER],
  enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
  hero: DEFAULT_HERO_PRIMARY_CONTENT,
  todayCardVisible: true,
  widgets: [
    { id: "weight", visible: true, tileVisible: true, order: 0 },
    { id: "bp", visible: true, tileVisible: true, order: 1 },
    { id: "pulse", visible: true, tileVisible: true, order: 2 },
    // v1.28.52 — vitals strip cluster (HRV / SpO2 / respiratory rate /
    // wrist temperature) sits next to pulse. Each strip tile is on by
    // default (`tileVisible: true`) and self-gates on having a sample of
    // that MeasurementType (see the `showXTile` gates in page.tsx), so an
    // empty account still gets a clean dashboard. The chart row stays off
    // (`visible: false`) — those charts live on the /insights sub-pages.
    { id: "hrv", visible: false, tileVisible: true, order: 3 },
    { id: "oxygenSaturation", visible: false, tileVisible: true, order: 4 },
    { id: "respiratoryRate", visible: false, tileVisible: true, order: 5 },
    { id: "wristTemperature", visible: false, tileVisible: true, order: 6 },
    { id: "bodyFat", visible: true, tileVisible: true, order: 7 },
    // v1.28.52 — body-composition strip cluster (muscle mass / total body
    // water / bone mass) next to body fat. Same self-gating tile contract
    // as the vitals cluster above; charts live on the /insights sub-pages.
    { id: "muscleMass", visible: false, tileVisible: true, order: 8 },
    { id: "totalBodyWater", visible: false, tileVisible: true, order: 9 },
    { id: "boneMass", visible: false, tileVisible: true, order: 10 },
    { id: "mood", visible: true, tileVisible: true, order: 11 },
    { id: "bpInTarget", visible: true, tileVisible: true, order: 12 },
    { id: "medications", visible: true, tileVisible: true, order: 13 },
    // v1.20.0 — sleep / steps / glucose strip tiles default-on so accounts
    // that sync these signals discover them on / without hunting through
    // Settings → Dashboard. Each follows the VO2max precedent: the strip
    // tile is on (`tileVisible: true`) and self-gates on having data
    // (`hasSleep` / `hasSteps` / `showGlucoseCards` in page.tsx), so an
    // empty account still gets a clean dashboard. The chart row stays off
    // (`visible: false`) — those charts live on the /insights sub-pages.
    { id: "sleep", visible: false, tileVisible: true, order: 14 },
    { id: "steps", visible: false, tileVisible: true, order: 15 },
    { id: "glucose", visible: false, tileVisible: true, order: 16 },
    // v1.4.15 phase-B4 — recent-unlocks card (dashboard surface for the
    // gamification feature). Visible by default — the card is small,
    // self-gates on having any achievements (otherwise it shows a brief
    // "no achievements yet" + link), and maintainer-asked-for-it explicitly.
    // `tileVisible` is forced false because there is no tile surface
    // for this widget; only the chart-row card.
    { id: "achievements", visible: true, tileVisible: false, order: 17 },
    // v1.4.25 W8d — VO2 max trend tile. The strip tile is on by default
    // (`tileVisible: true`) so accounts that already sync a VO2max sample
    // see cardio fitness without hunting through Settings → Dashboard; the
    // tile self-gates on having any VO2_MAX sample (see `showVo2Tile` in
    // page.tsx), so accounts with no sample still get a clean dashboard.
    // The chart row stays off (`visible: false`) — VO2max charts live on
    // the /insights/cardio-fitness and /insights/pulse sub-pages.
    { id: "vo2Max", visible: false, tileVisible: true, order: 18 },
    // v1.4.32 — Recent workouts dashboard tile. Default-visible so
    // brand-new accounts discover the workout surface without
    // hunting through Settings; the tile self-gates on a non-empty
    // workouts list and renders an Apple-Health onboarding hint
    // otherwise.
    { id: "recentWorkouts", visible: true, tileVisible: true, order: 19 },
    // v1.11.2 B5 — v1.10 additive HealthKit signals, pinnable but
    // default-invisible on both surfaces. The user opts in via
    // Settings → Dashboard; each tile self-gates on having any sample.
    { id: "cardioRecovery", visible: false, tileVisible: false, order: 20 },
    { id: "sixMinuteWalk", visible: false, tileVisible: false, order: 21 },
    { id: "stairAscentSpeed", visible: false, tileVisible: false, order: 22 },
    { id: "stairDescentSpeed", visible: false, tileVisible: false, order: 23 },
    {
      id: "breathingDisturbances",
      visible: false,
      tileVisible: false,
      order: 24,
    },
    { id: "falls", visible: false, tileVisible: false, order: 25 },
    { id: "walkingSteadiness", visible: false, tileVisible: false, order: 26 },
    // v1.18.2 — Vorsorge summary card. Chart-row only (no strip tile), so
    // `tileVisible` is forced false. v1.20.0 — flipped `visible: true` so
    // preventive-care reminders surface on / by default; the card self-gates
    // (see page.tsx) and shows nothing for accounts without due reminders.
    { id: "vorsorge", visible: true, tileVisible: false, order: 27 },
    // v1.29 — fluid intake strip tile. On by default (`tileVisible: true`)
    // like the v1.28.52 vitals cluster; self-gates on having water data
    // (see `showWaterIntakeTile` in page-client.tsx) AND on the `nutrients`
    // module (opt-in, default off), so an account that never enabled
    // nutrients or never logged water sees a clean dashboard.
    { id: "waterIntake", visible: false, tileVisible: true, order: 28 },
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

  // Resolve the selected score rings once — the hero-ring-order reconciler
  // below keys off the same resolved set the layout persists.
  const resolvedSelectedScoreRings = coerceSelectedScoreRings(
    candidate.selectedScoreRings,
  );

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
    // v1.27.7 — hero score rings: unknown ids drop, duplicates collapse,
    // the list clamps to three. A legacy blob without the field gets the
    // default single MED_COMPLIANCE ring.
    selectedScoreRings: resolvedSelectedScoreRings,
    // v1.27.27 — hero ring order, reconciled against the resolved selected
    // set. A legacy blob without the field gets the default (health-score
    // first, then the selected rings in order).
    heroRingOrder: resolveHeroRingOrder(
      candidate.heroRingOrder,
      resolvedSelectedScoreRings,
    ),
    enabledHeroItemKinds: coerceEnabledHeroItemKinds(
      candidate.enabledHeroItemKinds,
    ),
    // Hero primary content: unknown / missing values resolve to the
    // default "score" so a stale client cannot swap the hero to a
    // composition the renderer doesn't know how to draw.
    hero: coerceHeroPrimaryContent(candidate.hero),
    // Only an explicit `false` hides the top card; anything else shows it.
    todayCardVisible: candidate.todayCardVisible !== false,
  };
}

export function serializeDashboardLayout(
  layout: DashboardLayout,
): DashboardLayout {
  const resolvedSelectedScoreRings = coerceSelectedScoreRings(
    layout.selectedScoreRings,
  );
  const enabledHeroItemKinds = coerceEnabledHeroItemKinds(
    layout.enabledHeroItemKinds,
  );
  const hero = coerceHeroPrimaryContent(layout.hero);
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
    // v1.27.7 — persist the score-ring selection through the same
    // coercion the resolver runs so the wire shape is stable.
    selectedScoreRings: resolvedSelectedScoreRings,
    // v1.27.27 — persist the hero ring order, reconciled against the
    // resolved selected set (same reconciler as the resolver) so the wire
    // shape is stable and a deselected ring can't linger in the order.
    heroRingOrder: resolveHeroRingOrder(
      layout.heroRingOrder,
      resolvedSelectedScoreRings,
    ),
    // Every kind enabled is the forward-compatible default, so omit it from
    // storage. Empty and partial arrays remain explicit user choices.
    ...(enabledHeroItemKinds.length === PRIORITY_ITEM_KINDS.length
      ? {}
      : { enabledHeroItemKinds }),
    // The default "score" is omitted from storage (same forward-compatible
    // contract as `enabledHeroItemKinds`), so an untouched account's blob
    // is byte-identical to the pre-field shape.
    ...(hero === DEFAULT_HERO_PRIMARY_CONTENT ? {} : { hero }),
    // Shown is the default and is omitted the same way.
    ...(layout.todayCardVisible === false ? { todayCardVisible: false } : {}),
  };
}
