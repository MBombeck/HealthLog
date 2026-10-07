/**
 * The Coach chat wire as Zod schemas.
 *
 * `types.ts` holds the TypeScript contract the server and the web client
 * compile against; this file is its mirror for the published OpenAPI
 * document (`docs/api/openapi.yaml`), which the native client reads. The two
 * are held equal by `__tests__/stream-events-type-parity.test.ts`: a field
 * added on one side and not the other fails the typecheck.
 *
 * Nothing here parses a live frame. The server builds frames from typed
 * values and the client dispatches on `type`; these schemas describe the
 * shapes, they do not police them.
 */
import { z } from "zod/v4";

import { AI_UNAVAILABLE_REASONS } from "@/lib/ai/capabilities/types";
import {
  ACTIVITY_TEXT_MAX_CHARS,
  ACTIVITY_TITLE_MAX_CHARS,
} from "@/lib/ai/coach/activity/contract";
import {
  PLAN_REVIEW_DAYS,
  REMEMBER_FACT_MAX_CHARS,
} from "@/lib/ai/coach/memory/shared";
import {
  SUGGESTED_ACTION_TYPES,
  type CheckupIntervalId,
} from "@/lib/ai/coach/suggest-action";
import { COACH_TOOL_NAMES } from "@/lib/ai/coach/tools/definitions";
import {
  COACH_MEMORY_CATEGORIES,
  coachKeyValueSchema,
  coachScopeSourceSchema,
  coachScopeWindowSchema,
} from "@/lib/ai/coach/types";

const coachWindowEnum = coachScopeWindowSchema;
const coachToolNameEnum = z.enum(COACH_TOOL_NAMES);

export const coachProvenanceMetricSchema = z.enum([
  ...coachScopeSourceSchema.options,
  "general",
]);

export const coachStepDomainSchema = z
  .enum([
    ...coachScopeSourceSchema.options,
    "labs",
    "illness",
    "cycle",
    "correlations",
    "snapshot",
  ])
  .meta({
    id: "CoachStepDomain",
    description:
      "The data domain a step, table or chip is about: a measurement-backed scope source, or a domain read as a whole (labs, illness, cycle, correlations, the full snapshot).",
  });

const coachResultGranularitySchema = z.enum(["day", "week", "month"]);
const coachResultPeriodSchema = z.enum(["current", "previous", "yearAgo"]);

// The ids and names below are restored from stored provenance and some of
// them are written back into the model's context (`m<k>.r<n>` lines, the
// "keep looking" fetched list). Each is held to its exact server-minted
// shape, so a stored row edited by hand cannot carry text into a prompt.
/** A table of a message: `r1`..`r8`. */
const resultRefSchema = z.string().regex(/^r[1-8]$/);
/** A server-minted row id (cuid). */
const messageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

// ── Steps ─────────────────────────────────────────────────────────────────

export const coachStepSchema = z
  .object({
    id: z
      .string()
      .regex(/^s[1-9]\d{0,2}$/)
      .describe("`s1`..`s64`, unique within a turn."),
    tool: z.enum([...COACH_TOOL_NAMES, "show_result", "snapshot"]),
    labelKey: z
      .string()
      .describe("Closed catalog key (`coach.step.*`) the client localises."),
    label: z
      .string()
      .describe(
        "The label rendered on the server in the request locale. Render it when the client has no string for `labelKey`.",
      ),
    domain: coachStepDomainSchema.optional(),
    window: coachWindowEnum.optional(),
    period: coachResultPeriodSchema.optional(),
    granularity: coachResultGranularitySchema.optional(),
    status: z.enum(["running", "done", "empty", "failed"]),
    count: z
      .number()
      .int()
      .optional()
      .describe("Readings or rows the server counted. Never a health value."),
    reason: z
      .enum([
        "no_data",
        "outside_window",
        "module_disabled",
        "retrieval_failed",
        "invalid_arguments",
      ])
      .optional(),
    resultRef: resultRefSchema
      .optional()
      .describe("The table this step produced (`r1`..), when it produced one."),
  })
  .meta({
    id: "CoachStep",
    description:
      "One thing the Coach read on a turn. Sent live as `step` frames that upsert by `id` (`running`, then `done` / `empty` / `failed`), and persisted on `metricSource.steps`. Catalog labels, domains, windows and counts only: never free text, an analyte name or a value.",
  });

// ── Results ───────────────────────────────────────────────────────────────

const coachResultColumnSchema = z.object({
  key: z.string(),
  kind: z.enum(["period", "category", "number", "count"]),
  labelKey: z.string(),
  label: z.string(),
  unit: z
    .string()
    .optional()
    .describe("Display unit token such as `mmHg`, never free text."),
  decimals: z.number().int().optional(),
});

const coachChartSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("line"),
    x: z.string(),
    series: z.array(z.string()),
  }),
  z
    .object({
      kind: z.literal("compare"),
      mode: z.enum(["periods", "metrics"]),
      x: z.string(),
      a: z.string(),
      b: z.string(),
      axes: z.union([z.literal(1), z.literal(2)]),
    })
    .describe(
      "v1.41 — two series on one chart: two periods overlaid (`periods`, one axis) or two metrics (`metrics`, one or two axes). `a` and `b` name the value columns, `x` the shared column.",
    ),
  z.object({
    kind: z.literal("bar"),
    x: z.string(),
    series: z.array(z.string()),
    orientation: z.enum(["vertical", "horizontal"]),
  }),
  z.object({
    kind: z.literal("histogram"),
    column: z.string(),
    unit: z.string().optional(),
    bins: z.array(
      z.object({ from: z.number(), to: z.number(), count: z.number().int() }),
    ),
  }),
]);

const coachResultSourceSchema = z.object({
  tool: coachToolNameEnum,
  domain: coachStepDomainSchema,
  window: coachWindowEnum,
  period: coachResultPeriodSchema,
  granularity: coachResultGranularitySchema.optional(),
});

const coachResultMetaShape = {
  ref: resultRefSchema.describe("`r1`..`r8`, unique within a message."),
  source: coachResultSourceSchema,
  shape: z.enum(["timeSeries", "categoryCounts", "distribution", "single"]),
  titleKey: z.string(),
  title: z.string(),
  rowCount: z.number().int().describe("The full row count, before any trim."),
  chartKind: z.enum(["line", "compare", "bar", "histogram"]).nullable(),
  displayed: z
    .boolean()
    .describe(
      "True when the answer referenced the table (shown expanded); false when it sits under the data-used disclosure.",
    ),
  reusedFrom: z
    .object({ messageId: messageIdSchema, ref: resultRefSchema })
    .optional()
    .describe("Set when the table was copied from an earlier message."),
  view: z
    .literal("table")
    .optional()
    .describe(
      "`table` when the answer asked for the table view of a table that has a chart; the chart stays for the toggle. Absent: the chart shows first when there is one.",
    ),
};

export const coachResultMetaSchema = z.object(coachResultMetaShape).meta({
  id: "CoachResultMeta",
  description:
    "A table's metadata, persisted in the plaintext provenance (`metricSource.results`). The values are not here: fetch them from `GET /api/insights/chat/{id}/messages/{messageId}/results`.",
});

export const coachResultTableSchema = z
  .object({
    ...coachResultMetaShape,
    columns: z.array(coachResultColumnSchema),
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.null()])))
      .describe(
        "Row-major cells, at most 400 rows. `null` is a period with no reading.",
      ),
    truncated: z.boolean().describe("True when `rowCount` exceeds the rows."),
    chart: coachChartSpecSchema
      .nullable()
      .describe("The chart the server chose for the table, or null."),
  })
  .meta({
    id: "CoachResultTable",
    description:
      "A table of the values a turn read. Health data: encrypted at rest and sent only to the account that owns the conversation.",
  });

const coachResultWithheldSchema = z.object({
  ref: resultRefSchema,
  withheld: z
    .enum(["module_disabled", "unavailable"])
    .describe(
      "`module_disabled`: the table's domain is switched off for this record. `unavailable`: the stored tables could not be read.",
    ),
});

export const coachResultEntrySchema = z
  .union([coachResultTableSchema, coachResultWithheldSchema])
  .meta({
    id: "CoachResultEntry",
    description:
      "One stored table, or the reason it is not served. Absence is explicit: a withheld table names why.",
  });

// ── Method ────────────────────────────────────────────────────────────────

export const coachMethodSchema = z
  .object({
    entries: z.array(
      z.object({
        domain: coachStepDomainSchema,
        window: coachWindowEnum.optional(),
        period: coachResultPeriodSchema.optional(),
        granularity: coachResultGranularitySchema.optional(),
        count: z.number().int().optional(),
        aggregation: z
          .enum(["mean", "median", "latest", "sum", "count", "rate"])
          .optional(),
        absent: z
          .enum(["no_data", "outside_window", "module_disabled"])
          .optional(),
      }),
    ),
    text: z.string().describe("Rendered on the server in the request locale."),
  })
  .meta({
    id: "CoachMethod",
    description:
      "How an answer was reached: which sources, windows, counts and aggregation. Never a health value.",
  });

// ── Choices and assumptions ───────────────────────────────────────────────

/** An id the server minted for a plan, a fact or a record event. */
const choiceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const coachChoiceValueSchema = z
  .object({
    metric: coachScopeSourceSchema.optional(),
    window: coachWindowEnum.optional(),
    comparison: z
      .enum(["previous_period", "year_ago", "baseline_90d"])
      .optional()
      .describe("v1.41 — what a comparison is drawn against."),
    goal: choiceIdSchema
      .optional()
      .describe("v1.41 — an active plan or a goal fact, by id."),
    anchor: choiceIdSchema
      .optional()
      .describe(
        "v1.41 — a medication start, an illness episode or a cycle phase, by id.",
      ),
  })
  .describe("What a choice stands for: catalog tokens and ids, never text.");

const coachAssumptionKindSchema = z.enum(["metric", "window", "comparison"]);

const coachAssumptionOptionSchema = z.object({
  labelKey: z.string(),
  label: z.string(),
  value: coachChoiceValueSchema,
});

export const coachAssumptionSchema = z
  .object({
    kind: coachAssumptionKindSchema,
    value: coachAssumptionOptionSchema,
    alternatives: z.array(coachAssumptionOptionSchema).describe("At most 3."),
  })
  .meta({
    id: "CoachAssumption",
    description:
      "v1.41 — what an answer assumed instead of asking, from a catalog. Each alternative is offered as a `change_assumption` follow-up.",
  });

// ── Follow-ups ────────────────────────────────────────────────────────────

export const coachFollowUpSchema = z
  .object({
    id: z
      .string()
      .regex(/^f[1-3]$/)
      .describe("`f1`..`f3`."),
    kind: z.enum([
      "widen_window",
      "previous_period",
      "year_ago",
      "as_chart",
      "as_table",
      "related_metric",
      "continue",
      "change_assumption",
    ]),
    labelKey: z.string(),
    label: z
      .string()
      .describe("Rendered on the server from a catalog; never model text."),
    anchor: z
      .object({
        // Empty for a related metric read without a table of its own.
        ref: z.string().regex(/^(?:r[1-8])?$/),
        domain: coachStepDomainSchema,
        window: coachWindowEnum.optional(),
        granularity: coachResultGranularitySchema.optional(),
        period: coachResultPeriodSchema.optional(),
      })
      .optional(),
    reuse: z
      .boolean()
      .describe(
        "True when the chip is answered from a stored table without a model call.",
      ),
    origin: z.enum(["server", "model"]),
    assumption: z
      .object({
        kind: coachAssumptionKindSchema,
        value: coachChoiceValueSchema,
      })
      .optional()
      .describe(
        "v1.41 — on a `change_assumption` chip: the assumption it replaces and the alternative it picks.",
      ),
  })
  .meta({
    id: "CoachFollowUp",
    description:
      "A chip offered under the latest assistant reply. Send it back as `followUp: { messageId, id }` with the chip's label as `message`.",
  });

// ── Clarification ─────────────────────────────────────────────────────────

export const coachClarificationSchema = z
  .object({
    kind: z
      .enum(["metric", "window", "comparison", "goal", "anchor", "context"])
      .describe("`comparison`, `goal` and `anchor` since v1.41."),
    choices: z
      .array(
        z.object({
          id: z.string().regex(/^c[1-4]$/),
          labelKey: z.string(),
          label: z.string(),
          value: coachChoiceValueSchema,
        }),
      )
      .describe("At most 4. Metric choices are always ones the record holds."),
    freeText: z.boolean().describe("Whether a typed answer is welcome."),
    assumption: z
      .string()
      .regex(/^c[1-4]$/)
      .optional()
      .describe(
        "v1.41 — the choice that applies when the person does not answer. The question names it, and it is the first choice.",
      ),
  })
  .meta({
    id: "CoachClarification",
    description:
      "The choices for a clarifying question. The question itself is the assistant message's text. Answer with `clarification: { messageId, choiceId? }`.",
  });

// ── Activity, memory and plans (v1.41) ────────────────────────────────────

const coachStopReasonSchema = z.enum(["budget", "time", "cap", "no_progress"]);

export const coachStopSchema = z
  .object({
    reason: coachStopReasonSchema,
    rounds: z
      .number()
      .int()
      .describe("The rounds the turn ran, the final one included."),
  })
  .meta({
    id: "CoachStop",
    description:
      "v1.41 — why the Coach answered before it was done reading: the token budget, the time budget, the round cap, or no new data.",
  });

const coachActivityMetaShape = {
  id: z
    .string()
    .regex(/^a[1-9]\d?$/)
    .describe("`a1`..`a99`, unique within a turn."),
  phase: z.enum([
    "thinking",
    "memory",
    "fetch",
    "digest",
    "checkpoint",
    "remember",
    "plan",
    "asking",
    "stop",
    "answer",
  ]),
  status: z.enum(["running", "done", "empty", "failed"]),
  round: z.number().int().describe("The tool round, from 1."),
  labelKey: z
    .string()
    .describe("Closed catalog key (`insights.coach.activity.*`)."),
  label: z
    .string()
    .describe(
      "Rendered on the server in the request locale from the catalog; never model text.",
    ),
  stepRef: z
    .string()
    .regex(/^s[1-9]\d{0,2}$/)
    .optional()
    .describe("The `step` a `fetch` entry stands for."),
  count: z
    .number()
    .int()
    .optional()
    .describe("Readings, lookups or entries the server counted."),
  durationMs: z.number().int().optional(),
  stop: coachStopReasonSchema.optional().describe("Set on the `stop` entry."),
};

export const coachActivityMetaSchema = z.object(coachActivityMetaShape).meta({
  id: "CoachActivityMeta",
  description:
    "v1.41 — one entry of a turn's trail as persisted on `metricSource.activity`: phase, status, round, catalog label, counts. The model-written title and text are behind `GET /api/insights/chat/{id}/messages/{messageId}/trail`.",
});

export const coachActivitySchema = z
  .object({
    ...coachActivityMetaShape,
    title: z
      .string()
      .max(ACTIVITY_TITLE_MAX_CHARS)
      .optional()
      .describe("A screened reasoning title or checkpoint sentence."),
    text: z
      .string()
      .max(ACTIVITY_TEXT_MAX_CHARS)
      .optional()
      .describe("A screened reasoning summary for the round."),
  })
  .meta({
    id: "CoachActivity",
    description:
      "v1.41 — one entry of the live trail, sent as `activity` frames that upsert by `id`. `title` and `text` are model text, screened, and sent only to the account that owns the conversation.",
  });

const coachFactCategorySchema = z.enum(COACH_MEMORY_CATEGORIES);

const coachMemoryNoteMetaShape = {
  proposal: z
    .boolean()
    .describe(
      "`true`: waiting for the person, answered with `memoryDecision`. `false`: already saved; undo deletes `factId`.",
    ),
  proposalId: choiceIdSchema.optional(),
  factId: choiceIdSchema.optional(),
  category: coachFactCategorySchema,
};

export const coachMemoryNoteMetaSchema = z
  .object(coachMemoryNoteMetaShape)
  .meta({
    id: "CoachMemoryNoteMeta",
    description:
      "v1.41 — the fact a reply saved or proposes, as persisted on `metricSource.memoryNote`. No fact text.",
  });

export const coachMemoryNoteSchema = z
  .object({
    ...coachMemoryNoteMetaShape,
    fact: z.string().max(REMEMBER_FACT_MAX_CHARS),
  })
  .meta({
    id: "CoachMemoryNote",
    description:
      "v1.41 — a fact the Coach saved during the turn, or proposes to save (health facts are never saved without a tap). Owner only.",
  });

const coachPlanProposalMetaShape = {
  planId: choiceIdSchema,
  metric: z.string().max(64),
  reviewInDays: z
    .number()
    .int()
    .min(PLAN_REVIEW_DAYS.min)
    .max(PLAN_REVIEW_DAYS.max),
};

export const coachPlanProposalMetaSchema = z
  .object(coachPlanProposalMetaShape)
  .meta({
    id: "CoachPlanProposalMeta",
    description:
      "v1.41 — the plan a reply proposes, as persisted on `metricSource.planProposal`. No plan text.",
  });

export const coachPlanProposalSchema = z
  .object({
    ...coachPlanProposalMetaShape,
    ifCue: z.string(),
    thenAction: z.string(),
    target: z.string().optional(),
  })
  .meta({
    id: "CoachPlanProposal",
    description:
      "v1.41 — a plan the Coach proposes, written as `proposed`. Answer with `planDecision: { messageId, planId, accept }`. Owner only.",
  });

export const coachTrailSchema = z
  .object({
    entries: z.array(
      z.object({
        id: z.string().regex(/^a[1-9]\d?$/),
        title: z.string().max(ACTIVITY_TITLE_MAX_CHARS).optional(),
        text: z.string().max(ACTIVITY_TEXT_MAX_CHARS).optional(),
      }),
    ),
    recalled: z.array(z.string().max(REMEMBER_FACT_MAX_CHARS)).optional(),
    proposal: z
      .object({
        proposalId: choiceIdSchema,
        category: coachFactCategorySchema,
        fact: z.string().max(REMEMBER_FACT_MAX_CHARS),
      })
      .optional(),
  })
  .meta({
    id: "CoachTrail",
    description:
      "v1.41 — the model-written text of a turn's trail and the fact texts it touched. Encrypted at rest and served only to the account that owns the conversation.",
  });

// ── The cards and the usage envelope ──────────────────────────────────────

const coachSuggestionSchema = z
  .object({
    cadenceId: z.string(),
    measurementType: z.string(),
    label: z.string(),
  })
  .meta({
    id: "CoachSuggestion",
    description:
      "A cadence-suggestion card. Accepting it posts `cadenceId` to `POST /api/measurement-reminders`.",
  });

const checkupIntervalSchema = z.string() as z.ZodType<CheckupIntervalId>;

const coachSuggestedActionSchema = z
  .object({
    actionType: z.enum(SUGGESTED_ACTION_TYPES),
    summary: z.string(),
    titleKey: z.string(),
    params: z.discriminatedUnion("actionType", [
      z.object({
        actionType: z.literal("checkup.create"),
        label: z.string(),
        interval: checkupIntervalSchema,
      }),
      z.object({
        actionType: z.literal("reminder.note"),
        note: z.string(),
        when: z.string().optional(),
        metric: z.string().optional(),
      }),
    ]),
  })
  .meta({
    id: "CoachSuggestedActionCard",
    description:
      "A confirm-to-apply action card from a closed allowlist. Nothing is created until the person confirms it through `POST /api/coach/suggested-actions`.",
  });

const coachUsageSchema = z
  .object({
    totalTokens: z.number().int().nullable(),
    promptTokens: z.number().int().nullable().optional(),
    completionTokens: z.number().int().nullable().optional(),
    model: z.string().nullable().optional(),
  })
  .meta({
    id: "CoachUsage",
    description:
      "Per-turn token usage. Server-authoritative: clients display it, never recompute it.",
  });

// ── Provenance ────────────────────────────────────────────────────────────

export const coachProvenanceSchema = z
  .object({
    windows: z
      .array(coachWindowEnum)
      .readonly()
      .describe("Analysis windows the assistant drew on this turn."),
    metrics: z
      .array(coachProvenanceMetricSchema)
      .readonly()
      .describe(
        "Stable metric-topic keys referenced (e.g. bp, weight, sleep, glucose). `general` is the empty-snapshot sentinel. The client translates these labels; the server never localises them.",
      ),
    counts: z
      .partialRecord(coachProvenanceMetricSchema, z.number().int())
      .optional()
      .describe(
        "Per-metric sample-count summary; absent on an empty snapshot.",
      ),
    keyValues: z
      .array(coachKeyValueSchema)
      .readonly()
      .optional()
      .describe(
        "Load-bearing numbers the assistant surfaced, rendered in the collapsible evidence block. Hard-capped at 8 entries.",
      ),
    suggestion: coachSuggestionSchema
      .optional()
      .describe("The cadence-suggestion card this turn carried, if any."),
    suggestedAction: coachSuggestedActionSchema
      .optional()
      .describe("The confirm-to-apply action card this turn carried, if any."),
    toolCalls: z
      .array(z.object({ name: z.string(), present: z.boolean() }))
      .readonly()
      .optional()
      .describe(
        "v1.20.0 — the retrieval-tool trace for this turn: which tools the Coach called and whether each found data. Metadata only (no values). Absent on the legacy snapshot path and on turns that called no tools.",
      ),
    groundedFigures: z
      .array(z.number())
      .readonly()
      .optional()
      .describe(
        "Bare magnitudes the turn's tools returned, recalled by a later turn's number check. Server-computed, label-less.",
      ),
    unverifiedFigures: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "v1.32.14 — count of numeric tokens the grounding guard withheld from this reply (each rewritten to the editorial elision mark). Drives the quiet per-message notice. Count only, never the withheld values. Absent when the turn withheld nothing.",
      ),
    steps: z
      .array(coachStepSchema)
      .optional()
      .describe("v1.39.4 — what the Coach read on this turn."),
    method: coachMethodSchema
      .optional()
      .describe("v1.39.4 — how the answer was reached."),
    results: z
      .array(coachResultMetaSchema)
      .optional()
      .describe(
        "v1.39.4 — the tables this turn produced, metadata only; the values are behind the results endpoint.",
      ),
    followUps: z
      .array(coachFollowUpSchema)
      .optional()
      .describe("v1.39.4 — the chips offered under this reply."),
    clarification: coachClarificationSchema
      .optional()
      .describe("v1.39.4 — the choices, when this reply is a question."),
    forcedFinal: z
      .literal(true)
      .optional()
      .describe(
        "v1.39.4 — the answer was forced at the round cap while the Coach still wanted to read. Absent otherwise.",
      ),
    continuationOf: z
      .string()
      .max(64)
      .optional()
      .describe(
        "v1.39.4 — this reply continues an answer that was forced at the round cap (the `continue` chip): the id of that earlier assistant message. A continuation offers no further `continue` chip. Absent otherwise.",
      ),
    activity: z
      .array(coachActivityMetaSchema)
      .optional()
      .describe("v1.41 — the turn's trail, metadata only."),
    stop: coachStopSchema
      .optional()
      .describe("v1.41 — why the answer was forced, when it was."),
    assumptions: z
      .array(coachAssumptionSchema)
      .optional()
      .describe(
        "v1.41 — what the answer assumed instead of asking, at most two.",
      ),
    memoryNote: coachMemoryNoteMetaSchema
      .optional()
      .describe(
        "v1.41 — the fact this reply saved or proposes, without its text.",
      ),
    planProposal: coachPlanProposalMetaSchema
      .optional()
      .describe("v1.41 — the plan this reply proposes, without its text."),
  })
  .meta({
    id: "CoachProvenance",
    description:
      "Provenance envelope attached to an assistant message — labels and counts only, plus the optional evidence key-values and cards. No raw timestamps and no table values.",
  });

// ── Frames ────────────────────────────────────────────────────────────────

export const coachStreamEventSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("token"), token: z.string() }),
    z.object({
      type: z.literal("provenance"),
      metricSource: coachProvenanceSchema,
    }),
    z.object({
      type: z.literal("suggestion"),
      suggestion: coachSuggestionSchema,
    }),
    z.object({
      type: z.literal("suggestedAction"),
      suggestedAction: coachSuggestedActionSchema,
    }),
    z.object({ type: z.literal("reasoning"), text: z.string() }),
    z.object({
      type: z.literal("done"),
      conversationId: z.string(),
      messageId: z.string(),
      usage: coachUsageSchema.optional(),
      stop: coachStopSchema.optional(),
      withheldResults: z
        .literal(true)
        .optional()
        .describe(
          "v1.41 — the turn was blocked after interim tables went out; remove them.",
        ),
    }),
    z.object({
      type: z.literal("error"),
      code: z.string(),
      message: z.string(),
      reason: z.enum(AI_UNAVAILABLE_REASONS).optional(),
    }),
    z.object({ type: z.literal("step"), step: coachStepSchema }),
    z.object({
      type: z.literal("result"),
      result: coachResultTableSchema,
      interim: z
        .literal(true)
        .optional()
        .describe("v1.41 — sent while the turn still runs."),
    }),
    z.object({
      type: z.literal("followUps"),
      followUps: z.array(coachFollowUpSchema),
    }),
    z.object({
      type: z.literal("clarification"),
      clarification: coachClarificationSchema,
    }),
    z.object({ type: z.literal("activity"), activity: coachActivitySchema }),
    z.object({ type: z.literal("memoryNote"), note: coachMemoryNoteSchema }),
    z.object({
      type: z.literal("planProposal"),
      proposal: coachPlanProposalSchema,
    }),
  ])
  .meta({
    id: "CoachStreamEvent",
    description:
      "One Server-Sent Events frame of a Coach turn, sent as `data: <json>\\n\\n` and dispatched on `type`. Order: `(activity | step)*` → `token*` → `provenance` → `result*` → `suggestion?` → `suggestedAction?` → `memoryNote?` → `planProposal?` → `clarification?` → `followUps?` → `done`, or a single `error`. `result` frames with `interim: true` may also arrive among the `activity` frames. Clients ignore a `type` they do not know.",
  });
