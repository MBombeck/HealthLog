/**
 * Zod schemas for the day view, the timeline and life events (v1.42, #613).
 *
 * The routes parse their input with these, the OpenAPI table publishes them,
 * and `./contract.ts` infers its wire types from them, so the request a route
 * accepts, the shape it promises and the type a client reads are one thing.
 * Server and OpenAPI side only: client code imports the types from
 * `./contract.ts`, never this file, so no validator lands in the browser.
 */
import { z } from "zod/v4";

import { dateOnlyAtNoonUtc, isCalendarDateKey } from "@/lib/tz/date-only";

import {
  DAY_EVENT_KINDS,
  DAY_INDEX_MAX_SPAN_DAYS,
  DAY_NOTABLE_KINDS,
  DAY_RUNNING_KINDS,
  DAY_SCORE_KEYS,
  DAY_SECTION_KEYS,
  DAY_SECTION_UNAVAILABLE_REASONS,
  LIFE_EVENT_CATEGORIES,
  LIFE_EVENT_NOTE_MAX,
  LIFE_EVENT_PRECISIONS,
  LIFE_EVENT_TITLE_MAX,
  TIMELINE_BUCKETS,
  TIMELINE_ITEM_KINDS,
  TIMELINE_LANE_KEYS,
  TIMELINE_READINESS_KEYS,
  TIMELINE_READINESS_STATUSES,
  TIMELINE_READINESS_VERDICTS,
  TIMELINE_RANGE_MAX_DAYS,
  TIMELINE_ZOOMS,
} from "./contract";
import { isoDateTime } from "@/lib/validations/datetime";

/* ─── Shared pieces ───────────────────────────────────────────────────────── */

export const dateKeySchema = z
  .string()
  .refine(isCalendarDateKey, { message: "Expected a YYYY-MM-DD calendar date" })
  .describe("A local calendar date, `YYYY-MM-DD`.");

const instant = isoDateTime();

const messageParams = z
  .record(z.string(), z.union([z.string(), z.number()]))
  .describe(
    "Parameters for the message the client words from its own bundle. Dates are `YYYY-MM-DD`, values are numbers in the unit the entry names.",
  );

const daySectionKey = z.enum(DAY_SECTION_KEYS);

/* ─── GET /api/day/{date} ─────────────────────────────────────────────────── */

export const dayPathSchema = z.object({ date: dateKeySchema });

const dayRunningItem = z
  .object({
    kind: z.enum(DAY_RUNNING_KINDS),
    section: daySectionKey,
    id: z.string(),
    title: z
      .string()
      .describe("Decrypted server-side for the caller's own session."),
    sub: z
      .string()
      .nullable()
      .describe("A second line, already formatted (a dose, a destination)."),
    since: dateKeySchema
      .nullable()
      .describe(
        "The record's own start date. Null when the record holds none (a medication filed without a start date); the entry's creation date is never put in its place.",
      ),
    until: dateKeySchema.nullable().describe("Null while it is still open."),
    dayIndex: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe(
        "Day n of the period, counting `since` as day 1; null when `since` is null.",
      ),
    dayCount: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Length of a closed period in days; null while open."),
    href: z
      .string()
      .nullable()
      .describe("In-app path to the record this came from."),
  })
  .meta({ id: "DayRunningItem" });

const dayValue = z
  .object({
    type: z.string().describe("A `MeasurementType`."),
    value: z.number(),
    unit: z.string(),
    at: instant,
    source: z
      .string()
      .describe("The `MeasurementSource` of the canonical row."),
    band: z
      .object({
        lo: z.number(),
        hi: z.number(),
        n: z.number().int().nonnegative(),
      })
      .nullable()
      .describe(
        "The person's own usual range over the 30 days before this day, from their daily values. Null with too little history.",
      ),
  })
  .meta({ id: "DayValue" });

const dayEvent = z
  .object({
    at: instant
      .nullable()
      .describe("The instant, or null for something that has a date only."),
    kind: z.enum(DAY_EVENT_KINDS),
    section: daySectionKey,
    id: z.string(),
    title: z
      .string()
      .describe(
        "The record's own name, or a code the client words: a mood, a screener's instrument, a workout's sport, `cycle` for a cycle day.",
      ),
    meta: z
      .string()
      .nullable()
      .describe(
        "The second line: text (a dose, a lab value, a duration) or a code or number the client words (a category, a kind, a severity, a screener's score and band, an intensity, a dose number).",
      ),
    note: z
      .string()
      .nullable()
      .describe("The person's own note, decrypted for the caller's session."),
    docs: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .describe("Documents filed against the entry."),
    href: z.string().nullable(),
  })
  .meta({ id: "DayEvent" });

const dayScore = z
  .object({
    key: z.enum(DAY_SCORE_KEYS),
    value: z
      .number()
      .describe(
        "The score on its own scale: whole points for a 0 to 100 score, one decimal for a device's day strain.",
      ),
    max: z
      .number()
      .int()
      .positive()
      .describe("The top of the scale: 100, or 21 for a device's day strain."),
    source: z
      .string()
      .describe(
        "`COMPUTED` for a score the server derived, else the `MeasurementSource` of the device row.",
      ),
    band: z
      .object({
        lo: z.number(),
        hi: z.number(),
        n: z.number().int().nonnegative(),
      })
      .nullable()
      .describe(
        "The person's own usual range of the score over the 30 days before this day, on the same scale. Null with too little history.",
      ),
  })
  .meta({ id: "DayScore" });

const dayNotable = z
  .object({
    kind: z.enum(DAY_NOTABLE_KINDS),
    type: z.string().nullable().describe("The `MeasurementType` it is about."),
    params: messageParams,
  })
  .meta({ id: "DayNotable" });

/**
 * v1.43 — the day's movement context from Dawarich: daily values only, never
 * a coordinate or a place name. The record owner's only, like the
 * environment readings; a delegate never receives it.
 */
export const dayMovementSchema = z
  .object({
    source: z.literal("dawarich"),
    distance: z.object({
      unit: z
        .enum(["km", "mi"])
        .describe("Resolved from the account's unit preference."),
      total: z.number().nullable(),
      driving: z.number().nullable(),
      train: z.number().nullable(),
    }),
    placesVisited: z.number().int().nullable(),
    awayFromHomeMinutes: z
      .number()
      .int()
      .nullable()
      .describe("`null` means no coverage that day, not zero."),
    travel: z
      .object({
        isTravelDay: z.boolean(),
        countryCode: z.string().nullable(),
      })
      .nullable(),
    fetchedAt: isoDateTime(),
  })
  .meta({
    id: "DayMovement",
    description:
      "Distances to one decimal in `distance.unit`. Hide a null field; never show it as zero.",
  });

export const dayResponseSchema = z
  .object({
    date: dateKeySchema,
    tz: z.string().describe("The IANA zone the day was cut in."),
    counts: z.object({
      values: z.number().int().nonnegative(),
      entries: z.number().int().nonnegative(),
    }),
    running: z.array(dayRunningItem),
    values: z.array(dayValue),
    events: z.array(dayEvent),
    notable: z.array(dayNotable),
    scores: z
      .array(dayScore)
      .describe(
        "The scores the record holds for this day, in `DAY_SCORE_KEYS` order. A score with no value that day is absent; an empty list means none.",
      ),
    sections: z
      .partialRecord(
        daySectionKey,
        z.object({
          available: z.literal(false),
          reason: z.enum(DAY_SECTION_UNAVAILABLE_REASONS),
        }),
      )
      .describe(
        "Sections the caller cannot see. A section of a switched-off module is left out entirely rather than listed.",
      ),
    movement: dayMovementSchema
      .nullable()
      .optional()
      .describe(
        "v1.43 — the day's movement context; absent for a delegate, with the `environment` module off, with no Dawarich connection, and on older servers.",
      ),
  })
  .meta({ id: "Day" });

/* ─── GET /api/day/index ──────────────────────────────────────────────────── */

export const dayIndexQuerySchema = z
  .object({ from: dateKeySchema, to: dateKeySchema })
  .refine((q) => q.from <= q.to, {
    message: "`from` must not be after `to`",
    path: ["to"],
  })
  .refine(
    // Both ends as the same instant of their calendar day, so the difference
    // counts calendar days whatever the process zone.
    (q) =>
      (dateOnlyAtNoonUtc(q.to).getTime() -
        dateOnlyAtNoonUtc(q.from).getTime()) /
        86_400_000 <
      DAY_INDEX_MAX_SPAN_DAYS,
    {
      message: `At most ${DAY_INDEX_MAX_SPAN_DAYS} days`,
      path: ["to"],
    },
  );

export const dayIndexResponseSchema = z
  .object({
    from: dateKeySchema,
    to: dateKeySchema,
    days: z
      .record(z.string(), z.array(daySectionKey))
      .describe(
        "Each day in the window that holds anything, keyed `YYYY-MM-DD`, with the sections it holds. Days without entries are absent.",
      ),
    notable: z
      .array(z.string())
      .describe("Days in the window that carry a notable observation."),
  })
  .meta({ id: "DayIndex" });

/* ─── GET /api/day/notable ────────────────────────────────────────────────── */

/**
 * The window before the next visit: "what happened since the last one". Both
 * ends are optional; the server fills `from` with the last completed visit
 * and `to` with today, and says which it used.
 */
export const dayNotableQuerySchema = z
  .object({ from: dateKeySchema.optional(), to: dateKeySchema.optional() })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "`from` must not be after `to`",
    path: ["to"],
  });

const dayChange = z
  .object({
    date: dateKeySchema,
    kind: z.enum(DAY_EVENT_KINDS),
    section: daySectionKey,
    id: z.string(),
    title: z
      .string()
      .describe("The record's own name for it, decrypted for the caller."),
    count: z
      .number()
      .int()
      .positive()
      .describe("Entries folded into this one (lab results of one day)."),
    href: z.string().nullable(),
  })
  .meta({ id: "DayChange" });

export const dayNotableResponseSchema = z
  .object({
    from: dateKeySchema,
    to: dateKeySchema,
    anchor: z
      .enum(["nextVisit", "lastVisit", "requested", "fallback"])
      .describe(
        "Where `from` came from. `requested`: the request named it. `nextVisit`: no `from` was sent and a visit is booked; `from` is that visit's `preparation.from` on `GET /api/encounters` (the soonest PLANNED visit ahead), so a client that omits `from` reads the window the web shows for it. `lastVisit`: nothing is booked; the day of the last completed visit. `fallback`: 90 days, when the record holds no visit the caller may see. Clients should treat an unknown value like `fallback`.",
      ),
    observations: z.array(
      z
        .object({
          date: dateKeySchema,
          kind: z.enum(DAY_NOTABLE_KINDS),
          type: z.string().nullable(),
          params: messageParams,
        })
        .meta({ id: "DatedDayNotable" }),
    ),
    changes: z
      .array(dayChange)
      .describe(
        "Context changes in the window, oldest first: dose changes, medication and course starts and ends, pauses, illness onsets and recoveries, vaccinations, procedures and lab days.",
      ),
  })
  .meta({ id: "DayNotableWindow" });

/* ─── GET /api/timeline ───────────────────────────────────────────────────── */

export const timelineQuerySchema = z
  .object({
    zoom: z
      .enum(TIMELINE_ZOOMS)
      .default("all")
      .describe(
        "`range` is a chosen stretch: it requires `from` and `to`, at most 15 years apart, and its value series average quarters, months, weeks or days by its length.",
      ),
    from: dateKeySchema.optional(),
    to: dateKeySchema.optional(),
    values: z
      .string()
      .optional()
      .describe(
        "Comma-separated value series to include, as `MeasurementType` names, `MOOD`, or a lab marker as `lab:<biomarkerId>` (see `availableLabs`). A name given twice counts once, so the list is bounded by the names that exist; an unknown measurement name or a malformed marker key answers 422. At most 24 lab markers are drawn (ids, unlike names, are not a closed set): the first 24 are kept and any further ones left out without an error. A lab marker that is not in the record (deleted, or another record's) is likewise left out of `labSeries`, so a stored choice never breaks the page.",
      ),
  })
  .refine((q) => q.zoom !== "range" || (q.from && q.to), {
    message: "`range` needs both `from` and `to`",
    path: ["from"],
  })
  .refine(
    (q) =>
      q.zoom !== "range" ||
      !q.from ||
      !q.to ||
      // Both ends as the same instant of their calendar day, so the
      // difference counts calendar days whatever the process zone.
      (dateOnlyAtNoonUtc(q.to).getTime() -
        dateOnlyAtNoonUtc(q.from).getTime()) /
        86_400_000 <
        TIMELINE_RANGE_MAX_DAYS,
    {
      message: `A range spans at most ${TIMELINE_RANGE_MAX_DAYS} days`,
      path: ["to"],
    },
  );

const timelineItem = z
  .object({
    id: z.string(),
    kind: z.enum(TIMELINE_ITEM_KINDS),
    start: dateKeySchema,
    end: dateKeySchema.nullable().describe("Null for a point or an open span."),
    open: z.boolean().describe("A span that has not ended."),
    precision: z.enum(LIFE_EVENT_PRECISIONS),
    startKnown: z
      .boolean()
      .describe(
        "False when the start is a stand-in (a medication without a start date starts at its first intake).",
      ),
    label: z
      .string()
      .describe(
        "The item's name. A trip is labelled `travel` and a cycle `cycle`; the client words both.",
      ),
    sub: z
      .string()
      .nullable()
      .describe(
        "The second line, by kind: a code for a life event (its category), a visit or procedure (its encounter kind) and a document (its kind); the analyte count for a lab day; the dose as text for a medication or a dose change. The client words every code.",
      ),
    href: z.string().nullable(),
    group: z
      .string()
      .nullable()
      .describe(
        "Items that belong to one thing share a group and are drawn on one row: a medication's own span, its courses, its dose changes and its pauses all carry the medication's id. Null for an item that stands alone.",
      ),
  })
  .meta({ id: "TimelineItem" });

const timelineStanding = z
  .object({
    lane: z.enum(TIMELINE_LANE_KEYS),
    id: z.string(),
    label: z.string(),
    since: dateKeySchema.nullable(),
    href: z.string().nullable(),
  })
  .meta({ id: "TimelineStandingItem" });

const timelineSeries = z
  .object({
    key: z.string().describe("A `MeasurementType` or `MOOD`."),
    unit: z.string().nullable(),
    points: z
      .array(
        z.object({
          t: dateKeySchema.describe("The bucket's first day."),
          mean: z
            .number()
            .describe(
              "The mean of the bucket's day values, each day weighing one (a cumulative type's days are its day totals, a pulse-like type's its hourly-mean day value).",
            ),
          count: z
            .number()
            .int()
            .min(1)
            .describe(
              "Readings behind the mean. Clients draw a point from fewer than three as thin.",
            ),
        }),
      )
      .describe(
        "Buckets with at least one reading, oldest first. A bucket without one is absent, never interpolated.",
      ),
  })
  .meta({ id: "TimelineSeries" });

const labRangeStatus = z
  .enum(["in-range", "below", "above", "unknown"])
  .describe(
    "The reading against `referenceLow` / `referenceHigh`, bounds inclusive; `unknown` when neither is known.",
  );

const timelineLabPoint = z
  .object({
    id: z.string().describe("The lab result's id."),
    date: dateKeySchema.describe(
      "The record's local day of the draw, the day `GET /api/day/{date}` lists it under.",
    ),
    value: z.number().describe("In the series' `unit`."),
    sourceValue: z
      .number()
      .nullable()
      .describe(
        "The figure the report printed, when `value` was converted into the series' unit; it sets the precision `value` is shown with. Null for a reading stored as stated.",
      ),
    rangeStatus: labRangeStatus,
    referenceLow: z
      .number()
      .nullable()
      .describe(
        "The window this reading is judged against, in the series' unit: the one its report printed, else the marker's own.",
      ),
    referenceHigh: z.number().nullable(),
    report: z
      .object({
        id: z.string(),
        title: z
          .string()
          .nullable()
          .describe("The document's title, else its file name."),
        href: z.string(),
      })
      .nullable()
      .describe(
        "The document the reading was read from, when one is linked and the caller may see documents.",
      ),
  })
  .meta({ id: "TimelineLabPoint" });

const timelineLabSeries = z
  .object({
    key: z.string().describe("`lab:<biomarkerId>`, as named in `values`."),
    biomarkerId: z.string(),
    name: z.string().describe("The marker's name, as the labs list shows it."),
    panel: z.string().nullable(),
    unit: z.string().describe("The marker's own unit; every point is in it."),
    band: z
      .object({ low: z.number().nullable(), high: z.number().nullable() })
      .nullable()
      .describe(
        "The reference range to draw behind the points: the marker's own, else the window printed with its newest reading in the window. Null when neither is known.",
      ),
    points: z
      .array(timelineLabPoint)
      .describe(
        "Every numeric reading in the window, oldest first, one point each: never averaged, never interpolated. A day with two readings has two points.",
      ),
    excluded: z
      .number()
      .int()
      .min(0)
      .describe(
        "Readings in the window stored in a unit that does not convert into `unit`. They are left out of `points` rather than drawn on a scale they are not in.",
      ),
  })
  .meta({ id: "TimelineLabSeries" });

const timelineLabMarker = z
  .object({
    key: z.string().describe("`lab:<biomarkerId>`, to name in `values`."),
    biomarkerId: z.string(),
    name: z.string(),
    panel: z
      .string()
      .nullable()
      .describe("The marker's group, as the labs list shows it."),
    unit: z.string(),
  })
  .meta({ id: "TimelineLabMarker" });

export const timelineResponseSchema = z
  .object({
    zoom: z.enum(TIMELINE_ZOOMS),
    range: z.object({
      from: dateKeySchema,
      to: dateKeySchema,
      dataFrom: dateKeySchema
        .nullable()
        .describe("The earliest date anything in the record carries."),
    }),
    lanes: z.array(
      z.object({
        key: z.enum(TIMELINE_LANE_KEYS),
        items: z.array(timelineItem),
      }),
    ),
    standing: z
      .array(timelineStanding)
      .describe("Things without a start: shown once as standing."),
    bucket: z
      .enum(TIMELINE_BUCKETS)
      .describe(
        "The span every series point averages: `quarter` for a multi-year `all`, `month` for `year` and an `all` under two years, `week` for `quarter`, and for a `range` by its length: `quarter` from two years, `month` from 120 days, `week` from 42 days, `day` below.",
      ),
    series: z.array(timelineSeries),
    availableSeries: z
      .array(z.string())
      .describe(
        "Every value series this record can show, whatever the window: the `MeasurementType` names with live readings that the caller may see (events excluded), and `MOOD` when the mood score is visible and has entries. Each may be named in `values`.",
      ),
    labSeries: z
      .array(timelineLabSeries)
      .describe(
        "The lab markers named in `values`, in the order named, each with its single readings in the window. A marker named but not found in the record is left out.",
      ),
    availableLabs: z
      .array(timelineLabMarker)
      .describe(
        "Every lab marker this record has a numeric reading for, whatever the window, when the caller may see labs. Each may be named in `values` by its `key`.",
      ),
    notable: z.array(
      z.object({ date: dateKeySchema, kind: z.enum(DAY_NOTABLE_KINDS) }),
    ),
  })
  .meta({ id: "Timeline" });

/* ─── GET /api/timeline/readiness ─────────────────────────────────────────── */

export const timelineReadinessResponseSchema = z
  .object({
    verdict: z.enum(TIMELINE_READINESS_VERDICTS),
    since: dateKeySchema
      .nullable()
      .describe("The earliest date the carrying lanes reach back to."),
    lanes: z.array(
      z.object({
        key: z.enum(TIMELINE_READINESS_KEYS),
        status: z.enum(TIMELINE_READINESS_STATUSES),
        count: z.number().int().nonnegative(),
        detail: z
          .object({ key: z.string(), params: messageParams })
          .nullable()
          .describe("Worded by the client from `timeline.readiness.detail`."),
        gaps: z.array(
          z.object({
            key: z.string(),
            count: z.number().int().nonnegative(),
            href: z.string(),
          }),
        ),
      }),
    ),
  })
  .meta({ id: "TimelineReadiness" });

/* ─── /api/life-events ────────────────────────────────────────────────────── */

/**
 * At MONTH precision a date is the first of its month, at YEAR the first of
 * its year. Storing the stand-in day keeps the column sortable and the rule
 * keeps two spellings of "September 2023" from existing.
 */
function alignedToPrecision(
  date: string,
  precision: (typeof LIFE_EVENT_PRECISIONS)[number],
): boolean {
  if (precision === "MONTH") return date.endsWith("-01");
  if (precision === "YEAR") return date.endsWith("-01-01");
  return true;
}

const lifeEventTitle = z.string().trim().min(1).max(LIFE_EVENT_TITLE_MAX);
const lifeEventNote = z.string().trim().max(LIFE_EVENT_NOTE_MAX);

export const lifeEventSchema = z
  .object({
    id: z.string(),
    category: z.enum(LIFE_EVENT_CATEGORIES),
    startDate: dateKeySchema,
    endDate: dateKeySchema.nullable(),
    precision: z.enum(LIFE_EVENT_PRECISIONS),
    title: z
      .string()
      .nullable()
      .describe("Decrypted; null only when the stored title cannot be read."),
    note: z.string().nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({
    id: "LifeEvent",
    description:
      "A dated anchor in the person's life. Shared under the `profile` domain; never sent to a model.",
  });

export const lifeEventListResponseSchema = z
  .object({ events: z.array(lifeEventSchema) })
  .meta({ id: "LifeEventList" });

export const lifeEventCreateSchema = z
  .object({
    category: z.enum(LIFE_EVENT_CATEGORIES),
    startDate: dateKeySchema,
    endDate: dateKeySchema.nullable().optional(),
    precision: z.enum(LIFE_EVENT_PRECISIONS),
    title: lifeEventTitle,
    note: lifeEventNote.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!alignedToPrecision(value.startDate, value.precision)) {
      ctx.addIssue({
        code: "custom",
        path: ["startDate"],
        message: "The date must be the first day of its month or year",
      });
    }
    if (value.endDate != null) {
      if (!alignedToPrecision(value.endDate, value.precision)) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "The date must be the first day of its month or year",
        });
      }
      if (value.endDate < value.startDate) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "`endDate` must not be before `startDate`",
        });
      }
    }
  })
  .meta({ id: "CreateLifeEventRequest" });

/**
 * A partial edit. The cross-field rules are checked against the stored row,
 * because a precision change alone can misalign a date the request does not
 * carry; the route merges and re-checks with `lifeEventCreateSchema`.
 */
export const lifeEventUpdateSchema = z
  .object({
    category: z.enum(LIFE_EVENT_CATEGORIES),
    startDate: dateKeySchema,
    endDate: dateKeySchema.nullable(),
    precision: z.enum(LIFE_EVENT_PRECISIONS),
    title: lifeEventTitle,
    note: lifeEventNote.nullable(),
  })
  .partial()
  .strict()
  .meta({ id: "UpdateLifeEventRequest" });

export const lifeEventIdPathSchema = z.object({ id: z.string() });
