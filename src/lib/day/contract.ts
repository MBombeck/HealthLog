/**
 * The day view and the timeline: the contract every part of v1.42 builds
 * against (#613).
 *
 * One file, so the server that answers, the web views that render and the
 * native client that decodes agree on one set of names. Constants and types
 * only, no Zod and no server import: the navigation chrome and the surface map
 * import from here, and neither may pull a validator into the client bundle.
 * The request and response schemas live beside it in `./wire-schemas.ts`, and
 * every response type below is inferred from them, so the two cannot drift.
 *
 * Five route families speak it:
 *
 *   GET    /api/day/{date}         one local day across the record
 *   GET    /api/day/index          which days hold anything, for a window
 *   GET    /api/day/notable        what changed since the last visit
 *   GET    /api/timeline           lanes, standing items and value series
 *   GET    /api/timeline/readiness what the timeline can already show
 *   GET    /api/life-events        the record's life events
 *   POST   /api/life-events
 *   PATCH  /api/life-events/{id}
 *   DELETE /api/life-events/{id}
 *
 * Rules the shapes carry rather than restate:
 *
 *   - A day is the local calendar day in the record's time zone, never a UTC
 *     slice. The day route reads the rows live; the rollups cut at UTC.
 *   - The server decides and the clients render. Nothing here asks a client to
 *     recompute a band, a running-day count or a verdict. `notable` and the
 *     readiness details are keys with parameters; the wording lives in the
 *     message bundles, never in a model.
 *   - A section of a switched-off module is absent, not empty. A section the
 *     caller's grant does not cover is named in `sections` with
 *     `not_shared`, so the view can say so once.
 *   - Life events are part of the `profile` sharing domain and never reach a
 *     model: the model-facing projection of a day drops
 *     {@link MODEL_EXCLUDED_DAY_SECTIONS}.
 */
import type { z } from "zod/v4";

import type {
  dayIndexResponseSchema,
  dayNotableResponseSchema,
  dayResponseSchema,
  lifeEventCreateSchema,
  lifeEventListResponseSchema,
  lifeEventSchema,
  lifeEventUpdateSchema,
  timelineQuerySchema,
  timelineReadinessResponseSchema,
  timelineResponseSchema,
} from "./wire-schemas";

/* ─── Calendar dates ──────────────────────────────────────────────────────── */

/**
 * A local calendar date, `YYYY-MM-DD`. The `?day=` parameter, the day route's
 * path segment and every date-only field below use it.
 */
export type DateKey = string;

/** The URL parameter that opens the day layer over any page. */
export const DAY_QUERY_PARAM = "day";

/** Widest window `GET /api/day/index` answers, in days, both ends included. */
export const DAY_INDEX_MAX_SPAN_DAYS = 366;

/* ─── Day sections ────────────────────────────────────────────────────────── */

/**
 * The sections of a day, in the order the view shows them. Each one is a
 * surface in `src/lib/modules/surface.ts` (`day-section:<key>`) when a module
 * owns it; a section without an owner is part of the core record.
 *
 *   values       readings in the local day window, canonical source per type
 *   sleep        the night that ended on this morning
 *   mood         mood entries for the date
 *   assessments  mental-health screeners taken that day
 *   medications  intakes, dose changes, pauses, course starts and ends
 *   illness      episodes running or starting, their day logs
 *   symptoms     occurrences of person-defined symptoms
 *   allergies    an allergy whose onset is this day
 *   labs         results drawn that day
 *   visits       visits and procedures
 *   vaccinations doses given that day
 *   checkups     preventive check-ups completed that day
 *   documents    documents dated that day
 *   workouts     sessions started that day
 *   cycle        the cycle phase and the day log
 *   environment  the day's environment row and a travel period
 *   lifeEvents   life events dated that day at DAY precision, or spanning it
 */
export const DAY_SECTION_KEYS = [
  "values",
  "sleep",
  "mood",
  "assessments",
  "medications",
  "illness",
  "symptoms",
  "allergies",
  "labs",
  "visits",
  "vaccinations",
  "checkups",
  "documents",
  "workouts",
  "cycle",
  "environment",
  "lifeEvents",
] as const;

export type DaySectionKey = (typeof DAY_SECTION_KEYS)[number];

/**
 * Sections a model never sees, whatever it asks for. The Coach and the MCP
 * endpoint read a day through `get_day`, and that projection drops these
 * before anything leaves the instance (v1.42: life events go to no model).
 */
export const MODEL_EXCLUDED_DAY_SECTIONS = [
  "lifeEvents",
] as const satisfies readonly DaySectionKey[];

/** Why a section is missing from a day the caller can otherwise read. */
export const DAY_SECTION_UNAVAILABLE_REASONS = [
  /** The grant the caller reads under does not cover the section's domain. */
  "not_shared",
  /**
   * The owning module is off. Only the model-facing projection (`get_day`)
   * reports it, as `{ present: false, reason: "module_disabled" }`; the web
   * and native views omit the section without a word.
   */
  "module_disabled",
] as const;

export type DaySectionUnavailableReason =
  (typeof DAY_SECTION_UNAVAILABLE_REASONS)[number];

/**
 * Something that runs through the day rather than happening on it: a record
 * with a start of its own (a medication, a course, a pause, an illness, a
 * cycle, a trip, a life event that spans days). Profile facts such as smoking
 * status or a shift pattern are not here: they describe the person, they
 * hold no start the person gave, and counting "day n" from when they were
 * filed would state a duration nobody recorded.
 */
export const DAY_RUNNING_KINDS = [
  "medication",
  "medicationCourse",
  "medicationPause",
  "illness",
  "restMode",
  "cyclePhase",
  "travel",
  "lifeEvent",
] as const;

export type DayRunningKind = (typeof DAY_RUNNING_KINDS)[number];

/** Something that happened on the day, at a time or on the date. */
export const DAY_EVENT_KINDS = [
  "intake",
  "doseChange",
  "medicationStart",
  "medicationEnd",
  "pauseStart",
  "pauseEnd",
  "courseStart",
  "courseEnd",
  "illnessOnset",
  "illnessResolved",
  "illnessDayLog",
  "symptom",
  "allergyOnset",
  "labResult",
  "visit",
  "procedure",
  "vaccination",
  "checkup",
  "document",
  "mood",
  "assessment",
  "workout",
  "cycleDayLog",
  "lifeEvent",
] as const;

export type DayEventKind = (typeof DAY_EVENT_KINDS)[number];

/**
 * Deterministic, descriptive observations. No cause, no verdict: "highest
 * morning value since March 2025", never "because of". The client words them
 * from `day.notable.<kind>` with the parameters the server sends.
 *
 *   extremeHigh / extremeLow  highest or lowest daily value of a type for at
 *                             least three months, with at least 30 days of
 *                             history (`params.since`, `params.value`)
 *   firstValue                the first reading of a type ever (`params.type`)
 *   gap                       a type that came at least three times a week
 *                             and then stopped for 14 days (`params.days`);
 *                             only in the visit preparation and readiness
 */
export const DAY_NOTABLE_KINDS = [
  "extremeHigh",
  "extremeLow",
  "firstValue",
  "gap",
] as const;

export type DayNotableKind = (typeof DAY_NOTABLE_KINDS)[number];

/* ─── Timeline ────────────────────────────────────────────────────────────── */

/** Zoom levels. `all` bundles hardest: no symptoms, no single intakes. */
export const TIMELINE_ZOOMS = ["all", "year", "quarter"] as const;

export type TimelineZoom = (typeof TIMELINE_ZOOMS)[number];

/**
 * The span one value-series point averages. The server picks it per zoom
 * (`timelineBucket` in `src/lib/timeline/load-timeline.ts`): quarters for a
 * multi-year `all`, months for `year` and a short `all`, weeks for `quarter`.
 */
export const TIMELINE_BUCKETS = ["quarter", "month", "week"] as const;

export type TimelineBucket = (typeof TIMELINE_BUCKETS)[number];

/**
 * The most value series one request may name. Each series is its own row
 * under the lanes, drawn in neutral ink and labelled at the left, so the cap
 * is the chart's height, not a palette: six rows add 360 px under the lanes.
 */
export const TIMELINE_MAX_SERIES = 6;

/**
 * The lanes, top to bottom. An empty lane is not sent. Each lane a module
 * owns is a surface (`timeline-lane:<key>`) and disappears with it.
 *
 *   life         life events, and travel periods from the environment module
 *   illness      episodes, chronic conditions as open lines
 *   allergies    allergies with an onset; the rest are `standing`
 *   medications  medications and courses, dose marks, pauses as gaps
 *   vaccinations doses
 *   visits       visits and procedures
 *   labs         days with results
 *   documents    dated documents
 *   cycle        cycles, only with the module on
 */
export const TIMELINE_LANE_KEYS = [
  "life",
  "illness",
  "allergies",
  "medications",
  "vaccinations",
  "visits",
  "labs",
  "documents",
  "cycle",
] as const;

export type TimelineLaneKey = (typeof TIMELINE_LANE_KEYS)[number];

/** What one lane item is. */
export const TIMELINE_ITEM_KINDS = [
  "lifeEvent",
  "travel",
  "episode",
  "chronic",
  "allergy",
  "medication",
  "course",
  "doseChange",
  "pause",
  "vaccination",
  "visit",
  "procedure",
  "labDay",
  "document",
  "cycle",
] as const;

export type TimelineItemKind = (typeof TIMELINE_ITEM_KINDS)[number];

/**
 * The readiness inventory, one row per lane plus the value series. `values`
 * is always listed; `mood`, `environment` and `cycle` only with their module
 * on.
 */
export const TIMELINE_READINESS_KEYS = [
  "values",
  ...TIMELINE_LANE_KEYS,
  "mood",
  "environment",
] as const;

export type TimelineReadinessKey = (typeof TIMELINE_READINESS_KEYS)[number];

/** How well one lane is filled. Counts, never a score. */
export const TIMELINE_READINESS_STATUSES = [
  "carries",
  "thin",
  "empty",
] as const;

export type TimelineReadinessStatus =
  (typeof TIMELINE_READINESS_STATUSES)[number];

/**
 * The one-sentence verdict: `carries` from three carrying lanes including
 * the values, otherwise `thin`.
 */
export const TIMELINE_READINESS_VERDICTS = ["carries", "thin"] as const;

export type TimelineReadinessVerdict =
  (typeof TIMELINE_READINESS_VERDICTS)[number];

/* ─── Life events ─────────────────────────────────────────────────────────── */

/** Mirrors the Prisma enum `LifeEventCategory`. */
export const LIFE_EVENT_CATEGORIES = [
  "FAMILY",
  "HOME",
  "WORK",
  "LOSS",
  "OTHER",
] as const;

export type LifeEventCategory = (typeof LIFE_EVENT_CATEGORIES)[number];

/** Mirrors the Prisma enum `LifeEventPrecision`. Applies to both ends. */
export const LIFE_EVENT_PRECISIONS = ["DAY", "MONTH", "YEAR"] as const;

export type LifeEventPrecision = (typeof LIFE_EVENT_PRECISIONS)[number];

/** Longest title, in characters. */
export const LIFE_EVENT_TITLE_MAX = 120;

/** Longest note, in characters. */
export const LIFE_EVENT_NOTE_MAX = 2000;

/* ─── Coach and MCP ───────────────────────────────────────────────────────── */

/**
 * The read tool the Coach and the MCP endpoint get for one day. Reserved
 * here so both registries spell it the same; the loader is the day route's.
 * Its answer never carries a {@link MODEL_EXCLUDED_DAY_SECTIONS} section.
 */
export const DAY_TOOL_NAME = "get_day";

/** The tool's single argument. */
export interface DayToolInput {
  date: DateKey;
}

/* ─── Wire types, inferred from the schemas ───────────────────────────────── */

/** `GET /api/day/{date}` → `data`. */
export type DayResponse = z.infer<typeof dayResponseSchema>;
export type DayRunningItem = DayResponse["running"][number];
export type DayValue = DayResponse["values"][number];
export type DayEvent = DayResponse["events"][number];
export type DayNotable = DayResponse["notable"][number];

/** `GET /api/day/index` → `data`. */
export type DayIndexResponse = z.infer<typeof dayIndexResponseSchema>;

/**
 * `GET /api/day/notable` → `data`: the observations and context changes
 * since the last visit, for the visit preparation.
 */
export type DayNotableWindowResponse = z.infer<typeof dayNotableResponseSchema>;
export type DayChange = DayNotableWindowResponse["changes"][number];

/** Widest window `GET /api/day/notable` answers, in days. */
export const DAY_NOTABLE_MAX_SPAN_DAYS = 1096;

/** `GET /api/timeline` query and `data`. */
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
export type TimelineResponse = z.infer<typeof timelineResponseSchema>;
export type TimelineLane = TimelineResponse["lanes"][number];
export type TimelineItem = TimelineLane["items"][number];
export type TimelineSeries = TimelineResponse["series"][number];

/** `GET /api/timeline/readiness` → `data`. */
export type TimelineReadinessResponse = z.infer<
  typeof timelineReadinessResponseSchema
>;
export type TimelineReadinessLane = TimelineReadinessResponse["lanes"][number];

/** One life event as the routes return it. */
export type LifeEventDTO = z.infer<typeof lifeEventSchema>;
export type LifeEventListResponse = z.infer<typeof lifeEventListResponseSchema>;
export type LifeEventCreateInput = z.infer<typeof lifeEventCreateSchema>;
export type LifeEventUpdateInput = z.infer<typeof lifeEventUpdateSchema>;
