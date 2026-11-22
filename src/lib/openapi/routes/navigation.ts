/**
 * The navigation's counts (`GET /api/nav/counts`).
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { dataEnvelope, stdResponses } from "./shared";

const navCounts = z
  .object({
    dosesDue: z
      .number()
      .int()
      .describe(
        "Today's scheduled doses of active, tracked medications whose resolved state is `due` or `overdue` (the dose resolver's own answer, as the today list gives it), not counting a slot the person snoozed.",
      ),
    checkupsDue: z
      .number()
      .int()
      .describe(
        "Check-up reminders due now: enabled, not snoozed, no booked visit, due today on a long cycle or past their time on a short one, as the daily digest's rail counts them.",
      ),
  })
  .meta({ id: "NavCounts" });

export const navigationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/nav/counts": {
    get: {
      tags: ["Dashboard"],
      summary: "The counts the navigation shows",
      description:
        "Doses and check-ups due now for the caller's own record, read in a fixed number of statements; nothing is written. Cookie session or a full-scope token; a switched record is refused.",
      responses: {
        "200": {
          description: "The counts.",
          content: {
            "application/json": {
              schema: dataEnvelope(navCounts, "NavCountsResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
