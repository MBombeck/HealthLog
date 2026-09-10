/**
 * OpenAPI route table for the user-scoped Biomarker catalog (`/api/biomarkers`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies reuse the runtime Zod schemas from `@/lib/validations/biomarkers`
 * so the wire contract stays single-source. The response shape is declared
 * here (the route serialises a derived `hasContext` flag the input schema
 * doesn't carry, and returns the decrypted `context`).
 *
 * The iOS client consumes the biomarker DTO + the `biomarkerId` field on
 * `LabResult` to render the resolved unit + reference range without
 * recomputing — server-authoritative parity for Labs.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  createBiomarkerSchema,
  updateBiomarkerSchema,
} from "@/lib/validations/biomarkers";

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
const createBiomarkerRequest = createBiomarkerSchema.meta({
  id: "CreateBiomarkerRequest",
  description:
    "Define a user-scoped biomarker ONCE: canonical `name`, `unit`, optional reference bounds (`lowerBound` / `upperBound`; when both present `lowerBound` must not exceed `upperBound`), an optional encrypted `context` note, and an optional `panel` grouping. The name is unique per user (no second 'LDL'). Recording a value later just picks this marker — its unit + range are never re-entered.",
});

const updateBiomarkerRequest = updateBiomarkerSchema.meta({
  id: "UpdateBiomarkerRequest",
  description:
    "Partial edit of a biomarker. An omitted key leaves the column untouched; an explicit `null` on `context` / `panel` / a bound clears it. Set `hidden` to drop / restore the marker in the active list + lab-entry pickers. A rename that collides with another of the caller's markers is rejected 409.",
});

const biomarkerRow = z
  .object({
    id: z.string(),
    name: z.string(),
    unit: z.string(),
    lowerBound: z.number().nullable(),
    upperBound: z.number().nullable(),
    panel: z.string().nullable(),
    hasContext: z.boolean(),
    context: z.string().nullable(),
    hidden: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "Biomarker",
    description:
      "A user-scoped catalog marker. `context` is the decrypted per-marker note (or null); `hasContext` flags its presence. `hidden` drops the marker from the active catalog list and the lab-entry pickers without deleting it (its readings and unit/range survive). A `LabResult` linking this marker resolves its unit + reference bounds from here.",
  });

const listResponse = z
  .object({ biomarkers: z.array(biomarkerRow) })
  .meta({ id: "ListBiomarkersResponse" });

const conflict = {
  "409": {
    description: "A biomarker with this name already exists for the caller.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const notFound = {
  "404": {
    description: "Biomarker not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

export const biomarkerPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/biomarkers": {
    get: {
      tags: ["Labs"],
      summary: "List the caller's biomarker catalog",
      description:
        "Returns every biomarker the caller has defined, name-ordered. Each carries its unit, reference bounds, and decrypted context.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Biomarker catalog.",
          content: {
            "application/json": {
              schema: dataEnvelope(listResponse, "ListBiomarkersEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Labs"],
      summary: "Define a biomarker",
      description:
        "Creates a user-scoped biomarker. The optional context note is AES-256-GCM encrypted before write. Audits as `biomarker.create`.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createBiomarkerRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Created biomarker.",
          content: {
            "application/json": {
              schema: dataEnvelope(biomarkerRow, "CreateBiomarkerResponse"),
            },
          },
        },
        ...conflict,
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/biomarkers/{id}": {
    get: {
      tags: ["Labs"],
      summary: "Fetch a single biomarker",
      description:
        "Returns the biomarker including its decrypted `context`. Cross-user rows surface as 404.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Biomarker detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(biomarkerRow, "GetBiomarkerResponse"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    put: {
      tags: ["Labs"],
      summary: "Edit a biomarker",
      description:
        "Partial edit; omitted fields are untouched, an explicit null clears `context` / `panel` / a bound. Audits as `biomarker.update`.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateBiomarkerRequest } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Updated biomarker.",
          content: {
            "application/json": {
              schema: dataEnvelope(biomarkerRow, "UpdateBiomarkerResponse"),
            },
          },
        },
        ...conflict,
        ...notFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Labs"],
      summary: "Delete a biomarker",
      description:
        "Hard-deletes the catalog definition. The `onDelete: SetNull` FK unlinks every reading (they keep their legacy `analyte` / `unit`), so the history survives. Audits as `biomarker.delete`.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteBiomarkerResponse",
              ),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
  },
};
