/**
 * Query of `GET /api/measurements/blood-pressure/time-of-day` (#1331).
 * Shared by the route and the OpenAPI registry, so the contract has one
 * definition.
 */
import { z } from "zod/v4";

export const bpTimeOfDayQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .default(30)
    .describe(
      "Window in local days, ending with today in the record's time zone (1..3650, default 30): the window the chart draws for the same range.",
    ),
});
