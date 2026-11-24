/**
 * OpenAPI route table for treatment series (`/api/treatment-series`, v1.50).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Requests reuse
 * the runtime Zod schemas. The response mirrors the server-authoritative DTO:
 * the status, the counts and the session dates arrive derived, and a client
 * renders them rather than counting visits itself.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { TREATMENT_SERIES_STATUSES } from "@/lib/treatment-series/derive";
import { encounterKindEnum } from "@/lib/validations/encounters";
import {
  treatmentSeriesCreateSchema,
  treatmentSeriesListQuerySchema,
  treatmentSeriesUpdateSchema,
} from "@/lib/validations/treatment-series";

import { encounter, linkedTarget, practitioner } from "./encounters";
import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

const createRequest = treatmentSeriesCreateSchema.meta({
  id: "CreateTreatmentSeriesRequest",
  description:
    "Start a treatment series: a course of several visits such as a physiotherapy prescription. `title` and `startsOn` are required; `title` and `note` are encrypted at rest. `plannedSessions` is the count the prescription covers (null: open-ended), `validUntil` its last valid day. `prescriberId` and `performerId` name two entries of the caller's address book (who ordered it, who gives it), `episodeId` the condition it treats. An id naming nothing the caller owns is a 404. The sessions are visits filed with this series' id (`seriesId` on `POST /api/encounters`).",
});

const updateRequest = treatmentSeriesUpdateSchema.meta({
  id: "UpdateTreatmentSeriesRequest",
  description:
    "Partial edit; an omitted key is left alone, an explicit null clears it, and a body naming nothing is a 422. `endedOn` ends the series on that day (completed, whatever the count says); null reopens it.",
});

const listQuery = treatmentSeriesListQuerySchema.meta({
  id: "ListTreatmentSeriesQuery",
  description: "`episodeId` narrows to the series given for one condition.",
});

const sessions = z
  .object({
    done: z.number().int(),
    booked: z.number().int(),
    cancelled: z.number().int(),
    remaining: z.number().int().nullable(),
  })
  .meta({
    id: "TreatmentSeriesSessions",
    description:
      "Counted from the live sessions on every read. `done`: took place. `booked`: PLANNED and still ahead. `cancelled`: cancelled or missed, which used up nothing. `remaining`: planned minus done, never below zero, null for an open-ended series.",
  });

const series = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    kind: encounterKindEnum,
    plannedSessions: z.number().int().nullable(),
    startsOn: z.string().describe("`YYYY-MM-DD`."),
    validUntil: z.string().nullable().describe("`YYYY-MM-DD`, inclusive."),
    endedOn: z.string().nullable().describe("`YYYY-MM-DD`."),
    status: z
      .enum(TREATMENT_SERIES_STATUSES)
      .describe(
        "Derived, first match wins: COMPLETED once ended (on or before the record's today) or once every planned session took place; EXPIRED when `validUntil` has passed with sessions left; PLANNED while no session took place; ACTIVE otherwise.",
      ),
    sessions,
    firstSessionAt: z.string().nullable(),
    lastSessionAt: z.string().nullable(),
    nextSessionAt: z.string().nullable(),
    prescriber: practitioner.nullable(),
    performer: practitioner.nullable(),
    condition: linkedTarget
      .nullable()
      .describe(
        "The condition it treats. `redacted: true` with no label when the caller's grant does not cover the illness section.",
      ),
    note: z.string().nullable(),
    visits: z
      .array(encounter)
      .optional()
      .describe("The detail read only: every live session, oldest first."),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "TreatmentSeries",
    description:
      "A course of several visits (v1.50): a physiotherapy prescription, a run of radiation, a dental plan. Everything about progress is derived server-side from the visits that name it, so filing, moving or cancelling a session corrects it. `title` and `note` are decrypted (null on a key-rotation gap).",
  });

const notFound = {
  "404": {
    description: "Treatment series not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

const idPath = { path: z.object({ id: z.string() }) };

export const treatmentSeriesPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/treatment-series": {
    get: {
      tags: ["Records"],
      summary: "List treatment series",
      description:
        "The caller's live treatment series, open ones (PLANNED, ACTIVE) first, each newest start first. Read at the same section and level as the visit list.",
      requestParams: { query: listQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The series.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ series: z.array(series) }),
                "ListTreatmentSeriesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Records"],
      summary: "Start a treatment series",
      description:
        "Creates one series. Honours `Idempotency-Key`. Audits as `treatment-series.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Series created.",
          content: {
            "application/json": {
              schema: dataEnvelope(series, "CreateTreatmentSeriesEnvelope"),
            },
          },
        },
        "404": {
          description: "A named practitioner or condition is not the caller's.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/treatment-series/{id}": {
    get: {
      tags: ["Records"],
      summary: "Read a treatment series with its sessions",
      description:
        "The series and, in `visits`, every live session oldest first, each with its links and its session number.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The series.",
          content: {
            "application/json": {
              schema: dataEnvelope(series, "GetTreatmentSeriesEnvelope"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Records"],
      summary: "Edit, end or reopen a treatment series",
      description:
        "Partial edit. Audits as `treatment-series.update`, without the title or the note.",
      requestParams: idPath,
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Series updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(series, "UpdateTreatmentSeriesEnvelope"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Soft-delete a treatment series",
      description:
        "Stamps `deletedAt`. The sessions stay the visits they are and stop naming the series until it is restored. Idempotent. Audits as `treatment-series.delete`.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Soft-deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteTreatmentSeriesEnvelope",
              ),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
  },
  "/api/treatment-series/{id}/restore": {
    post: {
      tags: ["Records"],
      summary: "Restore a soft-deleted treatment series",
      description:
        "Clears the tombstone; the sessions name the series again. Restoring a live series is a no-op that still succeeds.",
      requestParams: idPath,
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Series restored.",
          content: {
            "application/json": {
              schema: dataEnvelope(series, "RestoreTreatmentSeriesEnvelope"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
  },
};
