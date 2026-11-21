/**
 * The stored shape of `User.reportScheduleJson` and its closed vocabularies,
 * apart from the period maths in `./schedule` so the settings card can name
 * them without pulling the timezone helpers into the browser bundle.
 */
import { z } from "zod/v4";

export const REPORT_SCHEDULE_CADENCES = [
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
] as const;
export type ReportScheduleCadence = (typeof REPORT_SCHEDULE_CADENCES)[number];

/** What one report covers, ending where the period ends. */
export const REPORT_SCHEDULE_WINDOWS = [
  "PERIOD",
  "LAST_90_DAYS",
  "LAST_365_DAYS",
] as const;
export type ReportScheduleWindow = (typeof REPORT_SCHEDULE_WINDOWS)[number];

/** How the last run ended, as the settings card reports it. */
export const REPORT_SCHEDULE_OUTCOMES = [
  "stored",
  "alreadyFiled",
  "deletedByOwner",
  "quotaExceeded",
  "tooLarge",
  "noSelection",
  "failed",
] as const;
export type ReportScheduleOutcome = (typeof REPORT_SCHEDULE_OUTCOMES)[number];

/** The stored shape. Unknown keys are dropped on read. */
export const reportScheduleSchema = z.object({
  v: z.literal(1),
  cadence: z.enum(REPORT_SCHEDULE_CADENCES),
  window: z.enum(REPORT_SCHEDULE_WINDOWS),
  lastPeriod: z.string().max(16).nullable(),
  lastOutcome: z.enum(REPORT_SCHEDULE_OUTCOMES).nullable(),
  lastRunAt: z.string().max(40).nullable(),
});
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;

/** The stored blob, or null when it is off or not a shape this build reads. */
export function parseReportSchedule(raw: unknown): ReportSchedule | null {
  if (raw === null || raw === undefined) return null;
  const parsed = reportScheduleSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
