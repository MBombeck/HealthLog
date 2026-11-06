/**
 * The local calendar date every day-view and timeline schema speaks in. Its
 * own module so the schema files beside `./wire-schemas.ts` can share it.
 */
import { z } from "zod/v4";

import { isCalendarDateKey } from "@/lib/tz/date-only";

export const dateKeySchema = z
  .string()
  .refine(isCalendarDateKey, { message: "Expected a YYYY-MM-DD calendar date" })
  .describe("A local calendar date, `YYYY-MM-DD`.");
