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
export const SUB_PAGE_METRIC = {
  blutdruck: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"],
  gewicht: ["WEIGHT"],
  puls: ["PULSE"],
  stimmung: ["MOOD"],
  // medication adherence is event-driven; no measurement series.
  medikamente: [],
  // BMI is derived from WEIGHT + profile height (no separate series).
  bmi: ["WEIGHT"],
  schlaf: ["SLEEP_DURATION"],
} as const satisfies Record<string, readonly string[]>;

export type SubPageSlug = keyof typeof SUB_PAGE_METRIC;

export const SUB_PAGE_SLUGS = Object.keys(SUB_PAGE_METRIC) as SubPageSlug[];

/**
 * Mother-page route. Kept here as a named constant so call sites
 * never have to hard-code the string.
 */
export const INSIGHTS_OVERVIEW_PATH = "/insights" as const;

