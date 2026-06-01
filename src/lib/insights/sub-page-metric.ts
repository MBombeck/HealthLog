/**
 * v1.4.25 W4 — slug → metric mapping for the routed insights sub-pages.
 *
 * The mother page (`/insights`) hosts the overview (hero + briefing +
 * trends + advisor). Each named slug below is a sub-route that focuses
 * one metric. Charts on the sub-pages still use the dashboard chart-cog
 * surface — see `chartKey` strings in `src/lib/dashboard-layout.ts`
 * (`CHART_OVERLAY_KEYS`).
 *
 * v1.8.0 — the slugs are English. They were German through v1.7.x; the
 * naming-convention ADR (`docs/adr/0001-insights-naming-convention.md`)
 * settled the surface: UI copy stays localised (resolved through `t()`
 * keys), but internal identifiers — route slugs, tile ids, query keys —
 * are English. Legacy `/insights/<de-slug>` URLs 301-redirect to their
 * English target via `next.config.ts` `redirects()`.
 *
 * `medications` carries no `MeasurementType[]` because medication
 * compliance is event-driven (`MedicationIntakeEvent` rows) rather than
 * time-series `Measurement` rows; the page fetches that data via the
 * existing `/api/insights/comprehensive` consumer.
 *
 * `bmi` lists `WEIGHT` because BMI is derived client-side —
 * `WEIGHT / (heightCm/100)^2` — and the chart sets `valueMode="bmi"` on
 * `<HealthChart>`. The user's height lives on the profile, so there is
 * no separate height series to fetch.
 */
/**
 * Single source of truth for the routed insights sub-pages. The slug
 * enum, the slug array, and the per-slug metric list all derive from
 * the keys of this record — adding a sub-page is a one-place change.
 */
// v1.4.33 F9 — order follows the MeasurementCategory overlay
// (`src/lib/measurements/categories.ts`):
//
//   vitals → body → activity → sleep → cardiovascular → mood → events
//
// v1.4.34 IW-D — the five wave-A HealthKit entries (HRV, resting HR,
// SpO2, body temperature, active energy) added in v1.4.32 share a
// presentation group on the routed tab strip. Each sub-page keeps its
// own URL and own page component — only the strip presentation changes
// so the five pills collapse behind one "Vitalwerte" / "Vitals" parent
// pill with a popover sub-list. The `group: "vitals"` field below
// drives that grouping; the canonical order inside the popover follows
// the strip order. The earlier inline pills (`pulse`, `blood-pressure`,
// `weight`, `bmi`, `sleep`, `mood`, `medications`, `workouts`) stay
// flat — they predate v1.4.32 and the maintainer's audit kept them as
// direct entries.
const SUB_PAGE_METRIC = {
  // ── vitals ──
  "blood-pressure": ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"],
  pulse: ["PULSE"],
  oxygen: ["OXYGEN_SATURATION"],
  "body-temperature": ["BODY_TEMPERATURE"],
  // v1.7.0 — respiratory rate joins the vitals cluster.
  "respiratory-rate": ["RESPIRATORY_RATE"],
  // ── body composition ──
  weight: ["WEIGHT"],
  // BMI is derived from WEIGHT + profile height (no separate series).
  bmi: ["WEIGHT"],
  // v1.7.0 — Withings / Apple body-composition tail.
  "body-water": ["TOTAL_BODY_WATER"],
  "bone-mass": ["BONE_MASS"],
  "fat-free-mass": ["FAT_FREE_MASS"],
  "fat-mass": ["FAT_MASS"],
  "muscle-mass": ["MUSCLE_MASS"],
  "visceral-fat": ["VISCERAL_FAT"],
  "lean-body-mass": ["LEAN_BODY_MASS"],
  // ── activity ──
  "active-energy": ["ACTIVE_ENERGY_BURNED"],
  // v1.4.32 — workouts surface; the page reads `Workout` rows directly
  // through `useWorkouts()` rather than the `summaries` map, so the
  // metric list stays empty.
  workouts: [],
  // v1.7.0 — activity + Apple-Health Mobility cluster.
  "flights-climbed": ["FLIGHTS_CLIMBED"],
  "walking-distance": ["WALKING_RUNNING_DISTANCE"],
  "walking-steadiness": ["WALKING_STEADINESS"],
  "walking-heart-rate": ["WALKING_HEART_RATE_AVERAGE"],
  "walking-asymmetry": ["WALKING_ASYMMETRY"],
  "double-support-time": ["WALKING_DOUBLE_SUPPORT"],
  "step-length": ["WALKING_STEP_LENGTH"],
  "walking-speed": ["WALKING_SPEED"],
  // ── sleep ──
  sleep: ["SLEEP_DURATION"],
  // ── cardiovascular ──
  "resting-pulse": ["RESTING_HEART_RATE"],
  hrv: ["HEART_RATE_VARIABILITY"],
  // v1.7.0 — Withings cardiovascular risk markers.
  "pulse-wave-velocity": ["PULSE_WAVE_VELOCITY"],
  "vascular-age": ["VASCULAR_AGE"],
  // ── hearing (v1.7.0) — audio-exposure cluster ──
  "environmental-audio": ["AUDIO_EXPOSURE_ENV"],
  "headphone-audio": ["AUDIO_EXPOSURE_HEADPHONE"],
  "audio-events": ["AUDIO_EXPOSURE_EVENT"],
  // ── environment (v1.7.0) ──
  daylight: ["TIME_IN_DAYLIGHT"],
  // ── metabolic (v1.7.0) ──
  "blood-glucose": ["BLOOD_GLUCOSE"],
  "skin-temperature": ["SKIN_TEMPERATURE"],
  // ── mood ──
  mood: ["MOOD"],
  // ── events (medication adherence is event-driven; no measurement series) ──
  medications: [],
} as const satisfies Record<string, readonly string[]>;

export type SubPageSlug = keyof typeof SUB_PAGE_METRIC;

export const SUB_PAGE_SLUGS = Object.keys(SUB_PAGE_METRIC) as SubPageSlug[];

/**
 * v1.4.34 IW-D — strip-presentation grouping. Only `"vitals"` is in
 * use today; every other slug renders as a top-level pill. The group
 * key is rendered through a single parent pill that opens a popover
 * containing the grouped sub-pages. Adding a new group is a one-row
 * change here plus a matching label key under
 * `insights.tabStrip.<group>Parent.*` in every locale.
 */
// v1.7.0 — the new metric clusters each collapse behind a parent pill
// so the strip stays scannable as the sub-page count grows. The flat
// pills (pulse, blood-pressure, weight, bmi, sleep, mood, medications,
// workouts) stay direct entries as before.
export type SubPageGroup =
  | "vitals"
  | "body"
  | "activity"
  | "cardiovascular"
  | "hearing"
  | "environment"
  | "metabolic";

export const SUB_PAGE_GROUP: Partial<Record<SubPageSlug, SubPageGroup>> = {
  // vitals
  hrv: "vitals",
  "resting-pulse": "vitals",
  oxygen: "vitals",
  "body-temperature": "vitals",
  "active-energy": "vitals",
  "respiratory-rate": "vitals",
  // body composition (v1.7.0)
  "body-water": "body",
  "bone-mass": "body",
  "fat-free-mass": "body",
  "fat-mass": "body",
  "muscle-mass": "body",
  "visceral-fat": "body",
  "lean-body-mass": "body",
  // activity / mobility (v1.7.0)
  "flights-climbed": "activity",
  "walking-distance": "activity",
  "walking-steadiness": "activity",
  "walking-heart-rate": "activity",
  "walking-asymmetry": "activity",
  "double-support-time": "activity",
  "step-length": "activity",
  "walking-speed": "activity",
  // cardiovascular (v1.7.0)
  "pulse-wave-velocity": "cardiovascular",
  "vascular-age": "cardiovascular",
  // hearing (v1.7.0)
  "environmental-audio": "hearing",
  "headphone-audio": "hearing",
  "audio-events": "hearing",
  // environment (v1.7.0)
  daylight: "environment",
  // metabolic (v1.7.0)
  "blood-glucose": "metabolic",
  "skin-temperature": "metabolic",
};

/**
 * v1.4.34 IW-D — canonical order of the sub-pages inside each parent
 * popover. The strip iterates `SUB_PAGE_SLUGS`, so a member's position
 * in the popover follows its position in that array.
 */
export const SUB_PAGE_GROUP_ORDER: Record<SubPageGroup, readonly SubPageSlug[]> =
  {
    vitals: SUB_PAGE_SLUGS.filter((slug) => SUB_PAGE_GROUP[slug] === "vitals"),
    body: SUB_PAGE_SLUGS.filter((slug) => SUB_PAGE_GROUP[slug] === "body"),
    activity: SUB_PAGE_SLUGS.filter(
      (slug) => SUB_PAGE_GROUP[slug] === "activity",
    ),
    cardiovascular: SUB_PAGE_SLUGS.filter(
      (slug) => SUB_PAGE_GROUP[slug] === "cardiovascular",
    ),
    hearing: SUB_PAGE_SLUGS.filter((slug) => SUB_PAGE_GROUP[slug] === "hearing"),
    environment: SUB_PAGE_SLUGS.filter(
      (slug) => SUB_PAGE_GROUP[slug] === "environment",
    ),
    metabolic: SUB_PAGE_SLUGS.filter(
      (slug) => SUB_PAGE_GROUP[slug] === "metabolic",
    ),
  };

/**
 * Mother-page route. Kept here as a named constant so call sites
 * never have to hard-code the string.
 */
export const INSIGHTS_OVERVIEW_PATH = "/insights" as const;

