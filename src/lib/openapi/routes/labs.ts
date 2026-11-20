/**
 * OpenAPI route table for the structured lab-result store (`/api/labs`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies + query reuse the runtime Zod schemas from `@/lib/validations/labs`
 * so the wire contract stays single-source. Response shapes are declared
 * here (the route serialises a derived `rangeStatus` + `hasNote` the input
 * schema doesn't carry).
 */
import { withRelated } from "./relation-links";
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { LAB_UNIT_DESCRIPTION } from "@/lib/labs/dimensionless";

import {
  createLabResultSchema,
  labOverviewQuerySchema,
  listLabResultsSchema,
  updateLabResultSchema,
} from "@/lib/validations/labs";
import {
  FHIR_LAB_FAILURE_REASONS,
  FHIR_LAB_SKIP_REASONS,
} from "@/lib/labs/fhir-import/types";
import { fhirLabBatchSchema } from "@/lib/validations/labs-fhir";

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
    unit: z.string().describe(LAB_UNIT_DESCRIPTION),
    converted: z.boolean(),
    sourceValue: z.number().nullable(),
    sourceUnit: z.string().nullable(),
    referenceLow: z.number().nullable(),
    referenceHigh: z.number().nullable(),
    catalogReferenceLow: z.number().nullable(),
    catalogReferenceHigh: z.number().nullable(),
    sourceReferenceLow: z.number().nullable(),
    sourceReferenceHigh: z.number().nullable(),
    sourceReferenceText: z.string().nullable(),
    printedReferenceText: z.string().nullable(),
    referenceOrigin: referenceOriginEnum,
    referenceDivergesFromCatalog: z.boolean(),
    takenAt: z.string(),
    source: z.string().meta({
      description:
        "Where the reading came from: `MANUAL` (typed), `OCR` (a scanned report), `DOCUMENT` (a document import), `IMPORT` (a lab CSV) or `APPLE_HEALTH` (Apple Health's Health Records, from an export or `POST /api/labs/fhir-batch`). Open-ended: render an unknown value as-is.",
    }),
    hasNote: z.boolean(),
    rangeStatus: rangeStatusEnum,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "LabResult",
    description:
      "A stored lab result. Exactly one of `value` (numeric) or `valueText` (qualitative, e.g. \"negativ\") is non-null; `rangeStatus` is always `unknown` for a qualitative row (no number to classify). `biomarkerId` links the user-scoped catalog marker (null for legacy free-text rows); when linked, `analyte` / `unit` are RESOLVED server-side from the Biomarker.\n\nThree reference windows ride on the row and the server says which one applies. `referenceLow` / `referenceHigh` are the window IN FORCE and the one `rangeStatus` was computed from — read these to render the range and you are correct without doing any resolution of your own. `sourceReferenceLow` / `sourceReferenceHigh` / `sourceReferenceText` are the range this reading's own report printed (the text verbatim, kept even when no numbers could be read out of it). `catalogReferenceLow` / `catalogReferenceHigh` are the Biomarker band. `referenceOrigin` names the winner and `referenceDivergesFromCatalog` is true when the report's window and the catalog band state different limits — a surface showing only one of the two is showing a partial answer. The client renders these values and never recomputes the range. `converted` is true when the stored `value` was converted into the marker's `unit` from another unit; `sourceValue` and `sourceUnit` are then what the report printed (full precision, round for display), and the report's own window was converted with it: `sourceReferenceLow` / `sourceReferenceHigh` are then in the marker's `unit`. The printed range text is not converted and stays in `sourceUnit`, so for a converted reading `sourceReferenceText` is null and the verbatim text is in `printedReferenceText` instead, never mixed with the converted numbers. A reading stored as stated has `converted: false`, two nulls and a null `printedReferenceText`. The encrypted note is never echoed in list rows; `hasNote` flags its presence and the single-resource GET returns the decrypted `note`.",
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

const labOverviewQuery = labOverviewQuerySchema.meta({
  id: "LabOverviewQuery",
  description:
    "The overview takes no query parameters; it always covers the whole live history. An unknown parameter is refused with 422.",
});

const labOverviewMarker = z
  .object({
    key: z.string(),
    count: z.number().int(),
    trend: z.array(z.number().nullable()),
    latest: labResultRow,
  })
  .meta({
    id: "LabOverviewMarker",
    description:
      "One biomarker in the caller's lab history. `key` is `bm:<biomarkerId>` for a catalog-linked marker or `analyte:<lower-cased name>` for a legacy unlinked one. `count` is every live reading of the marker. `trend` holds the values of its newest readings (at most 50), oldest first, null for a qualitative reading. `latest` is the newest reading, serialised exactly like a `GET /api/labs` row.",
  });

export const labOverviewCategoryCounts = z
  .object({
    inRange: z.number().int(),
    below: z.number().int(),
    above: z.number().int(),
    unknown: z.number().int(),
  })
  .meta({
    id: "LabOverviewCategoryCounts",
    description:
      "How many members' newest readings are in range, below, above, or unassessed (qualitative, or no range).",
  });

export const labOverviewCategory = z
  .object({
    key: z.string(),
    label: z.string(),
    markerKeys: z.array(z.string()),
    counts: labOverviewCategoryCounts,
    status: z.enum(["in-range", "below", "above", "unknown"]),
  })
  .meta({
    id: "LabOverviewCategory",
    description:
      "One category of the labs list, resolved by the server. `key` is opaque: a catalog panel key, `custom:<hash>` for the person's own panel, or `other`; it carries no user text and is stable, so a client may key collapse state on it. `label` is rendered as given (a catalog panel in the caller's locale, the person's own spelling, or the localised \"Other\"). `markerKeys` names the `markers[].key` values in the category. `status` combines the members' newest readings: `above` when any is above its range, else `below` when any is below, else `in-range` when any was assessed, else `unknown`. A client renders these values and never rebuilds the category, the order or the status. A client that shows only the members matching a filter may summarise that subset by the same rule; without a filter it shows `counts` and `status` as sent.",
  });

export const labOverviewResponse = z
  .object({
    markers: z.array(labOverviewMarker),
    categories: z.array(labOverviewCategory).meta({
      description:
        "The list's categories in display order, already arranged for the caller: the default order is catalog panels in catalog order, then the person's own panels by label, then `other`, and the caller's `categoryOrder` (`PUT /api/settings/module-list-layout`, labs list) is applied over it. Render them in this order.",
    }),
    grouped: z.boolean().meta({
      description:
        "Whether grouping adds anything: true when there are two categories or more and at least one is not `other`. A client that shows categories (the `groupBy` list preference) shows a flat list while this is false.",
    }),
  })
  .meta({ id: "LabOverviewResponse" });

const fhirLabBatchRequest = fhirLabBatchSchema.meta({
  id: "FhirLabBatchRequest",
  description:
    "1 to 200 Health Records lab results (`HKClinicalTypeIdentifierLabResultRecord`), each the FHIR resource as JSON plus the HealthKit fields its identity is built from. Send a panel and its members in the same batch so the members carry the panel's name. No `userId`: the owner is the caller.",
});

const fhirLabRecordResult = z
  .object({
    index: z.number().int(),
    status: z.enum(["inserted", "duplicate", "skipped", "failed"]),
    reason: z
      .enum([...FHIR_LAB_SKIP_REASONS, ...FHIR_LAB_FAILURE_REASONS])
      .optional(),
  })
  .meta({
    id: "FhirLabRecordResult",
    description:
      "One record's outcome, by its position in the request. `inserted`: written. `duplicate`: the record already holds it, under the same identity (deleted readings included, also once the reading or its whole marker is gone, so a deleted result stays deleted) or as the same reading on the same day from another source. `skipped`: not a reading HealthLog keeps, with `reason` `not_observation` | `not_lab` (no category names a lab; a code, display or text containing `lab` in any case counts) | `not_final` (preliminary; it is taken once final) | `withdrawn` (entered in error or cancelled; a reading already stored from an earlier version of the result is not removed, delete it through `DELETE /api/labs/{id}`) | `panel_header` | `no_value` | `unsupported_value` | `no_date` | `future_date` | `invalid_date` | `too_large` (a resource over 256 KiB). `failed`: a reading that could not be stored, with `reason` `missing_unit` (a number without a unit; a specific gravity, a pH or an INR, known by its LOINC code, is read as the unity `1` instead) | `unit_mismatch` (the account's marker is in a unit this one does not convert into) | `marker_unit_unset` (the account's marker has no unit and already holds numbers; set the marker's unit, then send it again) | `text_too_long` | `write_failed` (transient: send it again).",
  });

const fhirLabBatchResponse = z
  .object({
    results: z.array(fhirLabRecordResult),
    inserted: z.number().int(),
    duplicate: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    outcome: z.enum(["empty", "failed", "partial", "success"]),
  })
  .meta({ id: "FhirLabBatchResponse" });

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
        "422": {
          description:
            "Nothing was written. `meta.errorCode` = `labs.create.invalid` when the body failed validation (every issue under `details.issues`), `labs.unit.unset` when the marker has no unit and already holds numbers stored without one (set the marker's unit first; `meta.reason` = `marker_unit_unset`), or `labs.unit.mismatch` when a numeric reading states a `unit` other than the one its marker is tracked in AND the pair cannot be converted (`meta.markerUnit`, `meta.readingUnit`, `meta.reason` = `unknown_analyte` | `unknown_unit` | `not_finite`). A unit is compared only when one is sent; with a `biomarkerId` it may be omitted and the marker's unit is then the stated one. Spelling is forgiven (`mmol/l`, `ug/L` for `µg/L`); a different unit is converted when the marker's analyte is known and the pair is in the unit-conversion registry (the 201 response then carries `converted: true`), and refused otherwise, never relabelled.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/labs/fhir-batch": {
    post: {
      tags: ["Labs"],
      summary: "Ingest lab results from Apple Health's Health Records",
      description:
        "Maps each FHIR lab result (DSTU2 or R4 Observation) to a lab reading and writes it: final results only (`final`, `amended`, `corrected`), the laboratory category, numeric values in their unit (UCUM codes are read), a value with a comparator (`<0.5 mg/L`) kept as text as printed, string and coded values as text, the report's own reference range, and the panel's name for its members. The name resolves to the caller's marker by its own name, an alias, or the catalog analyte its LOINC code names; a new analyte gets a new marker; a reading in another unit is converted when the conversion is known and refused otherwise. The identity is a digest of `sourceURL` and `identifier`, the same one an Apple Health export import builds, so a result already imported from an export is a `duplicate` here, and sending a batch again is safe. First write wins: an amended result under a held identity is a duplicate. Owner-only: a cookie session or a full-scope login token. The body is capped at 1 MiB (413 past it): a client splits a large sync by size as well as by count. Rate limit 60 batches a minute; Idempotency-Key supported. A response carrying `write_failed` is `Cache-Control: no-store` and is not replayed for its key. Audits as `labs.fhir.batch` with counts only.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: fhirLabBatchRequest } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description:
            "Batch processed; one result per record. `outcome` reads `inserted` against `failed` (skips and duplicates are information, not failure).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                fhirLabBatchResponse,
                "FhirLabBatchEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        "422": {
          description:
            "Nothing was written. `meta.errorCode` = `labs.fhir_batch.invalid`: no records, more than 200, a record without a `resource` object, an over-long HealthKit field, or a field the request does not define (every issue under `details.issues`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/labs/overview": {
    get: {
      tags: ["Labs"],
      summary: "Per-marker overview of the caller's lab history",
      description:
        "One entry per biomarker over every live lab result, newest reading first: the newest reading, the reading count and a short trend. Unlike `GET /api/labs` it is not paged, so a marker measured only long ago is never cut off by a page size. `categories` and `grouped` carry the list's categories, resolved server-side; their labels follow the caller's locale (the language cookie, else the caller's stored language, else `Accept-Language`).",
      requestParams: { query: labOverviewQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Lab overview.",
          content: {
            "application/json": {
              schema: dataEnvelope(labOverviewResponse, "LabOverviewEnvelope"),
            },
          },
        },
        ...stdResponses,
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
              schema: dataEnvelope(
                withRelated(labResultDetail),
                "GetLabResultResponse",
              ),
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
