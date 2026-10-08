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
  DAY_SECTION_KEYS,
  DAY_SECTION_UNAVAILABLE_REASONS,
  LIFE_EVENT_CATEGORIES,
  LIFE_EVENT_NOTE_MAX,
  LIFE_EVENT_PRECISIONS,
  LIFE_EVENT_TITLE_MAX,
  TIMELINE_ITEM_KINDS,
  TIMELINE_LANE_KEYS,
  TIMELINE_READINESS_KEYS,
  TIMELINE_READINESS_STATUSES,
  TIMELINE_READINESS_VERDICTS,
  TIMELINE_ZOOMS,
} from "./contract";

/* ─── Shared pieces ───────────────────────────────────────────────────────── */

export const dateKeySchema = z
  .string()
  .refine(isCalendarDateKey, { message: "Expected a YYYY-MM-DD calendar date" })
  .describe("A local calendar date, `YYYY-MM-DD`.");

const instant = z.iso.datetime({ offset: true });

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
    since: dateKeySchema,
    until: dateKeySchema.nullable().describe("Null while it is still open."),
    dayIndex: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Day n of the period, counting `since` as day 1."),
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
    title: z.string(),
    meta: z.string().nullable(),
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

const dayNotable = z
  .object({
    kind: z.enum(DAY_NOTABLE_KINDS),
    type: z.string().nullable().describe("The `MeasurementType` it is about."),
    params: messageParams,
  })
  .meta({ id: "DayNotable" });

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
      .enum(["lastVisit", "requested", "fallback"])
      .describe(
        "Where `from` came from: the last completed visit, the request, or the fallback of 90 days when the record holds no visit the caller may see.",
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

export const timelineQuerySchema = z.object({
  zoom: z.enum(TIMELINE_ZOOMS).default("all"),
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
  values: z
    .string()
    .optional()
    .describe(
      "Comma-separated value series to include, as `MeasurementType` names or `MOOD`.",
    ),
});

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
    label: z.string(),
    sub: z.string().nullable(),
    href: z.string().nullable(),
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
    granularity: z.enum(["month", "week", "day"]),
    points: z.array(z.object({ t: dateKeySchema, mean: z.number() })),
  })
  .meta({ id: "TimelineSeries" });

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
    series: z.array(timelineSeries),
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
