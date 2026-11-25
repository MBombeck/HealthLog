/**
 * OpenAPI route table for the chart context (`/api/insights/context`): the
 * medication changes, illness episodes and cycle phases a metric chart draws
 * over its line.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The schemas
 * are the runtime ones from `@/lib/charts/context-markers-contract`, so the
 * published contract is the parser's own.
 */
import type { ZodOpenApiObject } from "zod-openapi";

import {
  chartContextQuerySchema,
  chartContextResponseSchema,
} from "@/lib/charts/context-markers-contract";

import { dataEnvelope, recordRefusal, stdResponses } from "./shared";

export const chartContextPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/insights/context": {
    get: {
      tags: ["Insights"],
      summary: "What happened around a metric",
      description:
        'The marks a metric chart draws over its line: medication starts, stops, dose changes, pauses and resumptions, acute illness episodes, and the phases of the observed cycles. Read from the same rows as the `medications`, `illness` and `cycle` lanes of `GET /api/timeline`, so a mark sits on the day the timeline shows. Every date is a local day in the record\'s zone. A part whose module is off or whose section is not shared answers an empty list; the timeline module is not required. `from` and `to` cut the window (a span is sent when it touches it); without them the whole record is sent. Delegable at read level over the whole record. Cookie or `["*"]` Bearer auth; a narrow token is refused.',
      requestParams: { query: chartContextQuerySchema },
      responses: {
        "200": {
          description: "The context marks, oldest first in each list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                chartContextResponseSchema,
                "ChartContextEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(),
      },
    },
  },
};
