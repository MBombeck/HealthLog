/**
 * OpenAPI route table for structured allergies (`/api/allergies`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies + queries reuse the runtime Zod schemas from
 * `@/lib/validations/allergy` so the wire contract stays single-source.
 * Response shapes are declared here to mirror the server-authoritative DTOs in
 * `@/lib/records/dto.ts` (the routes serialise a decrypted `reaction` + `note`
 * the input schemas don't carry; iOS renders the DTO, it never recomputes it).
 *
 * A structured AllergyIntolerance-style RECORD — patient-reported, never a
 * clinical diagnosis. Owner-scoped; auth-gated.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  allergyCreateSchema,
  allergyUpdateSchema,
  allergyListQuerySchema,
  allergyCategoryEnum,
  allergyTypeEnum,
  allergySeverityEnum,
  allergyStatusEnum,
} from "@/lib/validations/allergy";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

// `.meta()` CLONES in Zod 4 rather than annotating in place, so the returned
// schema has to be captured and referenced. A bare `schema.meta({...})`
// statement registers nothing and the component id it names never reaches the
// emitted document.
const createAllergyRequest = allergyCreateSchema.meta({
  id: "CreateAllergyRequest",
  description:
    "Record an allergy/intolerance. `substance` is the user-facing allergen name (the FHIR AllergyIntolerance `code.text` anchor — never a machine-guessed code). The free-text `reaction` + `note` are encrypted at rest. `onsetAt` is optional (unknown when omitted). Patient-reported.",
});

const updateAllergyRequest = allergyUpdateSchema.meta({
  id: "UpdateAllergyRequest",
  description:
    "Partial edit of an allergy; an omitted key leaves the column untouched. A `null` `severity`/`onsetAt`/`reaction`/`note` clears that field. Rejects unknown keys.",
});

const listAllergiesQuery = allergyListQuerySchema.meta({
  id: "ListAllergiesQuery",
  description:
    "Query params for the allergy list: optional `limit` (1–200, default 100) and `includeInactive` ('true' | 'false'); 'false' returns only ACTIVE records. Newest-first.",
});

const allergy = z
  .object({
    id: z.string(),
    substance: z.string(),
    category: allergyCategoryEnum,
    type: allergyTypeEnum,
    severity: allergySeverityEnum.nullable(),
    status: allergyStatusEnum,
    onsetAt: z.string().nullable(),
    reaction: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "Allergy",
    description:
      "A stored allergy/intolerance record. `reaction` + `note` are the decrypted free-text (or null on a key-rotation gap — fail-soft, never 500). `severity`/`onsetAt` are null when not assessed/known.",
  });

const allergyNotFound = {
  "404": {
    description: "Allergy not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

export const allergyPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/allergies": {
    get: {
      tags: ["Records"],
      summary: "List allergies (v1.25)",
      description:
        "Returns the caller's live (non-deleted) allergy/intolerance records, newest-first. `includeInactive=false` returns only ACTIVE records.",
      requestParams: { query: listAllergiesQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The caller's allergy records.",
          content: {
            "application/json": {
              schema: dataEnvelope(z.array(allergy), "ListAllergiesEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Records"],
      summary: "Record an allergy (v1.25)",
      description:
        "Creates one allergy/intolerance record for the caller. The free-text reaction + note are AES-256-GCM encrypted before write. Audits as `allergy.create`.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createAllergyRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Allergy created.",
          content: {
            "application/json": {
              schema: dataEnvelope(allergy, "CreateAllergyEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/allergies/{id}": {
    get: {
      tags: ["Records"],
      summary: "Read a single allergy (v1.25)",
      description:
        "Returns the record including its decrypted `reaction` + `note`. Owner-scoped; a cross-user or tombstoned id 404s.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The allergy record.",
          content: {
            "application/json": {
              schema: dataEnvelope(allergy, "GetAllergyEnvelope"),
            },
          },
        },
        ...allergyNotFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Records"],
      summary: "Edit an allergy (v1.25)",
      description:
        "Partial edit; omitted fields are left untouched. Audits as `allergy.update`. Owner-scoped.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateAllergyRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Allergy updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(allergy, "UpdateAllergyEnvelope"),
            },
          },
        },
        ...allergyNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Soft-delete an allergy (v1.25)",
      description:
        "Stamps `deletedAt` (tombstone). Idempotent — a re-delete is a no-op. Returns the `{ deleted: true }` envelope. Audits as `allergy.delete`. Owner-scoped.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Soft-deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteAllergyEnvelope",
              ),
            },
          },
        },
        ...allergyNotFound,
        ...stdResponses,
      },
    },
  },
};
