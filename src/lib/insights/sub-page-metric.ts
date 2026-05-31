/**
 * v1.4.25 W4 — slug → metric mapping for the routed insights sub-pages.
 *
 * The mother page (`/insights`) hosts the overview (hero + briefing +
 * trends + advisor). Each named slug below is a sub-route that focuses
 * one metric. Charts on the sub-pages still use the dashboard chart-cog
 * surface — see `chartKey` strings in `src/lib/dashboard-layout.ts`
 * (`CHART_OVERLAY_KEYS`). The slugs themselves are German because the
 * product surface is bilingual and German is the primary author voice.
 *
 * `medikamente` carries no `MeasurementType[]` because medication
 * compliance is event-driven (`MedicationIntakeEvent` rows) rather than
 * time-series `Measurement` rows; the page fetches that data via the
 * existing `/api/insights/comprehensive` consumer.
 *
 * `bmi` lists both `WEIGHT` + `BODY_HEIGHT` because BMI is derived
 * client-side — `WEIGHT / (heightCm/100)^2` — and the chart sets
 * `valueMode="bmi"` on `<HealthChart>`. `BODY_HEIGHT` is informational
 * only (we don't fetch a height series; the user's height lives on the
 * profile).
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
// the strip order. The earlier inline pills (`puls`, `blutdruck`,
// `gewicht`, `bmi`, `schlaf`, `stimmung`, `medikamente`, `workouts`)
// stay flat — they predate v1.4.32 and the maintainer's audit kept
// them as direct entries.
const SUB_PAGE_METRIC = {
  // ── vitals ──
  blutdruck: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"],
  puls: ["PULSE"],
  sauerstoff: ["OXYGEN_SATURATION"],
  koerpertemperatur: ["BODY_TEMPERATURE"],
  // v1.7.0 — respiratory rate joins the vitals cluster.
  atemfrequenz: ["RESPIRATORY_RATE"],
  // ── body composition ──
  gewicht: ["WEIGHT"],
  // BMI is derived from WEIGHT + profile height (no separate series).
  bmi: ["WEIGHT"],
  // v1.7.0 — Withings / Apple body-composition tail.
  koerperwasser: ["TOTAL_BODY_WATER"],
  knochenmasse: ["BONE_MASS"],
  "fettfreie-masse": ["FAT_FREE_MASS"],
  fettmasse: ["FAT_MASS"],
  muskelmasse: ["MUSCLE_MASS"],
  viszeralfett: ["VISCERAL_FAT"],
  magermasse: ["LEAN_BODY_MASS"],
  // ── activity ──
  "aktive-energie": ["ACTIVE_ENERGY_BURNED"],
  // v1.4.32 — workouts surface; the page reads `Workout` rows directly
  // through `useWorkouts()` rather than the `summaries` map, so the
  // metric list stays empty.
  workouts: [],
  // v1.7.0 — activity + Apple-Health Mobility cluster.
  stockwerke: ["FLIGHTS_CLIMBED"],
  gehstrecke: ["WALKING_RUNNING_DISTANCE"],
  gangstabilitaet: ["WALKING_STEADINESS"],
  gehpuls: ["WALKING_HEART_RATE_AVERAGE"],
  gangasymmetrie: ["WALKING_ASYMMETRY"],
  doppelstandphase: ["WALKING_DOUBLE_SUPPORT"],
  schrittlaenge: ["WALKING_STEP_LENGTH"],
  gehgeschwindigkeit: ["WALKING_SPEED"],
  // ── sleep ──
  schlaf: ["SLEEP_DURATION"],
  // ── cardiovascular ──
  ruhepuls: ["RESTING_HEART_RATE"],
  hrv: ["HEART_RATE_VARIABILITY"],
  // v1.7.0 — Withings cardiovascular risk markers.
  pulswellengeschwindigkeit: ["PULSE_WAVE_VELOCITY"],
  gefaessalter: ["VASCULAR_AGE"],
  // ── hearing (v1.7.0) — audio-exposure cluster ──
  laermbelastung: ["AUDIO_EXPOSURE_ENV"],
  kopfhoererpegel: ["AUDIO_EXPOSURE_HEADPHONE"],
  laermereignisse: ["AUDIO_EXPOSURE_EVENT"],
  // ── environment (v1.7.0) ──
  tageslicht: ["TIME_IN_DAYLIGHT"],
  // ── metabolic (v1.7.0) ──
  blutzucker: ["BLOOD_GLUCOSE"],
  hauttemperatur: ["SKIN_TEMPERATURE"],
  // ── mood ──
  stimmung: ["MOOD"],
  // ── events (medication adherence is event-driven; no measurement series) ──
  medikamente: [],
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
// pills (puls, blutdruck, gewicht, bmi, schlaf, stimmung, medikamente,
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
  ruhepuls: "vitals",
  sauerstoff: "vitals",
  koerpertemperatur: "vitals",
  "aktive-energie": "vitals",
  atemfrequenz: "vitals",
  // body composition (v1.7.0)
  koerperwasser: "body",
  knochenmasse: "body",
  "fettfreie-masse": "body",
  fettmasse: "body",
  muskelmasse: "body",
  viszeralfett: "body",
  magermasse: "body",
  // activity / mobility (v1.7.0)
  stockwerke: "activity",
  gehstrecke: "activity",
  gangstabilitaet: "activity",
  gehpuls: "activity",
  gangasymmetrie: "activity",
  doppelstandphase: "activity",
  schrittlaenge: "activity",
  gehgeschwindigkeit: "activity",
  // cardiovascular (v1.7.0)
  pulswellengeschwindigkeit: "cardiovascular",
  gefaessalter: "cardiovascular",
  // hearing (v1.7.0)
  laermbelastung: "hearing",
  kopfhoererpegel: "hearing",
  laermereignisse: "hearing",
  // environment (v1.7.0)
  tageslicht: "environment",
  // metabolic (v1.7.0)
  blutzucker: "metabolic",
  hauttemperatur: "metabolic",
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

