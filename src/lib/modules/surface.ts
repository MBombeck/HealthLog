/**
 * Which module owns which surface, in one declarative map.
 *
 * A module a person switches off has to disappear everywhere at once: the nav
 * entry, the Insights pill, the overview card, the trends slot, the add menu,
 * the dashboard tile, the Settings row, the statistics. Each of those used to
 * keep its own little map (or none), and the ones with none were exactly where
 * a switched-off module kept showing up. This file is the one answer. Every
 * surface a toggleable module owns is listed here as `<kind>:<local id>`, and a
 * surface that is absent belongs to no module and is never hidden by one.
 *
 * The older per-surface maps are views of this one (`surfaceModulesOfKind`),
 * so they cannot drift from it. `src/lib/modules/__tests__/
 * surface-module-registry.test.ts` holds every list of surfaces the app renders
 * against this map.
 *
 * The `insights` key is deliberately absent. It means "AI analysis" (model
 * written text) and owns no surface: the Insights area, its charts and its
 * statistics are data and stay whatever their own module says. The AI
 * capability resolver reads that key; surfaces never do.
 *
 * Pure data plus two pure functions, no server or React dependency, so the
 * server builders and the browser read the same file. The React accessor is
 * `useSurfaceVisible` in `src/hooks/use-surface-visible.ts`.
 *
 * Paint, not enforcement: the routes behind a module refuse on their own
 * through `requireModuleEnabled`. Hiding a surface spares a click that would
 * end in a refusal or an empty chart.
 */
import { ENVIRONMENT_FIELDS } from "@/lib/environment/fields";
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * The surface families. The part of an id before the first `:`.
 *
 *  - `nav`: a navigation destination, by its href (sidebar, bottom bar, the
 *    More hub, the tour stop on that page, and the direct-URL notice).
 *  - `insights-page`: an Insights sub-page, by its slug (the tab-strip pill
 *    and the direct-URL notice under `/insights/<slug>`).
 *  - `overview`: a block on the Insights overview, by its section id.
 *  - `trend`: a trends-row chart slot, by its briefing `sourceMetric`.
 *  - `capture`: an entry in the add menu, by its capture kind.
 *  - `widget`: a dashboard widget, by its layout id.
 *  - `summary`: a dashboard summary key (a `MeasurementType` or a synthetic
 *    key such as `MOOD_ENTRY`), stripped from every summaries feed.
 *  - `derived`: a derived score, by its `DerivedMetricId`.
 *  - `settings`: a Settings section, by its slug.
 *  - `settings-layout`: a Settings, Layout group, by its id.
 *  - `correlation`: a correlation-discovery channel, by its channel key.
 *  - `score-ring`: a dashboard hero score ring, by its `ScoreRingId`.
 *  - `day-section`: a section of the day view, by its `DaySectionKey`. The
 *    day loader blanks a section whose owner is off, and the views drop it.
 *  - `timeline-lane`: a lane of the timeline, by its `TimelineLaneKey`; the
 *    readiness inventory leaves it out the same way.
 */
export const SURFACE_KINDS = [
  "nav",
  "insights-page",
  "overview",
  "trend",
  "capture",
  "widget",
  "summary",
  "derived",
  "settings",
  "settings-layout",
  "correlation",
  "score-ring",
  "day-section",
  "timeline-lane",
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

const STATIC_SURFACE_MODULE = {
  // ── Navigation destinations ──
  // `/insights` carries no owner: the area is data, not AI analysis.
  "nav:/mood": "mood",
  "nav:/mental-wellbeing": "mentalHealth",
  "nav:/cycle": "cycle",
  "nav:/medications": "medications",
  "nav:/labs": "labs",
  "nav:/illness": "illness",
  "nav:/vaccinations": "vaccinations",
  "nav:/documents": "inboundDocuments",
  "nav:/coach": "coach",
  "nav:/achievements": "achievements",
  "nav:/timeline": "timeline",

  // ── Insights sub-pages ──
  "insights-page:mood": "mood",
  "insights-page:sleep": "sleep",
  // The per-night breathing-disturbance index is a sleep-page signal.
  "insights-page:breathing-disturbances": "sleep",
  "insights-page:blood-glucose": "glucose",
  "insights-page:workouts": "workouts",
  "insights-page:nutrients": "nutrients",
  // Medications is surface-gated by design: its data routes stay open so an
  // import or a sync keeps working, and these surfaces are what the switch
  // hides.
  "insights-page:medications": "medications",
  // Recovery is a composite page, not a slug with a series; the four
  // HealthKit recovery metrics below are the same module's, as on the
  // dashboard (`widget:cardioRecovery` …).
  "insights-page:recovery": "recovery",
  "insights-page:cardio-recovery": "recovery",
  "insights-page:six-minute-walk": "recovery",
  "insights-page:stair-ascent-speed": "recovery",
  "insights-page:stair-descent-speed": "recovery",
  // The resting heart rate is the recovery module's `resting_hr` domain; its
  // page, trend slot, correlation channel and summary key follow it.
  "insights-page:resting-pulse": "recovery",

  // ── Insights overview blocks ──
  "overview:cycle-summary": "cycle",
  // The cycle ring rides the wellness-scores strip rather than being a
  // section of its own; it follows the same key as the cycle summary, so the
  // two cannot disagree.
  "overview:cycle-ring": "cycle",
  // Breathing disturbances are measured overnight; the screening card is the
  // sleep module's.
  "overview:breathing": "sleep",
  "overview:labs-changes": "labs",

  // ── Trends row ──
  "trend:mood": "mood",
  "trend:sleep": "sleep",
  "trend:resting_hr": "recovery",

  // ── Add menu ──
  "capture:mood": "mood",
  "capture:medication": "medications",
  "capture:workout": "workouts",
  // v1.40 — an occurrence of a person-defined symptom rides the illness module.
  "capture:symptom": "illness",

  // ── Dashboard widgets ──
  // CORE widgets (weight, blood pressure, pulse, body fat, the vital-derived
  // HealthKit metrics) carry no entry and are never hidden.
  "widget:mood": "mood",
  "widget:sleep": "sleep",
  "widget:glucose": "glucose",
  "widget:achievements": "achievements",
  "widget:recentWorkouts": "workouts",
  "widget:medications": "medications",
  "widget:cardioRecovery": "recovery",
  "widget:sixMinuteWalk": "recovery",
  "widget:stairAscentSpeed": "recovery",
  "widget:stairDescentSpeed": "recovery",
  "widget:breathingDisturbances": "sleep",
  // The fluid-intake tile reads the nutrient store.
  "widget:waterIntake": "nutrients",

  // ── Dashboard summary keys ──
  "summary:SLEEP_DURATION": "sleep",
  "summary:BLOOD_GLUCOSE": "glucose",
  "summary:CARDIO_RECOVERY": "recovery",
  // The recovery module owns the resting_hr domain (`measurement-scope.ts`),
  // so the server gates the type on it; the form and the dashboard follow.
  "summary:RESTING_HEART_RATE": "recovery",
  "summary:SIX_MINUTE_WALK_DISTANCE": "recovery",
  "summary:STAIR_ASCENT_SPEED": "recovery",
  "summary:STAIR_DESCENT_SPEED": "recovery",
  // The nightly RMSSD series is the recovery module's. The dashboard HRV tile
  // falls back to it when an account has no SDNN, and a fallback must not
  // serve recovery data the primary type refuses. `HEART_RATE_VARIABILITY`
  // (SDNN) is a plain vital and stays unowned.
  "summary:HRV_RMSSD": "recovery",
  "summary:BREATHING_DISTURBANCES": "sleep",
  // Synthetic keys: derived from `NutrientIntakeDay` and `MoodEntry` rather
  // than a `MeasurementType`, riding the same gate.
  "summary:NUTRIENT_WATER": "nutrients",
  "summary:MOOD_ENTRY": "mood",

  // ── Derived scores ──
  // READINESS equals the computed recovery score, so it follows recovery.
  // Composite baselines built on core vitals (VITALS_BASELINE, HRV_BALANCE …)
  // carry no entry.
  "derived:SLEEP_SCORE": "sleep",
  "derived:RECOVERY_SCORE": "recovery",
  "derived:STRAIN_SCORE": "recovery",
  "derived:STRESS_SCORE": "recovery",
  "derived:READINESS": "recovery",

  // ── Dashboard hero score rings ──
  // The three derived rings follow their derived score; the dose ring is
  // medications'.
  "score-ring:READINESS": "recovery",
  "score-ring:RECOVERY_SCORE": "recovery",
  "score-ring:SLEEP_SCORE": "sleep",
  "score-ring:MED_COMPLIANCE": "medications",

  // ── Settings sections ──
  "settings:environment": "environment",
  "settings:coach": "coach",

  // ── Settings, Layout groups ──
  "settings-layout:medications": "medications",
  "settings-layout:mood": "mood",
  "settings-layout:labs": "labs",
  "settings-layout:illness": "illness",

  // ── Correlation channels ──
  // Rated mood factors (`FACTOR:<key>`) are mood's too; see
  // `correlationChannelSurfaceId`.
  "correlation:MOOD": "mood",
  "correlation:SLEEP_DURATION": "sleep",
  "correlation:BLOOD_GLUCOSE": "glucose",
  "correlation:RESTING_HEART_RATE": "recovery",
  "correlation:MEDICATION_COMPLIANCE": "medications",
  // Symptom burden is read from the illness journal.
  "correlation:SYMPTOM_SEVERITY": "illness",
  // The labs ↔ outcome pass over lab draws.
  "correlation:LAB_DRAWS": "labs",

  // ── Day view sections (v1.42) ──
  // The readings carry no owner here: each value follows its own type's
  // module (`moduleForMeasurementType`), so a section-level owner would hide
  // the core vitals with it. Allergies, visits, check-ups and the anamnesis
  // facts are core record surfaces and stay unowned.
  "day-section:sleep": "sleep",
  "day-section:mood": "mood",
  "day-section:assessments": "mentalHealth",
  "day-section:medications": "medications",
  "day-section:illness": "illness",
  // Person-defined symptoms ride the illness module, as everywhere else.
  "day-section:symptoms": "illness",
  "day-section:labs": "labs",
  "day-section:vaccinations": "vaccinations",
  "day-section:documents": "inboundDocuments",
  "day-section:workouts": "workouts",
  "day-section:cycle": "cycle",
  "day-section:environment": "environment",
  // Life events are the timeline module's own content: off, they leave the
  // day as well.
  "day-section:lifeEvents": "timeline",

  // ── Timeline lanes (v1.42) ──
  // The `life` lane mixes life events (this module) with travel periods (the
  // environment module) and is filtered item by item; allergies and visits are
  // core.
  "timeline-lane:illness": "illness",
  "timeline-lane:medications": "medications",
  "timeline-lane:vaccinations": "vaccinations",
  "timeline-lane:labs": "labs",
  "timeline-lane:documents": "inboundDocuments",
  "timeline-lane:cycle": "cycle",
} as const satisfies Record<string, ModuleKey>;

/** A surface id the map declares literally. */
export type StaticSurfaceId = keyof typeof STATIC_SURFACE_MODULE;

/**
 * The map. The weather channels are spread in from the environment field
 * table so a field added there is owned the moment it exists.
 */
export const SURFACE_MODULE: Readonly<Record<string, ModuleKey>> =
  Object.freeze({
    ...STATIC_SURFACE_MODULE,
    ...Object.fromEntries(
      ENVIRONMENT_FIELDS.map((field) => [
        `correlation:${field.key}`,
        "environment" as const,
      ]),
    ),
  });

/**
 * A partial `ModuleKey → enabled` map: the `modules` field of
 * `GET /api/auth/me`, or `resolveModuleMap()` on the server. Only an explicit
 * `false` hides; a missing key or a missing map reads as on, matching the
 * gate's default-on contract.
 */
export type SurfaceModuleMap = Partial<Record<ModuleKey, boolean>>;

/** The module that owns a surface, or `undefined` for an unowned one. */
export function surfaceModule(surfaceId: string): ModuleKey | undefined {
  return Object.prototype.hasOwnProperty.call(SURFACE_MODULE, surfaceId)
    ? SURFACE_MODULE[surfaceId]
    : undefined;
}

/**
 * Whether a surface shows under a module map. An unowned surface always
 * shows; an owned one hides only when its module is explicitly `false`.
 *
 * Takes any string so callers can build ids from runtime values
 * (`widget:${id}`); the guard test is what keeps those ids honest.
 */
export function isSurfaceVisible(
  surfaceId: StaticSurfaceId | (string & {}),
  modules: SurfaceModuleMap | null | undefined,
): boolean {
  const owner = surfaceModule(surfaceId);
  if (owner === undefined) return true;
  return modules?.[owner] !== false;
}

/**
 * One family of the map with the `<kind>:` prefix stripped: `{ mood: "mood",
 * recentWorkouts: "workouts", … }` for `"widget"`. This is how the older
 * per-surface maps (`WIDGET_MODULE_BY_ID`, `SUMMARY_TYPE_MODULE`, …) are now
 * built, so they are views of this file rather than copies of it.
 */
export function surfaceModulesOfKind(
  kind: SurfaceKind,
): Partial<Record<string, ModuleKey>> {
  const prefix = `${kind}:`;
  const out: Partial<Record<string, ModuleKey>> = {};
  for (const [id, owner] of Object.entries(SURFACE_MODULE)) {
    if (id.startsWith(prefix)) out[id.slice(prefix.length)] = owner;
  }
  return out;
}

/**
 * The surface id of a correlation channel. Rated mood factors carry their own
 * `FACTOR:<key>` channel names but are mood entries all the same, so they
 * resolve to the mood channel; person-defined symptoms (`SYMPTOM:<id>`) resolve
 * to the illness symptom channel the same way.
 */
export function correlationChannelSurfaceId(channelKey: string): string {
  if (channelKey.startsWith("FACTOR:")) return "correlation:MOOD";
  // A person-defined symptom (`SYMPTOM:<id>`, v1.40) rides the illness
  // module, like the symptom-burden channel it sits beside.
  if (channelKey.startsWith("SYMPTOM:")) return "correlation:SYMPTOM_SEVERITY";
  return `correlation:${channelKey}`;
}
