/**
 * OpenAPI route table for background document AI runs (`/api/ai-runs/*`).
 * The request header and the 202 the queuing routes share live in
 * `./ai-run-accepted.ts`, so this module can read the result schemas of the
 * routes it serves without an import cycle.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * iOS coordination (v1.40): `POST /api/documents/inbound/{id}/index`,
 * `…/summary`, `…/suggest` and `…/extract` keep their 200 bodies when the
 * request carries no `Prefer` header. A client that sends
 * `Prefer: respond-async` gets 202 with a run id and polls the run here; the
 * result is the body the route would have answered with, except for extract,
 * whose run carries `DocumentExtractRunResult`.
 * `POST /api/labs/ocr/extract` (web only) always answers 202.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  documentExtractRunResult,
  documentIndexResponse,
  documentSuggestResponse,
  documentSummaryResponse,
} from "./documents";
import { supplementLabelExtractResult } from "./medications";
import { ocrExtractResponse } from "./ocr";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const aiRun = z
  .object({
    id: z.string(),
    kind: z.enum([
      "DOCUMENT_INDEX",
      "LABS_OCR_EXTRACT",
      "DOCUMENT_SUMMARY",
      "DOCUMENT_SUGGEST",
      "DOCUMENT_EXTRACT",
      "SUPPLEMENT_LABEL_EXTRACT",
    ]),
    documentId: z
      .string()
      .nullable()
      .describe("The document a document run reads; null for a lab scan."),
    status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]),
    result: z
      .union([
        documentIndexResponse,
        ocrExtractResponse,
        documentSummaryResponse,
        documentSuggestResponse,
        documentExtractRunResult,
        supplementLabelExtractResult,
      ])
      .nullable()
      .describe(
        "Present once `status` is `SUCCEEDED`: the body the queuing route answers with synchronously. `DOCUMENT_INDEX` carries `DocumentIndexResponse`, `LABS_OCR_EXTRACT` carries `OcrExtractResponse`, `DOCUMENT_SUMMARY` carries `DocumentSummaryResponse`, `DOCUMENT_SUGGEST` carries `DocumentSuggestResponse`, `DOCUMENT_EXTRACT` carries `DocumentExtractRunResult` (not the extract route's detail body), `SUPPLEMENT_LABEL_EXTRACT` (v1.43) carries `SupplementLabelExtractResult`. Decode by `kind`; treat an unknown `kind` as a run this client did not start.",
      ),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        status: z.number().int(),
      })
      .nullable()
      .describe(
        "Present once `status` is `FAILED`: the `meta.errorCode`, message and HTTP status the queuing route would have answered with, or one of the run's own codes: `aiRuns.workerUnavailable` (no worker took the run within fifteen minutes), `aiRuns.timedOut` (the read outlived the calls the AI response time allows), `aiRuns.readerBusy` (the server's document reader was busy past the wait a read gets, or stopped before it answered; nothing was read or charged, try again in a minute), `aiRuns.failed` (anything else).",
      ),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    queuedForMs: z
      .number()
      .int()
      .nullable()
      .describe(
        "While queued, how long the run has waited for a worker. A long wait usually means the background worker is not running.",
      ),
    retryAfterMs: z
      .number()
      .int()
      .nullable()
      .describe(
        "While not terminal, when to poll again (also sent as `Retry-After`, in seconds). Null once the run has ended.",
      ),
  })
  .meta({
    id: "AiRun",
    description:
      "One background document AI run. Results and failures stay readable for an hour after the run ends; the run is then deleted and answers 404.",
  });

export const aiRunPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/ai-runs/{id}": {
    get: {
      tags: ["Documents"],
      summary: "Poll a background document AI run",
      description:
        "Where one background read stands, and its result or failure once it ends. Scoped to the caller: another account's run, a run that never existed, and a run more than an hour past its end are the same 404 `aiRuns.notFound`. A plain read of the caller's own run; it calls no model and asks no AI capability (those were asked when the run was queued, and again in the worker before anything left the server). Auth via cookie or Bearer.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "The run.",
          content: {
            "application/json": {
              schema: dataEnvelope(aiRun, "AiRunEnvelope"),
            },
          },
        },
        "404": {
          description: "`aiRuns.notFound`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
