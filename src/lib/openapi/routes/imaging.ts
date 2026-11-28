/**
 * OpenAPI route table for imaging exams (`/api/imaging`, #1672).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request bodies
 * reuse the runtime Zod schemas from `@/lib/imaging/shared`; response shapes
 * mirror the DTO the routes serialise. Feature key for clients:
 * `records.imaging`.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  IMAGING_MODALITIES,
  IMAGING_SIDES,
  imagingExamCreateSchema,
  imagingExamUpdateSchema,
} from "@/lib/imaging/shared";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

const createRequest = imagingExamCreateSchema.meta({
  id: "CreateImagingExamRequest",
  description:
    "Record one imaging exam. `modality` and `performedAt` (the exam day; the time is dropped, stored at UTC midnight, from 1900 and not in the future) are required. `bodyPart` (80), `facility` (120), `requestingDoctor` (120) and `conclusion` (2000) are the person's own words, trimmed and encrypted at rest; an empty string stores nothing. `documentIds` files vault documents (the report and the pictures, at most 100) against the exam; ids the record does not own are dropped.",
});

const updateRequest = imagingExamUpdateSchema.meta({
  id: "UpdateImagingExamRequest",
  description:
    "Partial edit. An omitted key is left alone; `null`, or an empty string for text, clears it. A present `documentIds` replaces the filed documents (an empty array unfiles all of them; the documents stay in the vault).",
});

const examDocument = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    date: z.string().nullable(),
    mimeType: z.string().nullable(),
    redacted: z.boolean(),
  })
  .meta({
    id: "ImagingExamDocument",
    description:
      "A vault document filed against the exam. On a shared record whose grant does not open the documents section, `label`, `date` and `mimeType` are null and `redacted` is true.",
  });

const exam = z
  .object({
    id: z.string(),
    modality: z.enum(IMAGING_MODALITIES),
    performedAt: z.string(),
    side: z.enum(IMAGING_SIDES).nullable(),
    bodyPart: z.string().nullable(),
    facility: z.string().nullable(),
    requestingDoctor: z.string().nullable(),
    conclusion: z.string().nullable(),
    documents: z.array(examDocument),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "ImagingExam",
    description:
      "One imaging exam. `performedAt` is the exam day at UTC midnight. The text fields are decrypted (null when empty or unreadable). `side` is null when not sided.",
  });

const examList = z
  .object({ exams: z.array(exam) })
  .meta({ id: "ImagingExamList" });

const pathId = { path: z.object({ id: z.string() }) };

const notFound = {
  "404": {
    description:
      "`imaging.notFound`: no imaging exam with this id on the record.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const ok = (description: string, schema: z.ZodType, id: string) => ({
  description,
  content: { "application/json": { schema: dataEnvelope(schema, id) } },
});

export const imagingPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/imaging": {
    get: {
      tags: ["Records"],
      summary: "List imaging exams (v1.50)",
      description:
        "The record's imaging exams, newest exam day first, each with its filed documents. At most 500.",
      responses: {
        ...recordRefusal(),
        "200": ok("The exams.", examList, "ImagingExamListEnvelope"),
        ...stdResponses,
      },
    },
    post: {
      tags: ["Records"],
      summary: "Record an imaging exam (v1.50)",
      description:
        "Creates one exam and files the named documents against it. Honours `Idempotency-Key`. Audits as `imaging.exam.create` without the text fields.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": ok("Exam recorded.", exam, "CreateImagingExamEnvelope"),
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/imaging/{id}": {
    get: {
      tags: ["Records"],
      summary: "Read an imaging exam (v1.50)",
      description: "One exam with its filed documents. Owner-scoped.",
      requestParams: pathId,
      responses: {
        ...recordRefusal(),
        "200": ok("The exam.", exam, "ImagingExamEnvelope"),
        ...notFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Records"],
      summary: "Edit an imaging exam (v1.50)",
      description:
        "Partial edit. Audits as `imaging.exam.update` with the modality, day and side before and after; the text fields are never audited.",
      requestParams: pathId,
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": ok("Exam updated.", exam, "UpdateImagingExamEnvelope"),
        ...notFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Delete an imaging exam (v1.50)",
      description:
        "Removes the exam and its document links. The documents stay in the vault. Audits as `imaging.exam.delete`.",
      requestParams: pathId,
      responses: {
        ...recordRefusal(),
        "200": ok(
          "Exam deleted.",
          z.object({ deleted: z.literal(true) }),
          "DeleteImagingExamEnvelope",
        ),
        ...notFound,
        ...stdResponses,
      },
    },
  },
};
