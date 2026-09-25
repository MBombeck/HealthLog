/**
 * OpenAPI route table for the illness / condition journal (`/api/illness`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies + queries reuse the runtime Zod schemas from `@/lib/validations/illness`
 * so the wire contract stays single-source. Response shapes are declared here
 * to mirror the server-authoritative DTOs in `@/lib/illness/dto.ts` (the routes
 * serialise a decrypted `note` + flattened `symptoms` the input schemas don't
 * carry; iOS renders the DTO, it never recomputes it).
 *
 * The journal is a CONDITION journal, retrospective-only — never a
 * predictor/diagnoser. Every route is module-gated: an account that turned
 * the module off (or an operator-disabled instance) 403s with
 * `errorCode:"illness.disabled"` even with a valid Bearer token.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  illnessEpisodeCreateSchema,
  illnessEpisodeUpdateSchema,
  illnessEpisodeResolveSchema,
  illnessEpisodeListQuerySchema,
  illnessDayLogInputSchema,
  illnessInsightsQuerySchema,
  illnessTypeEnum,
  illnessLifecycleEnum,
} from "@/lib/validations/illness";
import { lateralityEnum } from "@/lib/validations/encounters";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  stdResponses,
} from "./shared";

// Zod 4's `.meta()` returns a NEW instance carrying the id rather than
// annotating in place, so each annotated schema is bound to a const and the
// route table below references that const — a bare call would register nothing.
const createIllnessEpisodeRequest = illnessEpisodeCreateSchema.meta({
  id: "CreateIllnessEpisodeRequest",
  description:
    "Open an illness/condition episode. `label` is the user-facing name; `type` + `lifecycle` classify it. `onsetAt` defaults to 'now' server-side when omitted. `parentConditionId` threads a FLARE/RECURRING bout under a parent condition (must be an owned, live episode). The optional `note` is encrypted at rest. `bodySite` (free text, encrypted at rest) and `laterality` (LEFT / RIGHT / BOTH, null when not stated) say where on the body the condition sits; both are optional on every type.",
});

const updateIllnessEpisodeRequest = illnessEpisodeUpdateSchema.meta({
  id: "UpdateIllnessEpisodeRequest",
  description:
    "Partial edit of an episode; an omitted key leaves the column untouched. A `null` `resolvedAt` re-opens a resolved episode; a `null` `parentConditionId` detaches it from its parent. `bodySite` and `laterality` follow the same rule: an omitted key keeps the stored value, `null` (or a blank site) clears it, so a client that does not know the fields never erases them. Rejects unknown keys.",
});

const resolveIllnessEpisodeRequest = illnessEpisodeResolveSchema.meta({
  id: "ResolveIllnessEpisodeRequest",
  description:
    "Mark an episode recovered. `resolvedAt` defaults to 'now' when omitted, so the one-tap 'mark recovered' affordance can send an empty body. A CHRONIC_ONGOING episode has no recovery date by design and 422s.",
});

const listIllnessEpisodesQuery = illnessEpisodeListQuerySchema.meta({
  id: "ListIllnessEpisodesQuery",
  description:
    "Query params for the episode history: optional `limit` (1–100, default 50) and `includeResolved` ('true' | 'false'); 'false' hides episodes that already carry a `resolvedAt`. Newest-first by `onsetAt`.",
});

const upsertIllnessDayLogRequest = illnessDayLogInputSchema.meta({
  id: "UpsertIllnessDayLogRequest",
  description:
    "Upsert one day's symptom / functional-impact / fever row for an episode (keyed on `(episodeId, date)`). `date` is a `YYYY-MM-DD` tz-anchored day. `functionalImpact` (0–3) + `feverC` are queryable plaintext; `symptoms` carry an optional 0–3 Jackson/WURSS severity per link; the optional `note` is encrypted at rest.",
});

/**
 * The documented query for `GET .../day-logs`: a `date` (single-day read) OR
 * the list pagination params (date-less list). Both are optional on the wire;
 * the route picks the mode by whether `date` is present.
 */
const illnessDayLogGetQuery = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
  })
  .meta({ id: "GetIllnessDayLogsQuery" });

const illnessInsightsQuery = illnessInsightsQuerySchema.meta({
  id: "IllnessInsightsQuery",
  description:
    "Cross-episode retrospective window query: optional `windowDays` (30–1095, default 365) and optional `includeRecoveryGap` (default false). With `includeRecoveryGap` off the response carries the count breakdown and a null typical recovery gap on a single fast query; set it true to pay for the per-episode correlation that computes the recovery gap. Retrospective only — the engine summarises past episodes, never forecasts.",
});

const illnessSymptom = z
  .object({
    key: z.string(),
    severity: z.number().int().nullable(),
  })
  .meta({
    id: "IllnessSymptom",
    description:
      "A symptom link on a day-log: the catalog `key` plus an optional 1–3 graded severity (`null` = a plain presence link; the link's presence already means 'present', so 0 is not a distinct state).",
  });

const illnessEpisode = z
  .object({
    id: z.string(),
    label: z.string(),
    type: illnessTypeEnum,
    lifecycle: illnessLifecycleEnum,
    onsetAt: z.string(),
    resolvedAt: z.string().nullable(),
    parentConditionId: z.string().nullable(),
    note: z.string().nullable(),
    bodySite: z.string().nullable(),
    laterality: lateralityEnum.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "IllnessEpisode",
    description:
      "A stored illness/condition episode. `note` is the decrypted free-text (or null on a key-rotation gap — fail-soft, never 500). `resolvedAt` is null while the episode is open. `parentConditionId` links a FLARE/RECURRING bout to its parent condition. `bodySite` is the decrypted body site (null when not stated or on a key-rotation gap) and `laterality` its side.",
  });

const illnessDayLog = z
  .object({
    id: z.string(),
    episodeId: z.string(),
    date: z.string(),
    functionalImpact: z.number().int().nullable(),
    feverC: z.number().nullable(),
    symptoms: z.array(illnessSymptom),
    note: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({
    id: "IllnessDayLog",
    description:
      "A stored day-log for an episode. `date` is the `YYYY-MM-DD` it covers. `functionalImpact` (0–3) and `feverC` are plaintext; `symptoms` flattens the link rows; `note` is the decrypted free-text (or null).",
  });

const illnessDayLogList = z
  .object({
    dayLogs: z.array(illnessDayLog),
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    }),
  })
  .meta({
    id: "IllnessDayLogList",
    description:
      "The date-less day-log LIST (v1.18.3): the episode's day-logs newest-first (or oldest-first under `sortDir:'asc'`), with `meta.total` for paging the full history. Powers the detail timeline scroll + iOS healthlog-iOS#30.",
  });

/* ── P3 retrospective correlation + cross-episode insights DTOs ───────── */

const illnessVitalDeviation = z
  .object({
    type: z.string(),
    day: z.string(),
    value: z.number(),
    baselineCenter: z.number(),
    deviationSd: z.number(),
    direction: z.enum(["above", "below"]),
    adverse: z.boolean(),
  })
  .meta({
    id: "IllnessVitalDeviation",
    description:
      "One vital's deviation finding on a day: signed deviation in robust-SD units from the user's OWN baseline (median ± MAD), the direction, and whether the move is illness-adverse for that metric.",
  });

const illnessVitalReturn = z
  .object({
    type: z.string(),
    returnedDay: z.string().nullable(),
    gapDays: z.number().nullable(),
    adverse: z.boolean(),
  })
  .meta({
    id: "IllnessVitalReturn",
    description:
      "A physiological / symptom return: the first day the metric re-entered its band AND held, the signed gap (days) from the felt-better marker (positive = the body lagged the feeling), and whether the move was illness-adverse (only adverse returns name the driver). `type` is a MeasurementType or `FUNCTIONAL_IMPACT` for the user-logged symptom-burden track (functionalImpact, baseline = constant 0).",
  });

const illnessRedFlag = z
  .object({
    type: z.string(),
    reason: z.enum(["sustained_low_spo2", "sustained_fever"]),
    worstValue: z.number(),
    days: z.number().int(),
  })
  .meta({
    id: "IllnessRedFlag",
    description:
      "A retrospective red-flag escalation (sustained low SpO2 or sustained fever) against absolute clinical floors. Copy must escalate ('seek care if this recurs'), never reassure.",
  });

const illnessSleepContext = z
  .object({
    baselineMeanMinutes: z.number(),
    episodeMeanMinutes: z.number(),
    deltaMinutes: z.number(),
    nightsCounted: z.number().int(),
  })
  .meta({
    id: "IllnessSleepContext",
    description:
      "A neutral sleep-as-context observation: the user's median asleep minutes over the well baseline vs the mean over the episode window, and their signed delta (positive = slept more than usual). A pure OBSERVATION surfaced alongside the gap — NEVER a recovery return and NEVER part of the headline recovery-gap. Withheld (the field is null) on thin sleep data or a sub-floor delta.",
  });

const illnessCorrelationValue = z
  .object({
    episodeId: z.string(),
    preOnset: z.array(illnessVitalDeviation),
    nadir: z.array(illnessVitalDeviation),
    returns: z.array(illnessVitalReturn),
    recoveryGapDays: z.number().nullable(),
    adverseCoverageDays: z.number().int(),
    feltBetterDay: z.string().nullable(),
    gapDriverType: z.string().nullable(),
    redFlags: z.array(illnessRedFlag),
    sleepContext: illnessSleepContext.nullable(),
  })
  .meta({
    id: "IllnessCorrelationValue",
    description:
      "The retrospective correlation findings for one episode: pre-onset anomaly scan, nadir, per-vital physiological returns (incl. the user-logged symptom-burden track, `type:FUNCTIONAL_IMPACT`), the headline recovery-gap (median of per-track gaps), the driving metric (`gapDriverType`), any red flags, and an optional sleep-as-context observation (`sleepContext`, never in the gap).",
  });

const illnessCorrelationResponse = z
  .object({
    episodeId: z.string(),
    status: z.enum(["ok", "insufficient"]),
    value: illnessCorrelationValue.nullable(),
    coverage: z.object({
      requiredInputs: z.number().int(),
      presentInputs: z.number().int(),
      historyDays: z.number().int(),
      missing: z.array(z.string()),
    }),
    confidence: z.object({ score: z.number(), band: z.string() }).nullable(),
    provenance: z.object({
      inputs: z.array(z.string()),
      source: z.string(),
      windowDays: z.number().int(),
      computedAt: z.string(),
    }),
    reason: z.string().nullable(),
  })
  .meta({
    id: "IllnessCorrelationResponse",
    description:
      "Coverage-gated `Derived<T>` wire shape for the per-episode correlation. `status:\"insufficient\"` carries coverage + a reason and a null `value` — the surface renders 'still learning', never a fabricated number. Server-authoritative; iOS pattern-matches `status`, never recomputes.",
  });

const illnessInsightsResponse = z
  .object({
    windowDays: z.number().int(),
    episodeCount: z.number().int(),
    resolvedCount: z.number().int(),
    typicalRecoveryGapDays: z.number().nullable(),
    gapSampleSize: z.number().int(),
    byMonth: z.record(z.string(), z.number().int()),
    byType: z.record(z.string(), z.number().int()),
    gapDriverType: z.string().nullable(),
  })
  .meta({
    id: "IllnessInsightsResponse",
    description:
      "Cross-episode retrospective summary over the trailing window: episode + resolved counts, the typical (median) recovery gap (null below the min-sample floor — withholds a thin claim), a recurrence-by-month tally, a per-type breakdown, and the dominant driving vital (`gapDriverType`, null when no gap is surfaced). Retrospective only.",
  });

const episodeNotFound = {
  "404": {
    description: "Illness episode not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

export const illnessPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/illness/episodes": {
    get: {
      tags: ["Illness"],
      summary: "List illness episodes (v1.18.1)",
      description:
        "Returns the caller's live (non-deleted) illness/condition episodes, newest-first by onset. `includeResolved=false` hides episodes that already carry a `resolvedAt`. Born-gated.",
      requestParams: { query: listIllnessEpisodesQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The caller's illness episodes.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(illnessEpisode),
                "ListIllnessEpisodesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Illness"],
      summary: "Open an illness episode (v1.18.1)",
      description:
        "Creates one episode for the caller. `onsetAt` defaults to 'now' when omitted; the optional note is AES-256-GCM encrypted before write. A `parentConditionId` must reference an owned, live episode. Audits as `illness.episode.create`. Born-gated.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createIllnessEpisodeRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Episode created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessEpisode,
                "CreateIllnessEpisodeEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/illness/episodes/{id}": {
    get: {
      tags: ["Illness"],
      summary: "Read a single illness episode (v1.18.1)",
      description:
        "Returns the episode including its decrypted `note`. Owner-scoped; a cross-user or tombstoned id 404s. Born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The episode.",
          content: {
            "application/json": {
              schema: dataEnvelope(illnessEpisode, "GetIllnessEpisodeEnvelope"),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Illness"],
      summary: "Edit an illness episode (v1.18.1)",
      description:
        "Partial edit; omitted fields are left untouched. A re-parent must point at an owned, live episode (and never the episode itself). Audits as `illness.episode.update`. Owner-scoped + module-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateIllnessEpisodeRequest },
        },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Episode updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessEpisode,
                "UpdateIllnessEpisodeEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Illness"],
      summary: "Soft-delete an illness episode (v1.18.1)",
      description:
        "Stamps `deletedAt` (tombstone). Idempotent — a re-delete is a no-op. Returns the `{ deleted: true }` envelope (the cross-module DELETE shape). Audits as `illness.episode.delete`. Owner-scoped + module-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Soft-deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteIllnessEpisodeEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/illness/episodes/{id}/restore": {
    post: {
      tags: ["Illness"],
      summary: "Restore a soft-deleted illness episode (v1.18.3)",
      description:
        "Clears `deletedAt`, bringing the episode and its preserved day-logs + encrypted note back into every read. A soft-delete keeps the row and children intact, so restore is a pure flag flip — nothing is re-created (the delete-Undo affordance). Idempotent — restoring a live episode is a no-op. Audits as `illness.episode.restore`. Owner-scoped + born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      parameters: [idempotencyKeyParameter],
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "200": {
          description: "Episode restored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessEpisode,
                "RestoreIllnessEpisodeEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/illness/episodes/{id}/resolve": {
    patch: {
      tags: ["Illness"],
      summary: "Mark an illness episode recovered (v1.18.1)",
      description:
        "Stamps `resolvedAt` (defaults to 'now' when the body omits it). A CHRONIC_ONGOING episode has no recovery date and 422s with `errorCode:\"illness.episode.chronic-no-resolve\"`. Audits as `illness.episode.resolve`. Owner-scoped + module-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: resolveIllnessEpisodeRequest },
        },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Episode resolved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessEpisode,
                "ResolveIllnessEpisodeEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/illness/episodes/{id}/day-logs": {
    get: {
      tags: ["Illness"],
      summary: "Read an episode's day-log(s) (v1.18.1, list v1.18.3)",
      description:
        "Two modes on one path, picked by the `date` param. With `date=YYYY-MM-DD`: the single day-log for that day, or `null` when nothing is logged (lets the log-day sheet pre-fill). Without `date`: the date-less LIST — the episode's day-logs newest-first (override with `sortDir`), paged via `limit`/`offset` with `meta.total`. The parent episode must be owned + live. Born-gated.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: illnessDayLogGetQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description:
            "With `date`: the day-log or null. Without `date`: the paged day-log list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.union([illnessDayLog.nullable(), illnessDayLogList]),
                "GetIllnessDayLogEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Illness"],
      summary: "Upsert an episode day-log (v1.18.1)",
      description:
        "Upserts the day's symptom / functional-impact / fever timeline row on `(episodeId, date)`: 201 on insert, 200 on update. The parent episode must be owned + live; the optional note is encrypted at rest. Audits as `illness.day-log.upsert`. Born-gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: upsertIllnessDayLogRequest },
        },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Existing day-log updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessDayLog,
                "UpsertIllnessDayLogUpdatedEnvelope",
              ),
            },
          },
        },
        "201": {
          description: "New day-log created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessDayLog,
                "UpsertIllnessDayLogCreatedEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/illness/episodes/{id}/correlation": {
    get: {
      tags: ["Illness"],
      summary: "Per-episode retrospective correlation (v1.18.1)",
      description:
        'Returns the coverage-gated `Derived<T>` correlation for one episode: the pre-onset anomaly scan, the nadir, per-vital physiological returns, the headline recovery-gap, and any red flags. The findings derive from the user\'s OWN baseline (median ± MAD) over a contamination-guarded window — never a population constant. `status:"insufficient"` carries coverage + a reason. Retrospective ONLY — never a predictor or diagnoser. Owner-scoped + module-gated.',
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "The correlation Derived DTO (ok or insufficient).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessCorrelationResponse,
                "IllnessCorrelationEnvelope",
              ),
            },
          },
        },
        ...episodeNotFound,
        ...stdResponses,
      },
    },
  },
  "/api/illness/insights": {
    get: {
      tags: ["Illness"],
      summary: "Cross-episode retrospective insights (v1.18.1)",
      description:
        "Returns the cross-episode retrospective summary over a trailing window: 'sick N times · typical recovery gap X days', a recurrence-by-month tally, and a per-type breakdown. The typical gap is withheld (null) below the min-sample floor (asserts nothing thin). Retrospective ONLY — the recurrence figure is a count of the past, never a forecast. Born-gated + owner-scoped.",
      requestParams: { query: illnessInsightsQuery },
      responses: {
        "200": {
          description: "The cross-episode retrospective summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                illnessInsightsResponse,
                "IllnessInsightsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
