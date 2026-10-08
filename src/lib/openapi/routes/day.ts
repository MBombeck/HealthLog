/**
 * OpenAPI route table for the day view, the timeline and life events
 * (`/api/day`, `/api/timeline`, `/api/life-events`, v1.42, #613).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * and response schemas are the runtime ones from `@/lib/day/wire-schemas`, so
 * the published contract is the parser's own. Published ahead of the
 * implementation: every operation answers 501 until its route lands.
 */
import type { ZodOpenApiObject } from "zod-openapi";

import {
  dayIndexQuerySchema,
  dayIndexResponseSchema,
  dayPathSchema,
  dayResponseSchema,
  lifeEventCreateSchema,
  lifeEventIdPathSchema,
  lifeEventListResponseSchema,
  lifeEventSchema,
  lifeEventUpdateSchema,
  timelineQuerySchema,
  timelineReadinessResponseSchema,
  timelineResponseSchema,
} from "@/lib/day/wire-schemas";

import {
  dataEnvelope,
  errorEnvelope,
  notImplementedResponse,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

const TIMELINE_OFF =
  "`module.disabled` with `meta.module = timeline`: the record has the timeline switched off (it is opt-in), or the operator turned it off server-wide.";

const lifeEventNotFound = {
  "404": {
    description: "No such life event on this record.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

export const dayPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/day/index": {
    get: {
      tags: ["Records"],
      summary: "Days with entries",
      description:
        "Which local days in a window hold anything, by section, and which carry a notable observation. At most 366 days per call. Days are cut in the record's own time zone.",
      requestParams: { query: dayIndexQuerySchema },
      responses: {
        "200": {
          description: "The days in the window that hold entries.",
          content: {
            "application/json": {
              schema: dataEnvelope(dayIndexResponseSchema, "DayIndexEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(),
        ...notImplementedResponse,
      },
    },
  },
  "/api/day/{date}": {
    get: {
      tags: ["Records"],
      summary: "One day across the record",
      description:
        "Everything on one local calendar day: what ran through it (medications, an illness, a cycle phase, a trip), the readings in its window with the person's usual range, what happened on it, and deterministic notable observations as keys with parameters. Sections of a switched-off module are left out; sections the caller's grant does not cover are named in `sections`. Read live from the record, never from the UTC rollups. A date that is not a real calendar date answers 422.",
      requestParams: { path: dayPathSchema },
      responses: {
        "200": {
          description: "The day.",
          content: {
            "application/json": {
              schema: dataEnvelope(dayResponseSchema, "DayEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(),
        ...notImplementedResponse,
      },
    },
  },
  "/api/timeline": {
    get: {
      tags: ["Records"],
      summary: "The record over the years",
      description:
        "Lanes of conditions, allergies, medications, vaccinations, visits, lab days, documents and life events, the standing items without a start, and monthly (or finer, by zoom) value series. Empty lanes are not sent; lanes of a switched-off module never are. Requires the opt-in `timeline` module.",
      requestParams: { query: timelineQuerySchema },
      responses: {
        "200": {
          description: "The timeline for the requested zoom and window.",
          content: {
            "application/json": {
              schema: dataEnvelope(timelineResponseSchema, "TimelineEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(TIMELINE_OFF),
        ...notImplementedResponse,
      },
    },
  },
  "/api/timeline/readiness": {
    get: {
      tags: ["Records"],
      summary: "What the timeline can show",
      description:
        "One row per lane: carries, thin or empty, a count, a detail as a message key with parameters, and the gaps with one in-app link each. The verdict is one of two words, never a score. Requires the opt-in `timeline` module.",
      responses: {
        "200": {
          description: "The readiness inventory.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                timelineReadinessResponseSchema,
                "TimelineReadinessEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(TIMELINE_OFF),
        ...notImplementedResponse,
      },
    },
  },
  "/api/life-events": {
    get: {
      tags: ["Records"],
      summary: "List life events",
      description:
        "The record's life events, oldest first; soft-deleted ones are excluded. Title and note are decrypted for the caller. Part of the `profile` sharing domain. Life events are never sent to a model.",
      responses: {
        "200": {
          description: "The life events.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                lifeEventListResponseSchema,
                "LifeEventListEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(),
        ...notImplementedResponse,
      },
    },
    post: {
      tags: ["Records"],
      summary: "Add a life event",
      description:
        "A dated anchor in the person's life. `precision` says how much of the date is known and applies to both ends: at MONTH a date is the first of its month, at YEAR the first of its year. `endDate`, when given, is not before `startDate`. Title (1-120 characters) and note (up to 2000) are encrypted at rest.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: lifeEventCreateSchema } },
      },
      responses: {
        "201": {
          description: "Created.",
          content: {
            "application/json": {
              schema: dataEnvelope(lifeEventSchema, "CreateLifeEventEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...recordWriteRateLimitResponse,
        ...notImplementedResponse,
      },
    },
  },
  "/api/life-events/{id}": {
    patch: {
      tags: ["Records"],
      summary: "Edit a life event",
      description:
        "A partial edit; an omitted key leaves the column untouched. The merged event must still satisfy the create rules (dates aligned to the precision, end not before start).",
      requestParams: { path: lifeEventIdPathSchema },
      requestBody: {
        required: true,
        content: { "application/json": { schema: lifeEventUpdateSchema } },
      },
      responses: {
        "200": {
          description: "Updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(lifeEventSchema, "UpdateLifeEventEnvelope"),
            },
          },
        },
        ...lifeEventNotFound,
        ...stdResponses,
        ...notImplementedResponse,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Delete a life event",
      description: "Soft-deletes one life event.",
      requestParams: { path: lifeEventIdPathSchema },
      responses: {
        "200": {
          description: "Deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(lifeEventSchema, "DeleteLifeEventEnvelope"),
            },
          },
        },
        ...lifeEventNotFound,
        ...stdResponses,
        ...notImplementedResponse,
      },
    },
  },
};
