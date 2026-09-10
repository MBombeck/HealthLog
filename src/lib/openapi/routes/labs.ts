/**
 * OpenAPI route table for the structured lab-result store (`/api/labs`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies + query reuse the runtime Zod schemas from `@/lib/validations/labs`
 * so the wire contract stays single-source. Response shapes are declared
 * here (the route serialises a derived `rangeStatus` + `hasNote` the input
 * schema doesn't carry).
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  createLabResultSchema,
  listLabResultsSchema,
  updateLabResultSchema,
} from "@/lib/validations/labs";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

// Zod 4's `.meta()` returns a NEW instance carrying the id rather than
// annotating in place, so each annotated schema is bound to a const and the
// route table below references that const — a bare call would register nothing.
const createLabResultRequest = createLabResultSchema.meta({
  id: "CreateLabResultRequest",
  description:
    'Record a single biomarker reading (HbA1c, LDL, ferritin, TSH, …). A reading is EITHER numeric (`value` + `unit`, optional reference bounds) OR qualitative (`valueText`, e.g. "negativ" / "positiv") — exactly one, never both, never neither. `analyte` + `unit` are free-form (a lab prints its own naming); a qualitative reading needs no unit / bounds. When both numeric bounds are present `referenceLow` must not exceed `referenceHigh`. `takenAt` is a backdatable ISO instant (no future, ≤ 50 years past). The optional `note` is encrypted at rest. The optional `source` records provenance: `"OCR"` for an on-device-OCR capture (the raw image never reaches the server on this path), defaulting to `"MANUAL"` when omitted. The optional `encounterId` files the reading against a visit the caller owns — always optional, and a link that could not be made never fails the reading.',
});

const updateLabResultRequest = updateLabResultSchema.meta({
  id: "UpdateLabResultRequest",
  description:
    "Partial edit of a lab result. An omitted key leaves the column untouched; an explicit `null` on `panel` / `note` / a reference bound clears it. Edit the matching value field for the row's type — `value` for a numeric row, `valueText` for a qualitative one; a request must not carry both, and a cross-type edit (the wrong field for the row) is rejected.",
});

const listLabResultsQuery = listLabResultsSchema.meta({
  id: "ListLabResultsQuery",
  description:
    "Query params for the lab-result list: optional `analyte` (exact) + `panel` filters, an inclusive `from`/`to` date range, and `limit` (≤ 500) / `offset` pagination. Defaults to `takenAt` DESC.",
});

const rangeStatusEnum = z.enum(["in-range", "below", "above", "unknown"]).meta({
  id: "LabReferenceRangeStatus",
  description:
    "Server-computed, NEUTRAL reference-range verdict, always against `referenceLow` / `referenceHigh` (the window in force for that reading). `unknown` when no usable bounds are on file. Inclusive bounds: a value on the limit reads in-range. The badge that renders this must stay calm and informative — not an alarming red.",
});

const referenceOriginEnum = z.enum(["source", "catalog", "none"]).meta({
  id: "LabReferenceRangeOrigin",
  description:
    "Which window `referenceLow` / `referenceHigh` came from. `source` = the range printed on this reading's own report, which wins for that reading because it is the window the physician evaluated the value against. `catalog` = the user's Biomarker band, the net for readings with no printed range. `none` = no window on file.",
});

const labResultRow = z
  .object({
    id: z.string(),
    biomarkerId: z.string().nullable(),
    panel: z.string().nullable(),
    analyte: z.string(),
    // v1.18.9 — `value` is null for a qualitative reading (`valueText` set);
    // exactly one of the two is non-null per row.
    value: z.number().nullable(),
    valueText: z.string().nullable(),
    unit: z.string(),
    referenceLow: z.number().nullable(),
    referenceHigh: z.number().nullable(),
    catalogReferenceLow: z.number().nullable(),
    catalogReferenceHigh: z.number().nullable(),
    sourceReferenceLow: z.number().nullable(),
    sourceReferenceHigh: z.number().nullable(),
    sourceReferenceText: z.string().nullable(),
    referenceOrigin: referenceOriginEnum,
    referenceDivergesFromCatalog: z.boolean(),
    takenAt: z.string(),
    source: z.string(),
    hasNote: z.boolean(),
    rangeStatus: rangeStatusEnum,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "LabResult",
    description:
      "A stored lab result. Exactly one of `value` (numeric) or `valueText` (qualitative, e.g. \"negativ\") is non-null; `rangeStatus` is always `unknown` for a qualitative row (no number to classify). `biomarkerId` links the user-scoped catalog marker (null for legacy free-text rows); when linked, `analyte` / `unit` are RESOLVED server-side from the Biomarker.\n\nThree reference windows ride on the row and the server says which one applies. `referenceLow` / `referenceHigh` are the window IN FORCE and the one `rangeStatus` was computed from — read these to render the range and you are correct without doing any resolution of your own. `sourceReferenceLow` / `sourceReferenceHigh` / `sourceReferenceText` are the range this reading's own report printed (the text verbatim, kept even when no numbers could be read out of it). `catalogReferenceLow` / `catalogReferenceHigh` are the Biomarker band. `referenceOrigin` names the winner and `referenceDivergesFromCatalog` is true when the report's window and the catalog band state different limits — a surface showing only one of the two is showing a partial answer. The client renders these values and never recomputes the range. The encrypted note is never echoed in list rows; `hasNote` flags its presence and the single-resource GET returns the decrypted `note`.",
  });

const labResultDetail = labResultRow
  .omit({ hasNote: true })
  .extend({ note: z.string().nullable() })
  .meta({
    id: "LabResultDetail",
    description:
      "Single lab result including its decrypted free-text `note` (or null).",
  });

const listResponse = z
  .object({
    results: z.array(labResultRow),
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    }),
  })
  .meta({ id: "ListLabResultsResponse" });

const notFound = {
  "404": {
    description: "Lab result not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

export const labsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/labs": {
    get: {
      tags: ["Labs"],
      summary: "List the caller's lab results",
      description:
        "Returns the caller's live (non-deleted) lab results, newest first, with optional analyte / panel / date-range filters. Each row carries a server-computed neutral `rangeStatus` and a `hasNote` flag (the encrypted note itself is not echoed).",
      requestParams: { query: listLabResultsQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Lab-result list.",
          content: {
            "application/json": {
              schema: dataEnvelope(listResponse, "ListLabResultsEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Labs"],
      summary: "Record a lab result",
      description:
        'Creates a single lab result for the caller. The optional `source` marks provenance (`"MANUAL"` | `"OCR"`); it defaults to `"MANUAL"` when omitted, so the legacy hand-entry contract is unchanged. The on-device-OCR client posts `"OCR"` after the human confirms the parsed values — the raw image never touches the server on this path. The optional note is AES-256-GCM encrypted before write. Audits as `labResult.create`.',
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createLabResultRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Created lab result.",
          content: {
            "application/json": {
              schema: dataEnvelope(labResultRow, "CreateLabResultResponse"),
            },
          },
        },
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/labs/{id}": {
    get: {
      tags: ["Labs"],
      summary: "Fetch a single lab result",
      description:
        "Returns the lab result including its decrypted `note`. Cross-user rows surface as 404.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Lab-result detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(labResultDetail, "GetLabResultResponse"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    put: {
      tags: ["Labs"],
      summary: "Edit a lab result",
      description:
        "Partial edit; omitted fields are untouched, an explicit null clears `panel` / `note` / a reference bound. Audits as `labResult.update`.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateLabResultRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Updated lab result.",
          content: {
            "application/json": {
              schema: dataEnvelope(labResultRow, "UpdateLabResultResponse"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Labs"],
      summary: "Delete a lab result",
      description:
        "Soft-deletes the lab result (stamps `deletedAt`). Idempotent. Audits as `labResult.delete`.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteLabResultResponse",
              ),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
  },
  "/api/labs/restore": {
    post: {
      tags: ["Labs"],
      summary: "Restore soft-deleted lab results",
      description:
        "Un-tombstones 1..200 of the caller's soft-deleted lab results in one pass (the delete-Undo affordance). A foreign / live id is a silent no-op. Audits via the wide-event ledger.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: z
              .object({ ids: z.array(z.string()).min(1).max(200) })
              .meta({ id: "RestoreLabResultsRequest" }),
          },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "200": {
          description: "Restore count.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ restored: z.number() }),
                "RestoreLabResultsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
