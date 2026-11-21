/**
 * The scheduled doctor report's request contract: the cadence and the
 * window. The stamps (last period, outcome, time) are the server's and are
 * never body fields; the record is the caller's resolved record.
 */
import { z } from "zod/v4";

import {
  REPORT_SCHEDULE_CADENCES,
  REPORT_SCHEDULE_WINDOWS,
} from "@/lib/doctor-report/schedule-shape";

export const reportScheduleCadenceEnum = z.enum(REPORT_SCHEDULE_CADENCES);
export const reportScheduleWindowEnum = z.enum(REPORT_SCHEDULE_WINDOWS);

export const reportSchedulePutSchema = z
  .object({
    cadence: reportScheduleCadenceEnum,
    window: reportScheduleWindowEnum,
  })
  .strict();

export type ReportSchedulePut = z.infer<typeof reportSchedulePutSchema>;
