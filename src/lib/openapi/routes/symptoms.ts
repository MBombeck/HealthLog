/**
 * OpenAPI route table for person-defined symptoms (`/api/symptoms`, v1.40).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request bodies
 * and queries reuse the runtime Zod schemas from `@/lib/symptoms/shared` so the
 * wire contract stays single-source; response shapes mirror the DTOs the
 * routes serialise (decrypted label and note, the 30-day summary).
 *
 * Every route rides the illness module: an account that turned it off (or an
 * operator-disabled instance) answers 403 `illness.disabled` even to a valid
 * Bearer token.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  MAX_ACTIVE_SYMPTOM_DEFINITIONS,
  symptomDefinitionCreateSchema,
  symptomDefinitionUpdateSchema,
  symptomEventCreateSchema,
  symptomEventListQuerySchema,
  symptomEventUpdateSchema,
} from "@/lib/symptoms/shared";

import { dayDoseOffsetField } from "@/lib/day/dose-offset-schema";
import { symptomBatchPayloadSchema } from "@/lib/symptoms/batch-schema";
import { SYMPTOM_BUILTIN_CODES } from "@/lib/symptoms/builtin";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  recordWriteRateLimitResponse,
  SHARING_NOT_PERMITTED_DESCRIPTION,
  stdResponses,
} from "./shared";

const MODULE_OFF =
  "`illness.disabled`: the record has the illness module switched off (or the operator turned it off server-wide); symptoms ride that module.";

const createSymptomDefinitionRequest = symptomDefinitionCreateSchema.meta({
  id: "CreateSymptomDefinitionRequest",
  description: `Define a symptom of your own. \`label\` (1-40 characters) is encrypted at rest; \`icon\` is one of the cycle custom-symptom icon names, null for the default glyph. At most ${MAX_ACTIVE_SYMPTOM_DEFINITIONS} active definitions the person named per account (\`limit\` on the list; 422 \`symptoms.definition.limitReached\` past it); the built-in ones Apple Health creates do not count. Until v1.48.4 the cap was eight.`,
});

const updateSymptomDefinitionRequest = symptomDefinitionUpdateSchema.meta({
  id: "UpdateSymptomDefinitionRequest",
  description:
    "Partial edit; an omitted key leaves the column untouched. `isActive: false` hides the symptom (history kept, slot freed); `isActive: true` shows it again and re-checks the cap.",
});

const createSymptomEventRequest = symptomEventCreateSchema.meta({
  id: "CreateSymptomEventRequest",
  description:
    "Log one occurrence. `intensity` is 0-10 (0 none, 10 the worst imaginable). `occurredAt` defaults to now and may not lie in the future beyond five minutes. `episodeId`, when given, must name one of the record's own illness episodes that is still open, or a resolved one whose onset-to-recovery span holds `occurredAt` (422 `symptoms.episode.notOpen` otherwise). The note is encrypted at rest.",
});

const updateSymptomEventRequest = symptomEventUpdateSchema.meta({
  id: "UpdateSymptomEventRequest",
  description:
    "Partial edit of one occurrence. `note: null` clears the note, `episodeId: null` drops the link. A changed `episodeId` must name an open episode or a resolved one whose span holds the occurrence's time after the edit; an unchanged link to an episode that has since resolved is kept.",
});

const listSymptomEventsQuery = symptomEventListQuerySchema.meta({
  id: "ListSymptomEventsQuery",
  description:
    "Optional `from` / `to` (ISO instants, inclusive), `definitionId`, `episodeId` (only the occurrences filed against that episode: the link, not the time span, is what assigns an occurrence to an illness), and `limit` (1-500, default 200). Newest first.",
});

const symptomDefinition = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    icon: z.string().nullable(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    code: z
      .string()
      .nullable()
      .describe(
        "Since v1.48.2. The built-in code an Apple Health symptom sample lands on (`FEVER`, `HEADACHE`, ...), or null for a symptom the person named. A built-in definition is created on the first sample of its code, labelled in the record owner's language; it may be renamed or hidden and keeps its code. It holds no slot of the active-definition cap. Decode unknown codes leniently.",
      ),
    recent: z.object({
      count30d: z.number().int(),
      maxIntensity30d: z.number().int().nullable(),
      lastOccurredAt: z.string().nullable(),
    }),
  })
  .meta({
    id: "SymptomDefinition",
    description:
      "A symptom the person defined. `label` is decrypted (null only on an unreadable value). `recent` is computed server-side: occurrences and the highest intensity over the last 30 days, and the last occurrence ever. Each active definition is also the correlation channel `SYMPTOM:<id>`.",
  });

const symptomDefinitionList = z
  .object({
    definitions: z.array(symptomDefinition),
    limit: z.number().int(),
  })
  .meta({
    id: "SymptomDefinitionList",
    description: `The record's symptom definitions in display order, and \`limit\`, the cap on active definitions the person named (${MAX_ACTIVE_SYMPTOM_DEFINITIONS} since v1.48.4, eight before). Read it rather than assuming a number.`,
  });

const symptomEvent = z
  .object({
    id: z.string(),
    definitionId: z.string(),
    occurredAt: z.string(),
    intensity: z.number().int(),
    note: z.string().nullable(),
    episodeId: z.string().nullable(),
    endAt: z
      .string()
      .nullable()
      .describe(
        "Since v1.48.2. When it ended, for an occurrence imported with a duration; null for a moment and for every manual entry.",
      ),
    source: z
      .string()
      .describe(
        "Since v1.48.2. `MANUAL` (logged in HealthLog) or `APPLE_HEALTH` (imported through `POST /api/symptoms/events/batch`). Never set by a manual write. Decode unknown values leniently.",
      ),
    externalId: z
      .string()
      .nullable()
      .describe(
        "Since v1.48.2. The HealthKit sample UUID of an imported occurrence; null for a manual one.",
      ),
    createdAt: z.string(),
    updatedAt: z.string(),
    doseOffset: dayDoseOffsetField.describe(
      "Since v1.49.0, on `GET /api/symptoms/events` only (feature key `day.dose-offset`). The same value `GET /api/day/{date}` carries for this occurrence: its distance from the nearest dose taken at or before it on the same local day of the record's zone, else the nearest one after it. Absent when that day holds no timed dose, when the medications module is off, or when a delegate's grant does not cover medications. A distance in time and nothing more; never a cause.",
    ),
  })
  .meta({
    id: "SymptomEvent",
    description:
      "One occurrence of a defined symptom: when, how strong (0-10), the decrypted note, and the illness episode it was filed against (null when none).",
  });

const symptomEventList = z
  .object({
    events: z.array(symptomEvent),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .meta({
    id: "SymptomEventList",
    description:
      "A page of occurrences, newest first. `hasMore` is true exactly when an occurrence past this page exists; page on with `to` set to the oldest `occurredAt` seen.",
  });

const deletedResponse = z
  .object({
    deleted: z.literal(true),
    purged: z.boolean(),
    eventsDeleted: z.number().int(),
  })
  .meta({
    id: "SymptomDefinitionDeleted",
    description:
      "`purged: false` means the definition was hidden and its history kept; `purged: true` means `eventsDeleted` occurrences were removed, and the definition with them unless it is built-in (`code` set), which stays hidden.",
  });

const symptomBatchRequest = symptomBatchPayloadSchema.meta({
  id: "SymptomBatchRequest",
  description: `Apple Health symptom samples, 1-500 per call. Per entry: \`code\` one of the built-in codes (${SYMPTOM_BUILTIN_CODES.join(", ")}), each the HealthKit category type \`HKCategoryTypeIdentifier<PascalCase of the code>\`; \`occurredAt\` the sample's start, \`endAt\` its end (omit when equal); \`intensity\` 0-10 (the app maps HKCategoryValueSeverity unspecified to 5, mild to 3, moderate to 6, severe to 9, and sends no entry for notPresent); \`externalId\` the HKSample UUID; \`source\` \`APPLE_HEALTH\`. Unknown keys are ignored.`,
});

const symptomBatchEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z
      .enum(["inserted", "updated", "duplicate", "skipped", "failed"])
      .describe(
        "`inserted` and `duplicate` landed (advance the cursor); `updated` is never sent here but is part of the shared batch shape. `skipped` is permanent for the entry as sent, see `reason`. `failed` is transient: keep the entry and send it again; the response is then not replayed for its `Idempotency-Key`.",
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "Why an entry was `skipped`: `unsupported_source` (source other than `APPLE_HEALTH`), `unstable_external_id`, `unknown_code`, `value_out_of_range` (intensity not an integer 0-10), `implausible_timestamp` (in the future beyond five minutes, before 1900, or ending before it started). `deleted_in_healthlog` (since v1.49.0) for a sample the person deleted in HealthLog, which stays deleted. A sample the phone reported deleted through `DELETE /api/symptoms/events/by-external-ids` is written back when it is posted again (`inserted`). Decode unknown reasons leniently.",
      ),
  })
  .meta({ id: "SymptomBatchEntryResult" });

const symptomBatchResponse = z
  .object({
    processed: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    entries: z.array(symptomBatchEntryResult),
  })
  .meta({
    id: "SymptomBatchResponse",
    description:
      "The `POST /api/measurements/batch` answer shape. Every sent index appears once in `entries`; `skipped` repeats the skipped ones with their reason.",
  });

const pathId = { path: z.object({ id: z.string() }) };

const definitionNotFound = {
  "404": {
    description:
      "`symptoms.definition.notFound`: no definition with this id on the record.",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

const eventNotFound = {
  "404": {
    description:
      "`symptoms.event.notFound`: no occurrence with this id on the record.",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

export const symptomPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/symptoms/definitions": {
    get: {
      tags: ["Symptoms"],
      summary: "List your own symptoms (v1.40)",
      description:
        "The record's active symptom definitions with their 30-day summary; `includeHidden=true` adds the hidden ones. Rides the illness module.",
      requestParams: {
        query: z.object({
          includeHidden: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "The definitions.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                symptomDefinitionList,
                "ListSymptomDefinitionsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Symptoms"],
      summary: "Define a symptom (v1.40)",
      description:
        "Creates one definition. Idempotent under `Idempotency-Key`. Audits as `symptoms.definition.create` without the label. Rate-limited to 30 a minute.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createSymptomDefinitionRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(MODULE_OFF),
        "201": {
          description: "Definition created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                symptomDefinition,
                "CreateSymptomDefinitionEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/symptoms/definitions/{id}": {
    patch: {
      tags: ["Symptoms"],
      summary: "Edit, hide or show a symptom (v1.40)",
      description:
        "Partial edit. Audits as `symptoms.definition.update`, naming a label change without quoting it.",
      requestParams: pathId,
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateSymptomDefinitionRequest },
        },
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "Definition updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                symptomDefinition,
                "UpdateSymptomDefinitionEnvelope",
              ),
            },
          },
        },
        ...definitionNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Symptoms"],
      summary: "Hide or delete a symptom (v1.40)",
      description:
        "Hides the definition and keeps its history. `?purge=true` deletes it and every occurrence of it. A built-in definition (`code` set) is not deleted: its occurrences are tombstoned and it stays hidden, so a later Apple Health sync neither recreates it nor re-imports what was removed (a re-post answers `skipped`, reason `deleted_in_healthlog`).",
      requestParams: {
        ...pathId,
        query: z.object({ purge: z.enum(["true", "false"]).optional() }),
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "Hidden or deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deletedResponse,
                "DeleteSymptomDefinitionEnvelope",
              ),
            },
          },
        },
        ...definitionNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/symptoms/events": {
    get: {
      tags: ["Symptoms"],
      summary: "List symptom occurrences (v1.40)",
      description:
        "Occurrences of the record's symptoms, newest first, narrowed by the optional query.",
      requestParams: { query: listSymptomEventsQuery },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "A page of occurrences.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                symptomEventList,
                "ListSymptomEventsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Symptoms"],
      summary: "Log a symptom occurrence (v1.40)",
      description:
        "Creates one occurrence. Idempotent under `Idempotency-Key`. A hidden definition can still be logged against; another record's definition 404s (`symptoms.definition.notFound`). Audits as `symptoms.event.create` without the note.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createSymptomEventRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(MODULE_OFF),
        "201": {
          description: "Occurrence logged.",
          content: {
            "application/json": {
              schema: dataEnvelope(symptomEvent, "CreateSymptomEventEnvelope"),
            },
          },
        },
        ...definitionNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/symptoms/events/batch": {
    post: {
      tags: ["Symptoms"],
      summary: "Import Apple Health symptom samples (v1.48.2)",
      description:
        "Each entry lands on the caller's built-in definition for its code, created on first use and labelled in the caller's language. Owner-only, like every Apple Health ingest route: a session switched into another record is refused 403 `sharing.not_permitted`. A sample already stored, deleted ones included, answers `duplicate`, so a late re-post of a sample the app reported gone never brings it back. No note and no episode link from this route. Idempotent under `Idempotency-Key`. Cookie session or a wildcard Bearer token; a narrow-scope token is refused 403. Metered by the shared per-account write bucket. Audits as `symptoms.batch.ingest`. Served when `GET /api/auth/me` reports `features.appleHealthSymptoms: true`.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: symptomBatchRequest } },
      },
      responses: {
        ...idempotentWrite(),
        "403": {
          description: `${MODULE_OFF}\n\n${SHARING_NOT_PERMITTED_DESCRIPTION}`,
          content: { "application/json": { schema: errorEnvelope } },
        },
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                symptomBatchResponse,
                "SymptomBatchEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...recordWriteRateLimitResponse,
        "422": {
          description:
            "More than 500 entries (`symptoms.batch.too_large`) or a malformed body (`symptoms.batch.invalid`, every issue under `details.issues`, an entry's issues under `entries.<n>`). Nothing was written; both are permanent for the batch as sent.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/symptoms/events/{id}": {
    get: {
      tags: ["Symptoms"],
      summary: "Read one symptom occurrence",
      description:
        "The occurrence as the list reads it, for a client that opens one entry by id (the web's save receipt opens its edit sheet from it).",
      requestParams: pathId,
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "The occurrence.",
          content: {
            "application/json": {
              schema: dataEnvelope(symptomEvent, "GetSymptomEventEnvelope"),
            },
          },
        },
        ...eventNotFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Symptoms"],
      summary: "Edit a symptom occurrence (v1.40)",
      description:
        "Partial edit. An occurrence imported from Apple Health is edited like any other and keeps its source and externalId; a re-post of its sample never overwrites the edit. An `occurredAt` moved past the stored `endAt` clears `endAt`. Audits as `symptoms.event.update`, naming a note change without quoting it.",
      requestParams: pathId,
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateSymptomEventRequest },
        },
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "Occurrence updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(symptomEvent, "UpdateSymptomEventEnvelope"),
            },
          },
        },
        ...eventNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Symptoms"],
      summary: "Delete a symptom occurrence (v1.40)",
      description:
        'Removes the occurrence. One imported from Apple Health is tombstoned instead, so a re-post of its sample answers `skipped` with `reason: "deleted_in_healthlog"`. Audits as `symptoms.event.delete`.',
      requestParams: pathId,
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "Deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.literal(true) }),
                "DeleteSymptomEventEnvelope",
              ),
            },
          },
        },
        ...eventNotFound,
        ...stdResponses,
      },
    },
  },
};
