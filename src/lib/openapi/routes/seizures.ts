/**
 * OpenAPI route table for the seizure diary (`/api/seizures`, #1368).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request bodies
 * and queries reuse the runtime Zod schemas from `@/lib/seizures/shared`, so
 * the wire contract stays single-source; response shapes mirror the DTOs the
 * routes serialise.
 *
 * Every route rides the `seizures` module (off by default): a record without
 * it answers 403 `seizures.disabled`, even to a valid Bearer token.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { SEIZURE_ILAE_TYPES } from "@/lib/seizures/ilae";
import {
  SEIZURE_CERTAINTIES,
  SEIZURE_DURATION_SOURCES,
  SEIZURE_EMERGENCIES,
  SEIZURE_EVENT_SOURCES,
  SEIZURE_FUNCTION_STATES,
  SEIZURE_INJURIES,
  SEIZURE_OBSERVATIONS,
  SEIZURE_OBSERVER_ROLES,
  SEIZURE_ONSET_PRECISIONS,
  SEIZURE_POSTICTAL,
  SEIZURE_RESCUE_EFFECTS,
  SEIZURE_RESCUE_ROUTES,
  SEIZURE_SEMIOLOGY,
  SEIZURE_SLEEP_STATES,
  SEIZURE_TRIGGERS,
  seizureDiaryQuerySchema,
  seizureEventCreateSchema,
  seizureEventUpdateSchema,
  seizureRescueDoseCreateSchema,
  seizureRescueDoseUpdateSchema,
  seizureSettingsUpdateSchema,
  seizureTypeCreateSchema,
  seizureTypeUpdateSchema,
} from "@/lib/seizures/shared";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  stdResponses,
} from "./shared";

const MODULE_OFF =
  "`seizures.disabled`: the record has the seizure diary switched off (it is off until turned on), or the operator turned it off server-wide.";

const ilaeType = z.enum(SEIZURE_ILAE_TYPES);

const createTypeRequest = seizureTypeCreateSchema.meta({
  id: "CreateSeizureTypeRequest",
  description:
    "Set up one of the person's seizure types. `label` is the family's own name (1-40 characters, encrypted at rest). `ilaeType` is the ILAE 2025 seizure type; the `*_UNDETERMINED` values record the parent class when the next level is not known. `usualDurationSec` drives the NICE prolonged flag. `rescuePlan` is the plan text agreed with the care team (encrypted). `rescueMedicationId` must name one of the record's as-needed medications (404 `seizures.rescue.medicationNotFound`, 422 `seizures.rescue.notAsNeeded`). At most twelve active types (422 `seizures.type.limit`).",
});

const updateTypeRequest = seizureTypeUpdateSchema.meta({
  id: "UpdateSeizureTypeRequest",
  description:
    "Partial edit; an omitted key is left alone, `null` clears it. `archived: true` takes the type out of the quick log and keeps every seizure that names it.",
});

const createEventRequest = seizureEventCreateSchema.meta({
  id: "CreateSeizureEventRequest",
  description:
    "Record one seizure, or a tally of brief ones (`count` > 1). `onsetAt` may not lie in the future beyond five minutes. `durationSec` stays null when nobody timed it; `durationSource` defaults to ESTIMATED when a duration is given and UNKNOWN when not. `typeProfileId` must name one of the record's own types (404 `seizures.type.notFound`). `rescueDoses` are written with the seizure; each one naming a medication also records an intake on it. Free text is encrypted at rest. The account that sent the request is kept as the one who logged it.",
});

const updateEventRequest = seizureEventUpdateSchema.meta({
  id: "UpdateSeizureEventRequest",
  description:
    "Partial edit (the details added later). An omitted key is left alone; `null`, or an empty string for text, clears it.",
});

const createRescueRequest = seizureRescueDoseCreateSchema.meta({
  id: "CreateSeizureRescueDoseRequest",
  description:
    "A rescue dose. `medicationId` names one of the record's as-needed medications and also writes an intake on it; without it, `medicationName` is required (a dose given by paramedics).",
});

const updateRescueRequest = seizureRescueDoseUpdateSchema.meta({
  id: "UpdateSeizureRescueDoseRequest",
  description:
    "Whether the dose worked, when the seizure ended, who gave it and how.",
});

const settingsRequest = seizureSettingsUpdateSchema.meta({
  id: "UpdateSeizureSettingsRequest",
  description:
    "The record's cluster rule: `clusterCount` (2-20) seizures within `clusterWindowHours` (1-168).",
});

const diaryQuery = seizureDiaryQuerySchema.meta({
  id: "SeizureDiaryQuery",
  description:
    "Optional `from` / `to` (ISO instants). Defaults to the last 90 days; at most three years.",
});

const clusterRule = z
  .object({ count: z.number().int(), windowHours: z.number().int() })
  .meta({ id: "SeizureClusterRule" });

const alertThreshold = z
  .object({
    seconds: z.number().int(),
    source: z.enum(["t1", "usualPlusTwo", "generic"]),
  })
  .meta({
    id: "SeizureAlertThreshold",
    description:
      "When the quick-log timer shows the plan: `t1` (Trinka 2015: tonic-clonic 5 min, focal impaired or absence 10 min), `usualPlusTwo` (NICE NG217: usual duration plus 2 minutes, convulsive types, when earlier than t1), or `generic` (5 minutes, CDC first aid).",
  });

const seizureType = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    ilaeType,
    usualDurationSec: z.number().int().nullable(),
    rescuePlan: z.string().nullable(),
    rescueMedicationId: z.string().nullable(),
    rescueMedicationName: z.string().nullable(),
    rescueDoseAmount: z.number().nullable(),
    rescueDoseUnit: z.string().nullable(),
    rescueRoute: z.enum(SEIZURE_RESCUE_ROUTES).nullable(),
    sortOrder: z.number().int(),
    archived: z.boolean(),
    alert: alertThreshold,
  })
  .meta({
    id: "SeizureType",
    description:
      "One of the person's seizure types. `label` and `rescuePlan` are decrypted (null on an unreadable value).",
  });

const rescueDose = z
  .object({
    id: z.string(),
    eventId: z.string(),
    medicationId: z.string().nullable(),
    medicationName: z.string(),
    doseAmount: z.number().nullable(),
    doseUnit: z.string().nullable(),
    route: z.enum(SEIZURE_RESCUE_ROUTES).nullable(),
    givenAt: z.string(),
    givenBy: z.enum(SEIZURE_OBSERVER_ROLES).nullable(),
    effect: z.enum(SEIZURE_RESCUE_EFFECTS),
    seizureEndedAt: z.string().nullable(),
    intakeEventId: z.string().nullable(),
  })
  .meta({
    id: "SeizureRescueDose",
    description:
      "A rescue dose. `intakeEventId` is the intake written on the medication for it.",
  });

const seizureEvent = z
  .object({
    id: z.string(),
    typeProfileId: z.string().nullable(),
    ilaeType: ilaeType.nullable(),
    effectiveIlaeType: ilaeType.nullable(),
    onsetAt: z.string(),
    onsetPrecision: z.enum(SEIZURE_ONSET_PRECISIONS),
    durationSec: z.number().int().nullable(),
    durationSource: z.enum(SEIZURE_DURATION_SOURCES),
    count: z.number().int(),
    certainty: z.enum(SEIZURE_CERTAINTIES),
    sleepState: z.enum(SEIZURE_SLEEP_STATES),
    observableManifestations: z.enum(SEIZURE_OBSERVATIONS).nullable(),
    responsiveness: z.enum(SEIZURE_FUNCTION_STATES).nullable(),
    recall: z.enum(SEIZURE_FUNCTION_STATES).nullable(),
    semiology: z.array(z.enum(SEIZURE_SEMIOLOGY)),
    semiologyNote: z.string().nullable(),
    aura: z.string().nullable(),
    triggers: z.array(z.enum(SEIZURE_TRIGGERS)),
    postictalMinutes: z.number().int().nullable(),
    postictal: z.array(z.enum(SEIZURE_POSTICTAL)),
    injuries: z.array(z.enum(SEIZURE_INJURIES)),
    incontinence: z.boolean().nullable(),
    emergency: z.enum(SEIZURE_EMERGENCIES),
    witnessed: z.boolean().nullable(),
    witnessRole: z.enum(SEIZURE_OBSERVER_ROLES).nullable(),
    witnessNote: z.string().nullable(),
    loggedBy: z.enum(["owner", "delegate", "unknown"]),
    loggedByViewer: z.boolean(),
    loggedByName: z.string().nullable(),
    source: z.enum(SEIZURE_EVENT_SOURCES),
    note: z.string().nullable(),
    rescueDoses: z.array(rescueDose),
    flags: z.object({
      overT1: z.boolean().nullable(),
      prolonged: z.boolean().nullable(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "SeizureEvent",
    description:
      "One recorded seizure (or tally). `effectiveIlaeType` is the event's override, else its type's. `flags.overT1` compares the duration with Trinka's t1 for the type, `flags.prolonged` with the type's usual duration plus 2 minutes (NICE); null where either input is missing. `loggedBy` says whether the person or someone acting on the record logged it.",
  });

const settings = z.object({ rule: clusterRule, niceRule: clusterRule }).meta({
  id: "SeizureSettings",
  description:
    "The record's cluster rule (2 in 24 hours until one is saved) and NICE NG217's 3 in 24 hours, shown beside it.",
});

const monthlyRow = z.object({
  typeProfileId: z.string().nullable(),
  counts: z.record(z.string(), z.number().int()),
  days: z.record(z.string(), z.number().int()),
  total: z.number().int(),
});

const summary = z
  .object({
    from: z.string(),
    to: z.string(),
    days: z.number().int(),
    seizures: z.number().int(),
    suspected: z.number().int(),
    seizureDays: z.number().int(),
    seizureFreeDays: z.number().int(),
    per28Days: z.number(),
    convulsive: z.number().int(),
    fromSleep: z.number().int(),
    rescueDoses: z.number().int(),
    emergencies: z.object({
      emsCalled: z.number().int(),
      edVisits: z.number().int(),
      admissions: z.number().int(),
    }),
    streak: z.object({
      daysSinceLast: z.number().int().nullable(),
      lastAt: z.string().nullable(),
      longestFreeDays: z.number().int(),
    }),
    clusters: z.array(
      z.object({
        startAt: z.string(),
        endAt: z.string(),
        seizureCount: z.number().int(),
        eventIds: z.array(z.string()),
      }),
    ),
    niceClusterCount: z.number().int(),
    monthly: z.object({
      months: z.array(z.string()),
      rows: z.array(monthlyRow),
      total: monthlyRow,
    }),
  })
  .meta({
    id: "SeizureDiarySummary",
    description:
      "Derived server-side from the period's recorded seizures. Counts are confirmed seizures, each row weighted by its `count`; `suspected` is listed apart. `clusters` are episodes under the record's rule (overlapping qualifying windows merged), `niceClusterCount` the episodes under 3 in 24 hours. A diary records what was observed and can under-count.",
  });

const diary = z
  .object({
    types: z.array(seizureType),
    settings,
    events: z.array(seizureEvent),
    summary,
    truncated: z.boolean(),
  })
  .meta({ id: "SeizureDiary" });

const pathId = { path: z.object({ id: z.string() }) };
const pathDose = { path: z.object({ id: z.string(), doseId: z.string() }) };

const notFound = (code: string, what: string) => ({
  "404": {
    description: `\`${code}\`: no ${what} with this id on the record.`,
    content: { "application/json": { schema: errorEnvelope } },
  },
});

const deleted = (id: string) =>
  dataEnvelope(z.object({ deleted: z.literal(true) }), id);

const ok = (description: string, schema: z.ZodType, id: string) => ({
  description,
  content: { "application/json": { schema: dataEnvelope(schema, id) } },
});

export const seizurePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/seizures": {
    get: {
      tags: ["Seizures"],
      summary: "Read the seizure diary (v1.48)",
      description:
        "Types, the cluster rule, the period's seizures with their rescue doses, and the derived summary in one read.",
      requestParams: { query: diaryQuery },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": ok("The diary.", diary, "SeizureDiaryEnvelope"),
        ...stdResponses,
      },
    },
  },
  "/api/seizures/events": {
    post: {
      tags: ["Seizures"],
      summary: "Record a seizure (v1.48)",
      description:
        "Creates one seizure and the rescue doses given during it. Idempotent under `Idempotency-Key`. Audits as `seizures.event.create` without free text.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createEventRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(MODULE_OFF),
        "201": ok(
          "Seizure recorded.",
          seizureEvent,
          "CreateSeizureEventEnvelope",
        ),
        ...notFound("seizures.type.notFound", "seizure type"),
        ...stdResponses,
      },
    },
  },
  "/api/seizures/events/{id}": {
    patch: {
      tags: ["Seizures"],
      summary: "Add or correct a seizure's details (v1.48)",
      description:
        "Partial edit. Audits as `seizures.event.update`, naming free-text changes without quoting them.",
      requestParams: pathId,
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateEventRequest } },
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": ok(
          "Seizure updated.",
          seizureEvent,
          "UpdateSeizureEventEnvelope",
        ),
        ...notFound("seizures.event.notFound", "seizure"),
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Seizures"],
      summary: "Delete a seizure (v1.48)",
      description:
        "Removes the seizure and its rescue doses, and undoes the intakes those doses wrote on the medication. Audits as `seizures.event.delete`.",
      requestParams: pathId,
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "Deleted.",
          content: {
            "application/json": {
              schema: deleted("DeleteSeizureEventEnvelope"),
            },
          },
        },
        ...notFound("seizures.event.notFound", "seizure"),
        ...stdResponses,
      },
    },
  },
  "/api/seizures/events/{id}/rescue": {
    post: {
      tags: ["Seizures"],
      summary: "Add a rescue dose to a seizure (v1.48)",
      description:
        "Records the dose and, when it names a medication, an intake on that as-needed medication. Idempotent under `Idempotency-Key`.",
      parameters: [idempotencyKeyParameter],
      requestParams: pathId,
      requestBody: {
        required: true,
        content: { "application/json": { schema: createRescueRequest } },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(MODULE_OFF),
        "201": ok(
          "Dose recorded.",
          rescueDose,
          "CreateSeizureRescueDoseEnvelope",
        ),
        ...notFound("seizures.event.notFound", "seizure"),
        ...stdResponses,
      },
    },
  },
  "/api/seizures/events/{id}/rescue/{doseId}": {
    patch: {
      tags: ["Seizures"],
      summary: "Record how a rescue dose worked (v1.48)",
      requestParams: pathDose,
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateRescueRequest } },
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": ok(
          "Dose updated.",
          rescueDose,
          "UpdateSeizureRescueDoseEnvelope",
        ),
        ...notFound("seizures.rescue.notFound", "rescue dose"),
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Seizures"],
      summary: "Delete a rescue dose (v1.48)",
      description:
        "Removes the dose and undoes the intake it wrote on the medication.",
      requestParams: pathDose,
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "Deleted.",
          content: {
            "application/json": {
              schema: deleted("DeleteSeizureRescueDoseEnvelope"),
            },
          },
        },
        ...notFound("seizures.rescue.notFound", "rescue dose"),
        ...stdResponses,
      },
    },
  },
  "/api/seizures/types": {
    get: {
      tags: ["Seizures"],
      summary: "List the person's seizure types (v1.48)",
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": ok(
          "The types, active first.",
          z.object({ types: z.array(seizureType) }),
          "ListSeizureTypesEnvelope",
        ),
        ...stdResponses,
      },
    },
    post: {
      tags: ["Seizures"],
      summary: "Set up a seizure type (v1.48)",
      description:
        "Audits as `seizures.type.create` without the label or the plan.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createTypeRequest } },
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "201": ok("Type created.", seizureType, "CreateSeizureTypeEnvelope"),
        ...stdResponses,
      },
    },
  },
  "/api/seizures/types/{id}": {
    patch: {
      tags: ["Seizures"],
      summary: "Edit, reorder or archive a seizure type (v1.48)",
      requestParams: pathId,
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateTypeRequest } },
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": ok("Type updated.", seizureType, "UpdateSeizureTypeEnvelope"),
        ...notFound("seizures.type.notFound", "seizure type"),
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Seizures"],
      summary: "Delete an unused seizure type (v1.48)",
      description:
        "A type that any seizure names answers 409 `seizures.type.inUse`; archive it instead.",
      requestParams: pathId,
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": {
          description: "Deleted.",
          content: {
            "application/json": {
              schema: deleted("DeleteSeizureTypeEnvelope"),
            },
          },
        },
        "409": {
          description: "`seizures.type.inUse`: seizures name this type.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...notFound("seizures.type.notFound", "seizure type"),
        ...stdResponses,
      },
    },
  },
  "/api/seizures/settings": {
    get: {
      tags: ["Seizures"],
      summary: "Read the cluster rule (v1.48)",
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": ok("The rule.", settings, "SeizureSettingsEnvelope"),
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Seizures"],
      summary: "Set the cluster rule (v1.48)",
      description:
        "Clusters are derived at read time, so the new rule applies to every past seizure too.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: settingsRequest } },
      },
      responses: {
        ...recordRefusal(MODULE_OFF),
        "200": ok("The rule.", settings, "UpdateSeizureSettingsEnvelope"),
        ...stdResponses,
      },
    },
  },
};
