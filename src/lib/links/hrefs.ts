/**
 * Every in-app link to a record kind or a metric page, spelled once.
 *
 * Surfaces that point at a record (the day view, the timeline lanes, search
 * hits, what changed since the last visit) or at a metric's page (the
 * briefing, the dashboard tiles, milestones, the `/insights?metric=` deep
 * links, a value's name in the day and on the timeline) take the address
 * from here. Each used to spell it by hand, and the spellings drifted: a dose
 * opened a redirect page, a lab day opened the bare list, VO₂ max had two
 * pages. `route-literal-guard.test.ts` keeps route literals for these pages
 * out of the producers and ratchets them everywhere else.
 *
 * What a link may carry is what its page reads:
 *  - `?day=YYYY-MM-DD` on any page opens the day layer over it (the shell
 *    mounts it for every page, `src/components/day/day-layer.tsx`), so a
 *    day link names the page the day is about and the day itself;
 *  - `?tab=` on a medication (`medication-detail-tabs.tsx`), `?analyte=` on
 *    the lab list (`src/app/labs/page.tsx`), `?from&to` on the mood list
 *    (`mood-list-filters.ts`);
 *  - one record by id: `?dose=` (vaccinations), `?doc=` (documents),
 *    `?event=` (seizures), `?symptom=` (illness), `?assessment=`
 *    (mental wellbeing), each read through `useDeepLinkedRecord`.
 *
 * Visits and treatment series live on the care page, whose two spellings
 * (wire and web) are owned by `src/lib/encounters/visit-links.ts`; the record
 * table names its builders, and `webHref` turns a wire path into the one the
 * browser opens without the redirect.
 *
 * Pure and client-safe: no server imports.
 */
import type { CoachScopeSource } from "@/lib/ai/coach/types";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import { DAY_QUERY_PARAM, type DateKey } from "@/lib/day/contract";
import {
  CARE_WEB_PATH,
  CARE_WIRE_PATH,
  treatmentSeriesPath,
  visitPath,
} from "@/lib/encounters/visit-links";
import {
  SUB_PAGE_SLUGS,
  subPageSlugForType,
  type SubPageSlug,
} from "@/lib/insights/sub-page-metric";

/* ─── Pages ──────────────────────────────────────────────────────────────── */

/** The pages a link may open without naming a record. */
const PAGES = {
  medications: "/medications",
  illness: "/illness",
  labs: "/labs",
  mood: "/mood",
  seizures: "/seizures",
  mentalWellbeing: "/mental-wellbeing",
  vaccinations: "/vaccinations",
  documents: "/documents",
  insights: "/insights",
  cycle: "/cycle",
  profile: "/profile",
  timeline: "/timeline",
  measurements: "/measurements",
} as const;

export type AppPage = keyof typeof PAGES;

/** A page as it is, with nothing open. */
export function pageHref(page: AppPage): string {
  return PAGES[page];
}

/** The cycle page on its settings tab (`?tab=` is read by the cycle page). */
export const CYCLE_SETTINGS_HREF = `${PAGES.cycle}?tab=settings`;

/** The workouts page, a domain page the Insights shell hosts. */
export const WORKOUTS_HREF = `${PAGES.insights}/workouts`;

/** A page with the day layer open on `day` over it. */
export function dayHref(page: AppPage, day: DateKey): string {
  return `${PAGES[page]}?${DAY_QUERY_PARAM}=${day}`;
}

/* ─── Records ────────────────────────────────────────────────────────────── */

const id = encodeURIComponent;

/** One record, by its kind and id (an analyte by its name). */
const RECORDS = {
  medication: (v: string) => `${PAGES.medications}/${id(v)}`,
  /** The medication's dose history, where intakes and dose changes live. */
  medicationHistory: (v: string) => `${PAGES.medications}/${id(v)}?tab=history`,
  illness: (v: string) => `${PAGES.illness}/${id(v)}`,
  symptom: (v: string) => `${PAGES.illness}?symptom=${id(v)}`,
  biomarker: (v: string) => `${PAGES.labs}/${id(v)}`,
  analyte: (v: string) => `${PAGES.labs}?analyte=${id(v)}`,
  vaccination: (v: string) => `${PAGES.vaccinations}?dose=${id(v)}`,
  document: (v: string) => `${PAGES.documents}?doc=${id(v)}`,
  seizure: (v: string) => `${PAGES.seizures}?event=${id(v)}`,
  assessment: (v: string) => `${PAGES.mentalWellbeing}?assessment=${id(v)}`,
  workout: (v: string) => `${PAGES.insights}/workouts/${id(v)}`,
  /** On the wire: the care page keeps `/checkups` there for older iOS. */
  visit: visitPath,
  treatmentSeries: treatmentSeriesPath,
} as const satisfies Record<string, (value: string) => string>;

export type RecordHrefKind = keyof typeof RECORDS;

export const RECORD_HREF_KINDS = Object.keys(RECORDS) as RecordHrefKind[];

export function recordHref(kind: RecordHrefKind, value: string): string {
  return RECORDS[kind](value);
}

/** A lab reading: its marker's page, else the list filtered to its name. */
export function labHref(reading: {
  biomarkerId: string | null;
  analyte?: string | null;
}): string {
  if (reading.biomarkerId) return recordHref("biomarker", reading.biomarkerId);
  if (reading.analyte) return recordHref("analyte", reading.analyte);
  return PAGES.labs;
}

/**
 * A day of lab readings: the marker when every reading of the day is one
 * marker, otherwise the day itself over the lab list.
 */
export function labDayHref(
  day: DateKey,
  biomarkerIds: readonly (string | null)[],
): string {
  const ids = new Set(biomarkerIds);
  const [only] = ids;
  return ids.size === 1 && only
    ? recordHref("biomarker", only)
    : dayHref("labs", day);
}

/** The mood list filtered to one day, where the day's entries and notes sit. */
export function moodDayHref(day: DateKey): string {
  return `${PAGES.mood}?from=${day}&to=${day}`;
}

/**
 * A server-built link as the browser opens it: a care-page path on the wire
 * (`/checkups…`, kept there for older iOS builds) becomes its web spelling,
 * so a click lands on the page instead of on the redirect. Anything else is
 * returned as it is.
 */
export function webHref(href: string): string {
  if (
    href === CARE_WIRE_PATH ||
    href.startsWith(`${CARE_WIRE_PATH}?`) ||
    href.startsWith(`${CARE_WIRE_PATH}#`)
  ) {
    return `${CARE_WEB_PATH}${href.slice(CARE_WIRE_PATH.length)}`;
  }
  return href;
}

/* ─── Metric pages ───────────────────────────────────────────────────────── */

/**
 * The one table of metric pages that are not a measurement type's own
 * sub-page. Everything else resolves through `SUB_PAGE_METRIC`
 * (`subPageSlugForType`): a measurement type, a Coach source key through its
 * types, or a sub-page slug as it is. Keys are lower case with dashes.
 */
const METRIC_PAGES: ReadonlyMap<string, string> = new Map([
  // Medication adherence and the GLP-1 plateau read intake events.
  ["compliance", "medications"],
  ["glp1-plateau", "medications"],
  // Derived scores with pages of their own.
  ["health-score", "scores/health"],
  ["readiness", "scores/readiness"],
  ["sleep-score", "scores/sleep"],
  ["stress-score", "scores/stress"],
  ["strain-score", "scores/strain"],
  ["recovery", "recovery"],
]);

const SLUGS: ReadonlySet<string> = new Set(SUB_PAGE_SLUGS);

/** An insights sub-page. */
export function insightsPageHref(slug: SubPageSlug): string {
  return `${PAGES.insights}/${slug}`;
}

/** The list of one measurement type's values, for a type with no page. */
export function measurementValuesHref(type: string): string {
  return `${PAGES.insights}/values/${id(type)}`;
}

/**
 * The page a metric opens, in any spelling the app carries: a measurement
 * type (`VO2_MAX`), a Coach source or briefing key (`vo2_max`, `resting_hr`,
 * `bp`), a sub-page slug (`cardio-fitness`), or one of the keys above. Null
 * when the metric has no page of its own.
 */
export function metricHref(key: string): string | null {
  const raw = key.trim();
  if (raw === "") return null;
  const lower = raw.toLowerCase();
  const dashed = lower.replace(/_/g, "-");
  const page = METRIC_PAGES.get(dashed);
  if (page) return `${PAGES.insights}/${page}`;
  if (SLUGS.has(dashed)) return insightsPageHref(dashed as SubPageSlug);
  const sourceTypes = Object.hasOwn(COACH_SOURCE_MEASUREMENT_TYPES, lower)
    ? COACH_SOURCE_MEASUREMENT_TYPES[lower as CoachScopeSource]
    : [];
  const type = sourceTypes[0] ?? raw.toUpperCase();
  const slug = subPageSlugForType(type);
  return slug ? insightsPageHref(slug) : null;
}

/** A measurement type's page, or its value list when it has none. */
export function measurementTypeHref(type: string): string {
  return metricHref(type) ?? measurementValuesHref(type);
}
