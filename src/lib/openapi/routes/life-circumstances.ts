/**
 * OpenAPI route table — life circumstances and AUDIT-C (v1.43, #614).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request bodies
 * reuse the runtime schemas from `@/lib/validations/life-circumstances`. Every
 * route here is new: the new fact kinds never appear on
 * `GET /api/anamnesis/facts`, and AUDIT-C never on
 * `/api/mental-health/assessments`, because older app builds decode both
 * lists closed. Only when `features.lifeCircumstances` is true.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  AUDIT_C_CUTOFF_SOURCES,
  LIFE_AI_SECTIONS,
  LIFE_SECTION_KEYS,
  lifeFactRevisionSchema,
  auditCRequestSchema,
  lifeAiSectionsPatchSchema,
  lifeConfirmSchema,
} from "@/lib/validations/life-circumstances";

import {
  dataEnvelope,
  deletedInHealthLogResponse,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  stdResponses,
} from "./shared";
import { isoDateTime } from "@/lib/validations/datetime";

const lifeFactRevision = lifeFactRevisionSchema.meta({
  id: "LifeFactRevision",
  description: "The current revision of one life-circumstance fact.",
});

const auditCCutoff = z.object({
  value: z.number().int(),
  sex: z.enum(["male", "female"]),
  source: z.enum(AUDIT_C_CUTOFF_SOURCES),
  sourceLabel: z.string(),
  sourceUrl: z.string(),
});

const auditCResult = z
  .object({
    id: z.string(),
    takenAt: isoDateTime(),
    items: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
    totalScore: z.number().int().min(0).max(12),
    locale: z.string(),
    cutoff: auditCCutoff
      .nullable()
      .describe(
        "The screening cut-off for the entry's language and the profile's sex (German S3 guideline, Korean KNHANES, else Bradley 2007). `null` when the profile has no sex; show the sum only.",
      ),
    aboveCutoff: z.boolean().nullable(),
    validatedLocale: z
      .boolean()
      .describe(
        "Whether the item wording shown was a validated translation for `locale`.",
      ),
  })
  .meta({
    id: "AuditCResult",
    description:
      "One AUDIT-C entry, scored on the server. A screening result, not a diagnosis.",
  });

const screeningHint = z.object({
  id: z.enum(["lung_ldct", "aaa_ultrasound"]),
  status: z.enum(["suggested", "not_eligible", "unknown"]),
  reasonKeys: z.array(z.string()),
  region: z.enum(["DE", "US"]),
  sourceLabel: z.string(),
  sourceUrl: z.string(),
});

const lifeCircumstances = z
  .object({
    sections: z
      .array(
        z.object({
          key: z.enum(LIFE_SECTION_KEYS),
          aiSection: z.enum([
            "SMOKING_STATUS",
            "ALCOHOL_PATTERN",
            "ACTIVITY",
            "WORK",
            "HABITS",
            "GOALS",
          ]),
          aiIncluded: z.boolean(),
          lastConfirmedAt: isoDateTime().nullable(),
          reviewDue: z
            .boolean()
            .describe("Older than 365 days; show the quiet yearly check."),
          facts: z.array(lifeFactRevision),
        }),
      )
      .describe("Always all six, in this order."),
    extraAiSections: z.object({ SHIFT_SCHEDULE: z.boolean() }),
    derived: z.object({
      packYears: z.object({
        value: z.number().nullable(),
        status: z.enum(["computed", "not_applicable", "missing_inputs"]),
      }),
      activityMinutesPerWeek: z.object({
        value: z.number().int().nullable(),
        meetsWho150: z.boolean().nullable(),
        measuredStepsAvailable: z.boolean(),
      }),
      freeWeekdays: z.object({
        days: z.array(z.number().int().min(1).max(7)),
        source: z.enum(["fact", "default_weekend"]),
      }),
      screeningHints: z.array(screeningHint),
    }),
    auditC: z.object({
      latest: auditCResult
        .nullable()
        .describe(
          "The newest entry whose answers this host can open; an entry it cannot open is listed in `history` only.",
        ),
      history: z
        .array(
          z.object({
            id: z.string(),
            takenAt: isoDateTime(),
            totalScore: z.number().int(),
          }),
        )
        .describe("Newest first, at most 20."),
      offerDue: z
        .boolean()
        .describe(
          "No readable entry, or the newest one whose answers open (the one in `latest`) is 365 days old or older.",
        ),
      instrument: z.object({
        items: z
          .array(
            z.object({
              stem: z.string(),
              options: z.array(
                z.object({ value: z.number().int(), label: z.string() }),
              ),
            }),
          )
          .describe(
            "The three items verbatim in the account language; render as delivered.",
          ),
        locale: z.string(),
        validatedLocale: z.boolean(),
        standardDrink: z.string(),
        attribution: z.string(),
      }),
    }),
    takeOver: z.array(
      z.object({
        field: z.enum(["conditions", "allergies"]),
        freeTextPresent: z.boolean(),
        structuredCount: z.number().int(),
        available: z.boolean(),
      }),
    ),
  })
  .meta({
    id: "LifeCircumstances",
    description:
      "The six life-circumstance sections with their answers, AI switches and review state, the derived values with their sources, AUDIT-C, and the take-over hints for the free-text conditions and allergies. Every number is resolved on the server.",
  });

const lifeAiSectionsPatchRequest = lifeAiSectionsPatchSchema.meta({
  id: "LifeAiSectionsPatchRequest",
});
const lifeConfirmRequest = lifeConfirmSchema.meta({
  id: "LifeConfirmRequest",
});
const auditCRequest = auditCRequestSchema.meta({ id: "AuditCRequest" });

export const lifeCircumstancesPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/anamnesis/life-circumstances": {
    get: {
      tags: ["Anamnesis"],
      summary: "Life circumstances (v1.43)",
      description:
        "The life-circumstance sections of the record. Delegates read it under the `profile` grant, like the facts.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The life circumstances.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                lifeCircumstances,
                "LifeCircumstancesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/anamnesis/life-circumstances/ai-sections": {
    patch: {
      tags: ["Anamnesis"],
      summary: "Switch life-circumstance sections for the AI (v1.43)",
      description:
        "Sections not named keep their state. Own account only. 422 `anamnesis.lifeSections.invalid`; 409 `about_me_conflict` for a stale `baseUpdatedAt`.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: lifeAiSectionsPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The switches after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  aiSections: z.partialRecord(
                    z.enum(LIFE_AI_SECTIONS),
                    z.boolean(),
                  ),
                  updatedAt: isoDateTime(),
                }),
                "LifeAiSectionsEnvelope",
              ),
            },
          },
        },
        "409": {
          description: "`about_me_conflict`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/anamnesis/life-circumstances/confirm": {
    post: {
      tags: ["Anamnesis"],
      summary: "Confirm a life-circumstance section is still true (v1.43)",
      description:
        "Stores the confirmation instant only, never a new revision. Own account only. 422 `anamnesis.lifeConfirm.invalid`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: lifeConfirmRequest } },
      },
      responses: {
        "200": {
          description: "The confirmed section.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  section: z.enum(LIFE_SECTION_KEYS),
                  lastConfirmedAt: isoDateTime(),
                }),
                "LifeConfirmEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/anamnesis/audit-c": {
    post: {
      tags: ["Anamnesis"],
      summary: "Record an AUDIT-C (v1.43)",
      description:
        "Scores the three items on the server. The entry is stored in the language of the wording the read route offers this account (`auditC.instrument.locale`), and the cut-off follows that wording; `locale`, when sent, must name that same wording. A replay with the same `externalId` answers 200 with the stored result, or 410 (`anamnesis.auditC.deleted_in_healthlog`) when that entry was deleted since. 422 `anamnesis.auditC.invalid` (also for another wording than the one offered, and for a `takenAt` more than five minutes ahead of the server clock); 429 `anamnesis.auditC.rateLimited` after 30 in an hour.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: { "application/json": { schema: auditCRequest } },
      },
      responses: {
        ...recordRefusal(),
        ...idempotentWrite(),
        "200": {
          description: "A replay of an entry already stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ result: auditCResult }),
                "AuditCReplayEnvelope",
              ),
            },
          },
        },
        "201": {
          description: "The stored and scored entry.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ result: auditCResult }),
                "AuditCCreatedEnvelope",
              ),
            },
          },
        },
        ...deletedInHealthLogResponse("anamnesis.auditC.deleted_in_healthlog"),
        ...stdResponses,
      },
    },
  },
  "/api/anamnesis/audit-c/{id}": {
    delete: {
      tags: ["Anamnesis"],
      summary: "Remove an AUDIT-C entry (v1.43)",
      description: "Soft delete. 404 `anamnesis.auditC.notFound`.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The removed entry.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  removedAt: isoDateTime(),
                }),
                "AuditCRemovedEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "`anamnesis.auditC.notFound`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
