/**
 * Per-chart display preferences, persisted inside the dashboard layout blob
 * (`User.dashboardWidgetsJson`, `chartOverlayPrefs`) and resolved with it in
 * `@/lib/dashboard-layout`: the comparison baseline, the overlay switches,
 * the remembered range, and the night timeline's metric lines.
 */
import {
  coerceNightOverlayKinds,
  type NightOverlayKind,
} from "@/lib/sleep/night-overlay-kinds";

/**
 * The comparison baseline, persisted alongside the widgets.
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
 * Per-chart overlay preferences.
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
  // The VO2 max chart row on /insights/pulse. Independent
  // overlay-prefs slot so the cardio sub-page's VO2 chart-cog state
  // doesn't bleed into the pulse chart sitting directly above it.
  "vo2Max",
  // The HealthKit chart cards. Each one owns its own
  // overlay-prefs slot so the chart-cog popover (7-day trend / Trend
  // arrow / Target range / Comparison baseline) persists per metric.
  "hrv",
  "restingHr",
  "oxygenSaturation",
  "bodyTemperature",
  "activeEnergy",
  // Chart-overlay slots for the previously orphan metric
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
  // The additive HealthKit signals. One overlay-prefs slot
  // per new chart surface; camel-case keys mirror the existing convention.
  "cardioRecovery",
  "wristTemperature",
  "fallCount",
  "sixMinuteWalkDistance",
  "stairAscentSpeed",
  "stairDescentSpeed",
  "breathingDisturbances",
  // Chart-overlay slots for the rebuilt `/insights/recovery`
  // page's device-native signal charts. One per chart surface.
  "ansCharge",
  "dayStrain",
  "workoutStrain",
  "cardioLoad",
  "averageHeartRate",
  "maxHeartRate",
  "energyExpenditureKj",
  // The Garmin scores and the bridged training figures.
  "bodyBattery",
  "stressLevel",
  "trainingReadiness",
  "acuteTrainingLoad",
  // Chart-overlay slots for the physical / clinical signal sub-pages.
  // One per chart surface; camel-case keys mirror the existing convention.
  "gripStrength",
  "painNrs",
  "waistCircumference",
  "waistToHeight",
  // The score pages' history charts. Each remembers only its range
  // tab (the charts mount no overlay dropdown), one slot per score page.
  "scoreHealth",
  "scoreReadiness",
  "scoreRecovery",
  "scoreSleep",
  "scoreStress",
  "scoreStrain",
  "bloodKetones", // #1367 — the chart on the ketones page.
  // #1419 — the sleep page's night timeline. It remembers only which night
  // metrics it draws over the stages (`overlayLines`).
  "sleepNight",
] as const;
export type ChartOverlayKey = (typeof CHART_OVERLAY_KEYS)[number];

/**
 * The range tabs (`7 / 30 / 90 / All`) every chart card
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
  // The persisted range-tab selection. Undefined = never saved
  // for this chart yet, so the chart falls back to its own 30 d
  // default rather than forcing every unopened chart to look "saved".
  rangePoints?: ChartRangePoints;
  /**
   * #1419 — the metric lines a chart draws over its own series, at most
   * `MAX_NIGHT_OVERLAY_LINES`. Only the night timeline (`sleepNight`) reads
   * it. Undefined = never chosen, which draws none.
   */
  overlayLines?: NightOverlayKind[];
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
    overlayLines: Array.isArray(candidate.overlayLines)
      ? coerceNightOverlayKinds(candidate.overlayLines)
      : undefined,
  };
}

export function coerceChartOverlayPrefsMap(
  value: unknown,
): ChartOverlayPrefsMap {
  if (!value || typeof value !== "object") return {};
  const out: ChartOverlayPrefsMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isChartOverlayKey(key)) continue;
    out[key] = coerceChartOverlayPrefs(raw);
  }
  return out;
}
