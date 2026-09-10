/**
 * OpenAPI route table for the user-defined custom-metric store
 * (`/api/custom-metrics`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies reuse the runtime Zod schemas from `@/lib/validations/custom-metrics`
 * so the wire contract stays single-source. The response shapes are declared
 * here.
 *
 * Custom metrics are a separate generic store from the closed measurement
 * system. A definition can explicitly opt into the bounded daily correlation
 * behaviour-channel scan. All fields are plaintext.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  createCustomMetricEntrySchema,
  createCustomMetricSchema,
  updateCustomMetricEntrySchema,
  updateCustomMetricSchema,
} from "@/lib/validations/custom-metrics";

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
const createCustomMetricRequest = createCustomMetricSchema.meta({
  id: "CreateCustomMetricRequest",
  description:
    "Define a user-scoped custom metric ONCE: free-text `name` + `unit`, an optional target window (`targetLow` / `targetHigh`; when both present `targetLow` must not exceed `targetHigh`), optional display `decimals`, an optional `description`, and explicit `correlationEnabled` opt-in. The name is unique per user. Logging a value later snapshots its unit.",
});

const updateCustomMetricRequest = updateCustomMetricSchema.meta({
  id: "UpdateCustomMetricRequest",
  description:
    "Partial edit of a custom metric. An omitted key leaves the column untouched; an explicit `null` on a target bound / `decimals` / `description` clears it. `correlationEnabled` explicitly controls use as a bounded behaviour channel. A conflicting rename is rejected 409.",
});

const createCustomMetricEntryRequest = createCustomMetricEntrySchema.meta({
  id: "CreateCustomMetricEntryRequest",
  description:
    "Log a value against a custom metric: numeric `value`, ISO 8601 `measuredAt`, optional free-text `note`. The metric's current unit is snapshotted onto the entry server-side.",
});

const updateCustomMetricEntryRequest = updateCustomMetricEntrySchema.meta({
  id: "UpdateCustomMetricEntryRequest",
  description:
    "Partial edit of a logged value. An omitted key leaves the column untouched; an explicit `null` on `note` clears it.",
});

const latestValue = z
  .object({
    value: z.number(),
    unit: z.string(),
    measuredAt: z.string(),
  })
  .nullable();

const customMetricRow = z
  .object({
    id: z.string(),
    name: z.string(),
    unit: z.string(),
    targetLow: z.number().nullable(),
    targetHigh: z.number().nullable(),
    decimals: z.number().nullable(),
    description: z.string().nullable(),
    correlationEnabled: z.boolean(),
    latest: latestValue,
    entryCount: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "CustomMetric",
    description:
      "A user-defined custom metric. `latest` is the most recently logged value (or null); `entryCount` is the total logged values. The optional target window is the user's own good range, charted as a reference band.",
  });

const entryRow = z
  .object({
    id: z.string(),
    customMetricId: z.string(),
    value: z.number(),
    unit: z.string(),
    measuredAt: z.string(),
    note: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({
    id: "CustomMetricEntry",
    description:
      "A single logged value for a custom metric. `unit` is a snapshot of the metric's unit at write time.",
  });

const listResponse = z
  .object({ customMetrics: z.array(customMetricRow) })
  .meta({ id: "ListCustomMetricsResponse" });

const entriesResponse = z
  .object({
    entries: z.array(entryRow),
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    }),
  })
  .meta({ id: "ListCustomMetricEntriesResponse" });

const conflict = {
  "409": {
    description:
      "A custom metric with this name already exists for the caller.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const notFound = {
  "404": {
    description: "Custom metric not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const entryNotFound = {
  "404": {
    description: "Custom metric entry not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

export const customMetricPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/custom-metrics": {
    get: {
      tags: ["Custom metrics"],
      summary: "List the caller's custom metrics",
      description:
        "Returns every custom metric the caller has defined, name-ordered, each with its latest logged value and total value count.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Custom-metric catalog.",
          content: {
            "application/json": {
              schema: dataEnvelope(listResponse, "ListCustomMetricsEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Custom metrics"],
      summary: "Define a custom metric",
      description:
        "Creates a user-scoped custom metric. Re-creating a name that was previously soft-deleted revives that definition. Audits as `customMetric.create`.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createCustomMetricRequest } },
      },
      responses: {
        ...idempotentWrite(),
        "201": {
          description: "Created custom metric.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                customMetricRow,
                "CreateCustomMetricResponse",
              ),
            },
          },
        },
        ...conflict,
        ...stdResponses,
      },
    },
  },
  "/api/custom-metrics/{id}": {
    get: {
      tags: ["Custom metrics"],
      summary: "Fetch a single custom metric",
      description:
        "Returns the custom-metric definition. Cross-user rows surface as 404.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Custom-metric detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(customMetricRow, "GetCustomMetricResponse"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Custom metrics"],
      summary: "Edit a custom metric",
      description:
        "Partial edit; omitted fields are untouched, an explicit null clears a target bound / decimals / description. Audits as `customMetric.update`.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateCustomMetricRequest } },
      },
      responses: {
        "200": {
          description: "Updated custom metric.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                customMetricRow,
                "UpdateCustomMetricResponse",
              ),
            },
          },
        },
        ...conflict,
        ...notFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Custom metrics"],
      summary: "Delete a custom metric",
      description:
        "Soft-deletes the metric (stamps `deletedAt`); its logged values are retained and re-creating the name revives it. Audits as `customMetric.delete`.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteCustomMetricResponse",
              ),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
  },
  "/api/custom-metrics/{id}/entries": {
    get: {
      tags: ["Custom metrics"],
      summary: "List a custom metric's logged values",
      description:
        "Offset-paginated value feed for one custom metric (the chart + history read). Cross-user / unknown metric ids surface as 404.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          sortDir: z.enum(["asc", "desc"]).optional(),
        }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Logged values.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                entriesResponse,
                "ListCustomMetricEntriesEnvelope",
              ),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Custom metrics"],
      summary: "Log a value",
      description:
        "Records a value against the custom metric, snapshotting the metric's unit. Audits as `customMetricEntry.create`.",
      requestParams: { path: z.object({ id: z.string() }) },
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createCustomMetricEntryRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        "201": {
          description: "Created value.",
          content: {
            "application/json": {
              schema: dataEnvelope(entryRow, "CreateCustomMetricEntryResponse"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/custom-metrics/{id}/entries/{entryId}": {
    patch: {
      tags: ["Custom metrics"],
      summary: "Edit a logged value",
      description:
        "Partial edit of a value; omitted fields untouched, explicit null clears `note`. Audits as `customMetricEntry.update`.",
      requestParams: {
        path: z.object({ id: z.string(), entryId: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateCustomMetricEntryRequest },
        },
      },
      responses: {
        "200": {
          description: "Updated value.",
          content: {
            "application/json": {
              schema: dataEnvelope(entryRow, "UpdateCustomMetricEntryResponse"),
            },
          },
        },
        ...entryNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Custom metrics"],
      summary: "Delete a logged value",
      description:
        "Tombstones the value (soft delete, v1.37.20); the sibling entries/restore endpoint clears the tombstone. Audits as `customMetricEntry.delete`.",
      requestParams: {
        path: z.object({ id: z.string(), entryId: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteCustomMetricEntryResponse",
              ),
            },
          },
        },
        ...entryNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/custom-metrics/{id}/entries/restore": {
    post: {
      tags: ["Custom metrics"],
      summary: "Restore tombstoned values (v1.37.20)",
      description:
        "Clears deletedAt on every owned, currently-tombstoned entry of this metric named in ids (1..200). A foreign, live or mismatched-parent id is a silent no-op, never an existence leak. Backs the delete toast's Undo. Audits as `customMetricEntry.restore`.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: z
              .object({ ids: z.array(z.string().min(1)).min(1).max(200) })
              .meta({ id: "RestoreCustomMetricEntriesRequest" }),
          },
        },
      },
      responses: {
        "200": {
          description: "Count of entries restored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ restored: z.number().int() }),
                "RestoreCustomMetricEntriesResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
