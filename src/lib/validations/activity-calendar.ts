/**
 * Query of `GET /api/activity/calendar` (D1036).
 */
import { z } from "zod/v4";

export const activityCalendarQuerySchema = z.object({
  period: z
    .enum(["week", "month"])
    .default("month")
    .describe("Calendar span: one week (Monday to Sunday) or one month."),
  date: z.iso
    .date()
    .optional()
    .describe(
      "Any day inside the period to show (`YYYY-MM-DD`, the person's local day). Defaults to today. A day after today, or more than ten years back, is refused.",
    ),
});

export type ActivityCalendarQuery = z.infer<typeof activityCalendarQuerySchema>;

const dateKey = z.iso.date();

const dayLevelEnum = z
  .enum([
    "none",
    "unrated",
    "in_progress",
    "low",
    "below",
    "usual",
    "above",
    "high",
  ])
  .describe(
    "Where the day sits in the person's own spread over the 84 days before the period: `low` below their 10th percentile, `below` below the 25th, `above` above the 75th, `high` above the 90th, `usual` between. `none` = no value that day; `unrated` = fewer than 14 days of history to compare with; `in_progress` = today, which has not ended and is never rated.",
  );

const baselineStatsSchema = z
  .object({
    median: z.number(),
    p10: z.number(),
    p25: z.number(),
    p75: z.number(),
    p90: z.number(),
    days: z
      .number()
      .int()
      .describe("Days with a value the spread was computed from."),
  })
  .nullable()
  .meta({ id: "ActivityBaselineStats" });

const periodComparisonSchema = z
  .object({
    value: z
      .number()
      .nullable()
      .describe(
        "The period so far: a total (steps, active minutes, workouts) or a mean (load).",
      ),
    daysWithData: z.number().int(),
    completedDays: z
      .number()
      .int()
      .describe("Days of the period that have ended (today excluded)."),
    completedValue: z
      .number()
      .nullable()
      .describe(
        "`value` over the completed days only. This, not `value`, is what `usualToDate` is compared with, so a running period is never judged on today's partial day.",
      ),
    usual: z
      .number()
      .nullable()
      .describe(
        "The person's usual full period: the median of the twelve weeks (or, per day, of the six months) before it. Null with fewer than three earlier periods of data.",
      ),
    usualToDate: z
      .number()
      .nullable()
      .describe(
        "The usual figure for the completed days (today excluded); equals `usual` once the period is over, null before the period's first day has ended.",
      ),
    referencePeriods: z.number().int(),
    change: z
      .number()
      .nullable()
      .describe(
        "`completedValue` against `usualToDate` as a signed fraction (0.18 = 18 % above the usual). Null while either is null or the usual is zero. A client shows it as given.",
      ),
  })
  .meta({ id: "ActivityPeriodComparison" });

const goalProgressSchema = z
  .object({
    key: z.enum([
      "workoutsPerWeek",
      "activeMinutesPerWeek",
      "stepsPerWeek",
      "stepsPerMonth",
    ]),
    target: z.number().int(),
    value: z.number(),
    met: z.boolean(),
  })
  .meta({ id: "ActivityGoalProgress" });

const goalsSchema = z
  .object({
    workoutsPerWeek: z.number().int().nullable(),
    activeMinutesPerWeek: z.number().int().nullable(),
    stepsPerWeek: z.number().int().nullable(),
    stepsPerMonth: z.number().int().nullable(),
  })
  .meta({
    id: "ActivityGoals",
    description:
      "The person's own goals; `null` = not set. There is no default goal.",
  });

export const activityGoalsResponseSchema = goalsSchema;

export const activityCalendarResponseSchema = z
  .object({
    period: z.enum(["week", "month"]),
    start: dateKey,
    end: dateKey,
    gridStart: dateKey.describe(
      "First day drawn (the Monday on or before `start`).",
    ),
    gridEnd: dateKey.describe("Last day drawn (the Sunday on or after `end`)."),
    today: dateKey,
    timezone: z.string().describe("The IANA zone the days are cut in."),
    loadType: z
      .enum(["DAY_STRAIN", "CARDIO_LOAD", "STRAIN_SCORE"])
      .nullable()
      .describe(
        "Which training-load score `load` carries; null when the account has none.",
      ),
    days: z.array(
      z.object({
        date: dateKey,
        inPeriod: z.boolean(),
        future: z.boolean(),
        steps: z.number().nullable(),
        activeMinutes: z
          .number()
          .nullable()
          .describe(
            "The larger of the day's exercise minutes and workout minutes (never their sum).",
          ),
        workoutCount: z.number().int(),
        workoutsBySport: z.record(z.string(), z.number().int()),
        load: z.number().nullable(),
        level: z.object({
          steps: dayLevelEnum,
          activeMinutes: dayLevelEnum,
          load: dayLevelEnum,
        }),
      }),
    ),
    weeks: z.array(
      z.object({
        start: dateKey,
        end: dateKey,
        steps: z.number().nullable(),
        activeMinutes: z.number().nullable(),
        workouts: z.number().int(),
        goals: z
          .array(goalProgressSchema)
          .describe("The weekly goals for a week that has begun."),
      }),
    ),
    baseline: z.object({
      steps: baselineStatsSchema,
      activeMinutes: baselineStatsSchema,
      load: baselineStatsSchema,
    }),
    summary: z.object({
      steps: periodComparisonSchema,
      activeMinutes: periodComparisonSchema,
      workouts: periodComparisonSchema,
      load: periodComparisonSchema,
    }),
    sports: z.array(
      z.object({ sportType: z.string(), count: z.number().int() }),
    ),
    goals: goalsSchema,
    goalProgress: z.array(goalProgressSchema),
    available: z.object({
      steps: z.boolean(),
      activeMinutes: z.boolean(),
      workouts: z.boolean(),
      load: z.boolean(),
    }),
    previous: dateKey.describe("A day in the previous period."),
    next: dateKey
      .nullable()
      .describe(
        "A day in the next period, or null when that lies after today.",
      ),
  })
  .meta({ id: "ActivityCalendar" });

export type ActivityCalendarResponse = z.infer<
  typeof activityCalendarResponseSchema
>;
