/**
 * OpenAPI route table — insights layout, coach facts, about-me, chat message feedback.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  aboutMeAdoptSchema,
  aboutMePutSchema,
} from "@/lib/validations/about-me";
import {
  healthProfileAiSectionSchema,
  healthProfileFactCorrectionSchema,
  healthProfileFactDtoSchema,
  healthProfileFactsResponseSchema,
  healthProfileFactWriteSchema,
  removedHealthProfileFactSchema,
} from "@/lib/validations/health-profile-facts";
import {
  emergencyProfileDtoSchema,
  emergencyProfileUpdateSchema,
} from "@/lib/validations/emergency-profile";
import {
  ACCEPTED_INSIGHTS_TILE_IDS,
  INSIGHTS_SECTION_IDS,
} from "@/lib/insights-layout";
import { COACH_CONVERSATION_TITLE_MAX } from "@/lib/ai/coach/types";
import { COACH_FACT_CATEGORIES } from "@/lib/ai/coach/facts";
import { COACH_FACT_SOURCES } from "@/lib/ai/coach/memory/shared";
import {
  coachFactCreateSchema,
  coachFactPatchSchema,
} from "@/lib/validations/coach-fact";
import { COACH_PLAN_STATUSES } from "@/lib/ai/coach/plans";
import {
  COACH_PLAN_SCOPES,
  coachPlanPatchSchema,
} from "@/lib/validations/coach-plan";
import { coachChatRequestSchema } from "@/lib/ai/coach/types";
import {
  coachProvenanceSchema,
  coachResultEntrySchema,
  coachStreamEventSchema,
  coachTrailSchema,
} from "@/lib/ai/coach/stream-events";
import {
  coachAttachmentCreateSchema,
  fencedChatRequestSchema,
} from "@/lib/validations/inbound-documents";
import { coachReminderSuggestionActionSchema } from "@/lib/validations/coach-reminder-suggestion";
import { COACH_REMINDER_STATUSES } from "@/lib/ai/coach/reminders";
import {
  coachReminderCreateSchema,
  coachReminderPatchSchema,
  coachSuggestedActionSchema,
} from "@/lib/validations/coach-reminder";
import {
  MODULE_DISABLED_DESCRIPTION,
  baseUpdatedAtField,
  conflictResponse409,
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  invalidBaseTokenResponse,
  recordRefusal,
  stdResponses,
} from "./shared";
import { aiCheckFailedResponse, aiRefusal403Description } from "./ai-refusal";
import { aiCapabilityState } from "./profile";
import {
  AI_EXTRACTION_UNAVAILABLE_DESCRIPTION,
  aiExtractionRefusalDescription,
  aiExtractionRefusals,
} from "./ai-extraction-refusals";

// The assigning form, deliberately: `schema.meta({...})` as a bare statement
// returns a clone and registers nothing, so the component id would never
// reach the emitted document.
const aboutMeAdoptRequest = aboutMeAdoptSchema.meta({
  id: "CoachAboutMeAdoptRequest",
  description:
    "An answer to fold into the stored self-context. `question` is the clarifying question it belongs to and is what the server matches the target field from; omit it for the remember-a-message path and the field is matched from `answer` instead. `answer` is capped at 500 characters — the same cap as a structured self-context field.",
});

const updateEmergencyProfileRequest = emergencyProfileUpdateSchema.meta({
  id: "UpdateEmergencyProfileRequest",
  description:
    "Partial edit of the emergency (Notfalldaten) profile. An omitted key leaves the column untouched; a `null` enum or an emptied free-text field clears it. `bloodType`, `organDonor` and `advanceDirective` are closed enums; `contacts`, `implants` and `note` are encrypted at rest. Rejects unknown keys.",
});

const emergencyProfile = emergencyProfileDtoSchema.meta({
  id: "EmergencyProfile",
  description:
    "The caller's emergency profile: three closed-enum facts plus three decrypted free-text fields. A free-text field is null when unset; its `*Unreadable` flag is true when ciphertext was present but could not be decrypted (a key-rotation gap, fail-soft rather than 500).",
});

// ── Coach cadence suggestions (v1.18.1) ──────────────────────────────
// The action endpoint behind the one-tap reminder-suggestion card. The
// client sends ONLY the cadence id + the action; the server resolves the
// metric + schedule + course window from the closed catalog and (for
// `accept`) mints a `MeasurementReminder` with `origin: COACH`.
const coachReminderSuggestionAction = coachReminderSuggestionActionSchema.meta({
  id: "CoachReminderSuggestionAction",
  description:
    "v1.18.1 — act on a Coach cadence suggestion. `cadenceId` names a closed-catalog preset (e.g. `weight_daily`, `bp_7_2_2`); the client never sends a schedule. `action`: `accept` creates a `MeasurementReminder` (origin: COACH) through the same engine the Vorsorge surface uses; `dismiss` records dismissal memory; `stop` suppresses all future cadence suggestions. Strict: unknown keys 422.",
});

const coachReminderSuggestionResultSchema = z
  .object({
    ok: z.literal(true),
    action: z.enum(["accept", "dismiss", "stop"]),
    reminder: z
      .unknown()
      .nullable()
      .optional()
      .describe(
        "On `accept` of a fresh suggestion: the created MeasurementReminder DTO. Null when the action was a prefs-only dismiss/stop, or when an accept hit the structural dedup (`duplicate: true`).",
      ),
    duplicate: z
      .boolean()
      .optional()
      .describe(
        "True when an `accept` matched an already-live COACH reminder for the same metric (idempotent no-op).",
      ),
  })
  .meta({
    id: "CoachReminderSuggestionResult",
    description:
      "Outcome of a Coach cadence-suggestion action. `accept` returns 201 with the created reminder (or 200 + `duplicate: true` when one already exists); `dismiss`/`stop` return 200.",
  });

export const coachReminderSuggestionPaths: NonNullable<
  ZodOpenApiObject["paths"]
> = {
  "/api/coach/reminder-suggestions": {
    post: {
      tags: ["Insights"],
      summary: "Act on a Coach cadence suggestion",
      description:
        'v1.18.1 — accept / dismiss / stop a Coach-proposed measurement cadence. Coach-gated (`requireModuleEnabled("coach")`); a disabled surface 403s. `accept` resolves the cadence from the closed server-side catalog and creates a `MeasurementReminder` with `origin: COACH` (201), or returns 200 with `duplicate: true` when a live COACH reminder for that metric already exists — idempotent against a re-tapped or stale card, with a partial unique index as the structural backstop. Per-user rate-limited (429 on excess). Auth via cookie or Bearer; the owner is narrowed from the session.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachReminderSuggestionAction },
        },
      },
      responses: {
        "200": {
          description:
            "A dismiss/stop, or an accept that matched an existing reminder (`duplicate: true`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachReminderSuggestionResultSchema,
                "CoachReminderSuggestionResultOk",
              ),
            },
          },
        },
        "201": {
          description: "An accept that created a new reminder.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachReminderSuggestionResultSchema,
                "CoachReminderSuggestionResultCreated",
              ),
            },
          },
        },
        "403": {
          description: "Coach surface (or the cadence's module) disabled.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        // 401 / 422 / 429 come from stdResponses.
        ...stdResponses,
      },
    },
  },
};

const coachMessageFeedbackBody = z
  .object({
    rating: z.enum(["helpful", "unhelpful"]),
    reason: z.string().min(1).max(200).optional(),
  })
  .meta({
    id: "CoachMessageFeedbackRequest",
    description:
      "Per-message helpful/unhelpful feedback (v1.4.23 H7). Optional `reason` is free-form prose, capped at 200 chars.",
  });

// Insights tile layout — mirrors the Zod schema in
// `src/app/api/insights/layout/route.ts`. The tile-id enum is derived
// from the same `ACCEPTED_INSIGHTS_TILE_IDS` source so the contract
// cannot drift.
//
// v1.8.0 — the canonical ids are English (`blood-pressure`, `pulse`,
// `oxygen`, `body-temperature`, `weight`, `active-energy`, `sleep`,
// `resting-pulse`, `mood`, `medications`). The endpoint still ACCEPTS
// the legacy German ids (`blutdruck`, `puls`, `sauerstoff`,
// `koerpertemperatur`, `gewicht`, `aktive-energie`, `schlaf`,
// `ruhepuls`, `stimmung`, `medikamente`) on input so existing iOS
// layouts keep validating; the server normalises them to the canonical
// English id before persisting, and GET always returns canonical ids.
// The legacy ids are accepted-but-deprecated and will be dropped from
// the accepted set in a future major.
// v1.15.11 — layout v2 adds an optional `sections` array on top of the
// per-metric `tiles` list so the overview's big semantic blocks can be
// reordered/hidden in their own right. `sections` is additive and
// optional: a client PUTting only `tiles` (the pre-v2 iOS contract) still
// validates, and a v1 blob resolves forward to a valid v2 layout with all
// sections default-visible. Section ids are English from birth — no
// legacy-alias widening. `tiles` is likewise optional now (a section-only
// PUT fills the default tile set), but must carry at least one entry when
// present.
const insightsLayoutSchema = z
  .object({
    // v1.15.11 QA C1 — both v1 and v2 are accepted on input. The live iOS
    // client still PUTs `version: 1`; the server normalises to the canonical
    // v2 blob on persist, so a v1 body never 422s on the layout-schema bump.
    version: z.union([z.literal(1), z.literal(2)]),
    sections: z
      .array(
        z.object({
          id: z.enum(INSIGHTS_SECTION_IDS),
          visible: z.boolean(),
          order: z.number().int().min(0).max(99),
        }),
      )
      .max(50)
      .optional(),
    tiles: z
      .array(
        z.object({
          id: z.enum(ACCEPTED_INSIGHTS_TILE_IDS),
          visible: z.boolean(),
          order: z.number().int().min(0).max(99),
        }),
      )
      .min(1)
      // Cap at the accepted-id universe so a PUT can cover every tile the
      // layout knows about; grows automatically as new sub-page slugs land.
      .max(ACCEPTED_INSIGHTS_TILE_IDS.length)
      .optional(),
  })
  .meta({
    id: "InsightsLayoutBody",
    description:
      "Per-user Insights layout (v2). `tiles` is the per-metric pill list (ordered, with a visibility flag); `sections` is the additive v2 list of the overview's big semantic blocks (wellness-scores, daily-briefing, vitals, trends, period-review, cycle-summary, signals, rhythm-events), each with order + visibility. `version` is the layout schema version: BOTH 1 and 2 are accepted on input (a pre-v2 iOS client still PUTs `version: 1`); the server always normalises to the canonical v2 blob before persisting, and GET responses always carry `version: 2`. Both arrays are optional on input — a client sending only `tiles` (the pre-v2 contract) still validates, and the server fills missing defaults; a v1 blob with no `sections` resolves forward with all sections default-visible. Tile ids are a closed enum: the canonical ids are English (matching the routed `/insights/<slug>` sub-pages). The legacy German tile ids (blutdruck, puls, sauerstoff, koerpertemperatur, gewicht, aktive-energie, schlaf, ruhepuls, stimmung, medikamente) remain accepted on input for backward compatibility and are normalised to their English equivalents before persisting; GET responses always carry the canonical English ids. Section ids are English-only. The legacy tile ids are deprecated and will be removed in a future major version.",
  });

// v1.32.21 (R5a) — the PUT body additionally carries the optional
// optimistic-concurrency base token (stripped pre-Zod at runtime by
// `takeBaseToken`); GET / PUT responses echo the fresh `updatedAt` token.
const insightsLayoutPutBody = insightsLayoutSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "InsightsLayoutPutBody",
    description:
      "PUT body for the Insights layout — the layout fields plus the optional optimistic-concurrency base token (`baseUpdatedAt`). Omit the token for the legacy unconditional write.",
  });
const insightsLayoutResult = insightsLayoutSchema
  .extend({
    updatedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Optimistic-concurrency token: the stored row's `updatedAt` at read/write time. Echo it back as `baseUpdatedAt` on the next write. Opaque.",
      ),
  })
  .meta({
    id: "InsightsLayoutResult",
    description:
      "Resolved Insights layout plus the optimistic-concurrency `updatedAt` token.",
  });

// ── Coach facts (v1.11.1, v1.41) ─────────────────────────────────────
// The Coach's memory list: list, the remember button (create from one of the
// caller's own messages), edit the wording, bulk-clear and single-delete.

const coachFactCategory = z
  .enum(COACH_FACT_CATEGORIES)
  .describe(
    "App-side closed category: preference | goal | context | condition | constraint | medication (v1.41).",
  );

const coachFactSource = z
  .enum(COACH_FACT_SOURCES)
  .describe(
    "v1.41 — where the fact came from: `user` (the remember button, or a proposal the caller confirmed), `coach` (saved during a turn), `extracted` (the background extraction; every fact older than v1.41), `pattern` (the deterministic matcher). `proposed` is never listed.",
  );

const coachFactItem = z.object({
  id: z.string(),
  category: coachFactCategory,
  text: z.string().describe("Decrypted fact text."),
  confidence: z
    .number()
    .int()
    .describe("0..100 server-assigned extraction confidence."),
  source: coachFactSource,
  sourceConversationId: z
    .string()
    .nullable()
    .describe("The conversation the fact came out of, when known."),
  sourceMessageId: z
    .string()
    .nullable()
    .describe("v1.41 — the message the fact came out of, when known."),
  lastUsedAt: z.iso
    .datetime({ offset: true })
    .nullable()
    .describe("v1.41 — when the fact last went into a Coach turn."),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso
    .datetime({ offset: true })
    .describe("v1.41 — when the fact was last written or edited."),
});

const coachFactCreateRequest = coachFactCreateSchema.meta({
  id: "CoachFactCreateRequest",
  description:
    "v1.41 — the remember button: the id of one of the caller's own Coach messages. Never the text: the server reads the message it stored. Strict: unknown keys 422.",
});

const coachFactPatchRequest = coachFactPatchSchema.meta({
  id: "CoachFactPatchRequest",
  description:
    "v1.41 — the fact's new wording (3..160 characters). Only the text: the server reads the new wording to file it (a fact that names a medication moves to `medication`, other health wording moves a non-health fact to `condition`) and a health fact the caller wrote counts as confirmed. Strict: unknown keys 422.",
});

const coachFactWrittenItem = z.object({
  id: z.string(),
  category: coachFactCategory,
  text: z.string().describe("The fact as stored."),
  source: coachFactSource,
});

const coachFactCreatedResponse = z.object({
  fact: coachFactWrittenItem,
  created: z
    .boolean()
    .describe(
      "False when the caller's memory already held the same fact (or a proposal for it, now confirmed); the existing fact is returned.",
    ),
});

const coachFactUpdatedResponse = z.object({
  fact: coachFactWrittenItem.extend({
    updatedAt: z.iso.datetime({ offset: true }),
  }),
});

const coachFactsListResponse = z.object({
  facts: z
    .array(coachFactItem)
    .describe(
      "The caller's active facts, highest-confidence then newest first. Undecryptable rows are omitted.",
    ),
});

const coachFactsClearedResponse = z.object({
  cleared: z
    .number()
    .int()
    .describe("Number of active facts soft-deleted by the bulk clear."),
});

const coachFactDeletedResponse = z.object({
  deleted: z
    .boolean()
    .describe(
      "True when a fact owned by the caller was soft-deleted; false for an unknown / cross-user / already-deleted id (idempotent no-op).",
    ),
});

// ── Coach plans (v1.21.3 B1) ─────────────────────────────────────────
// The durable goal / if-then plans the Coach proposes and the user
// confirms. The extractor writes a plan as `proposed`; the PATCH below is
// the only path that activates it. The list/PATCH never accept the metric
// or the encrypted free text — a client can only confirm / change a plan's
// lifecycle, never inject or overwrite its prose.

const coachPlanItem = z
  .object({
    id: z.string(),
    metric: z
      .string()
      .describe("The metric this plan moves (e.g. WEIGHT, SLEEP)."),
    ifCue: z
      .string()
      .nullable()
      .describe(
        "Decrypted if-cue (the trigger). Null when the row's key id is no longer in the map.",
      ),
    thenAction: z
      .string()
      .nullable()
      .describe(
        "Decrypted then-action. Null when the row's key id is no longer in the map.",
      ),
    target: z
      .string()
      .nullable()
      .describe("Decrypted optional target; null when none / undecryptable."),
    status: z
      .enum(COACH_PLAN_STATUSES)
      .describe("App-side lifecycle: proposed | active | met | abandoned."),
    reviewDate: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("Optional check-in checkpoint; null when none."),
    sourceConversationId: z
      .string()
      .nullable()
      .describe(
        "Id of the conversation the proposal was extracted from; null for a plan without conversation provenance. Lets a chat surface show only the proposals born in the open thread.",
      ),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "CoachPlan",
    description:
      "One Coach goal / if-then plan, decrypted server-side. The free-text fields read null only when the encryption key id has rotated out of the map.",
  });

const coachPlansListResponse = z.object({
  plans: z
    .array(coachPlanItem)
    .describe(
      "The caller's plans, newest first. Undecryptable rows are omitted from the list endpoint. No `status` filter returns the non-terminal set (proposed + active).",
    ),
});

const coachPlanUpdatedResponse = z.object({
  plan: coachPlanItem.describe("The plan after the lifecycle update."),
});

const coachPlanDeletedResponse = z.object({
  deleted: z
    .boolean()
    .describe(
      "True when a plan owned by the caller was soft-deleted; false for an unknown / cross-user / already-deleted id (idempotent no-op).",
    ),
});

const coachPlanPatchRequest = coachPlanPatchSchema.meta({
  id: "CoachPlanPatchRequest",
  description:
    "v1.21.3 — confirm or update a Coach plan's lifecycle. `status` moves a `proposed` plan to `active` (confirm), or to `met` / `abandoned`. `reviewDate` pins (ISO instant) or clears (null) a check-in checkpoint. At least one field is required. Strict: unknown keys 422 — the body can never carry the metric, the encrypted text, or a userId.",
});

// `GET /api/coach/plans` publishes its two query parameters by hand below,
// not through `requestParams.query`: the runtime schema carries a cross-field
// `.refine()` (status and scope are mutually exclusive) that the expansion
// cannot express, and the hand-written pair carries per-parameter prose it
// would drop. A `CoachPlansListQuery` annotation sat here claiming a component
// id that nothing referenced and that a query object could never reach anyway
// — the emitter inlines query objects into `parameters`. Every clause of it is
// already published on the operation and on both parameters, so it is gone
// rather than left registering nothing.

// ── Coach episodic reminders (v1.22 B2/B6) ──────────────────────────────
const coachReminderItem = z
  .object({
    id: z.string(),
    note: z
      .string()
      .nullable()
      .describe(
        "Decrypted note (the user's own framing). Null when the row's key id is no longer in the map.",
      ),
    metric: z.string().nullable(),
    triggerKind: z.enum(["date", "context"]),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    contextCue: z.string().nullable(),
    status: z.enum(COACH_REMINDER_STATUSES),
    source: z.enum(["sentinel", "extractor", "manual", "action"]),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "CoachReminder",
    description:
      "One Coach episodic reminder, decrypted server-side. The note reads null only when the encryption key id has rotated out of the map.",
  });

const coachRemindersListResponse = z.object({
  reminders: z
    .array(coachReminderItem)
    .describe(
      "The caller's reminders, soonest-due first. Undecryptable rows are omitted. No `status` filter returns the non-terminal set (proposed + active + due + surfaced).",
    ),
});

const coachReminderCreatedResponse = z.object({
  reminder: coachReminderItem,
});

const coachReminderUpdatedResponse = z.object({
  reminder: coachReminderItem,
});

const coachReminderDeletedResponse = z.object({
  deleted: z
    .boolean()
    .describe(
      "True when a reminder owned by the caller was soft-deleted; false for an unknown / cross-user / already-deleted id (idempotent no-op).",
    ),
});

const coachSuggestedActionResultResponse = z
  .object({
    ok: z.literal(true),
    actionType: z.enum(["checkup.create", "reminder.note"]),
    reminder: z.unknown().optional(),
    reminderId: z.string().optional(),
  })
  .meta({
    id: "CoachSuggestedActionResult",
    description:
      "Outcome of confirming a Coach action card. `checkup.create` returns the created MeasurementReminder DTO; `reminder.note` returns the created CoachReminder id.",
  });
// The request bodies carry their `.meta({ id })` from
// `@/lib/validations/coach-reminder` (single-source with the runtime parse).

// ── Coach conversation history (v1.18.0) ─────────────────────────────
// List + detail + delete surface for the Coach's persisted chat
// conversations. Bodies are stored encrypted at rest; the detail
// endpoint decrypts every message server-side, so the client never
// handles a key. The list endpoint stays metadata-only (no decryption).

// The provenance envelope and the stream frames come from the Coach's own
// wire mirror, which a type test holds equal to the TypeScript contract.

const coachMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z
      .string()
      .describe("Decrypted message body — the server decrypts on read."),
    createdAt: z.iso.datetime({ offset: true }),
    metricSource: coachProvenanceSchema
      .nullable()
      .describe("Provenance envelope (assistant turns); null for user turns."),
    providerType: z
      .string()
      .nullable()
      .describe(
        'Provider that produced the reply (e.g. anthropic, openai, local, refusal). The sentinel `cancelled` marks an empty assistant row closing a turn the client aborted mid-generation (navigation away); clients should render it as an interrupted turn with a retry affordance. v1.39.4 — the sentinel `reuse` marks a turn answered from a table already stored in the conversation (a follow-up chip such as "as a chart"), with no model call: render it as a normal assistant turn without a token footer. Null for user turns.',
      ),
    promptVersion: z
      .string()
      .nullable()
      .describe(
        "Coach prompt version that produced the reply; null for user turns.",
      ),
    tokensUsed: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.18.9 — total tokens this assistant turn cost, persisted so the per-message token footer survives a reload. Null on user turns, refusals, and pre-feature rows.",
      ),
    model: z
      .string()
      .nullable()
      .describe(
        "v1.18.9 — the provider model that produced the reply (e.g. gpt-4o). Null when unknown (user turns, refusals, older rows).",
      ),
  })
  .meta({
    id: "CoachMessage",
    description:
      "One Coach chat message, decrypted server-side. Ordered oldest-first within a conversation.",
  });

const coachConversationAttachmentSchema = z
  .object({
    documentId: z.string(),
    title: z
      .string()
      .nullable()
      .describe(
        "The attached document's resolved title (title, falling back to filename). Null when it has neither. Plaintext; no health values.",
      ),
  })
  .meta({ id: "CoachConversationAttachment" });

const coachConversationSchema = z
  .object({
    id: z.string(),
    title: z.string().describe("Title summarised from the first user message."),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso
      .datetime({ offset: true })
      .describe("Bumped on every appended message; the rail orders by this."),
    messageCount: z.number().int(),
    fenced: z
      .boolean()
      .describe(
        "v1.29.x (S7) — the sticky fence flag. true = a FENCED thread: its turns route through the hardened fenced endpoint (no tools, no health snapshot), never the tool route. Permanent once true. false = a normal health thread.",
      ),
    attachments: z
      .array(coachConversationAttachmentSchema)
      .optional()
      .describe(
        "v1.29.x (S7) — the LIVE set of documents attached to this thread. Empty on a health thread (or a fenced thread whose attachments were all detached).",
      ),
    documentTitle: z
      .string()
      .nullish()
      .describe(
        "v1.29.x (S7) — the FIRST attachment's resolved title, kept for the rail's single-line badge. Null on a health thread or a fenced thread with no live attachment.",
      ),
  })
  .meta({
    id: "CoachConversation",
    description:
      "Lightweight conversation metadata for the history rail. No message bodies — the rail does not decrypt.",
  });

const coachConversationsPageSchema = z
  .object({
    conversations: z.array(coachConversationSchema),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        "Id of the last conversation on this page; pass it back as `cursor` for the next page. Null at the end of the list.",
      ),
  })
  .meta({
    id: "CoachConversationsPage",
    description:
      "Cursor-paginated page of the caller's Coach conversations, most-recent activity first.",
  });

const coachConversationDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    messageCount: z.number().int(),
    messages: z
      .array(coachMessageSchema)
      .describe("Every message in the conversation, decrypted, oldest-first."),
    summary: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Rolling summary of turns elided past the history window; null when none is on file.",
      ),
    fenced: z
      .boolean()
      .describe(
        "v1.29.x (S7) — the sticky fence flag; the client routes a fenced thread's turns through the hardened fenced endpoint, never the tool route.",
      ),
    attachments: z
      .array(coachConversationAttachmentSchema)
      .optional()
      .describe(
        "v1.29.x (S7) — the LIVE set of attached documents (join rows), attach-time order.",
      ),
    attachmentCount: z
      .number()
      .int()
      .describe(
        "v1.29.x (S7) — count of live attachment rows (equal to attachments.length).",
      ),
    documentTitle: z
      .string()
      .nullish()
      .describe(
        "v1.29.x (S7) — the first attachment's resolved title for the rail badge. Null on a health thread.",
      ),
  })
  .meta({
    id: "CoachConversationDetail",
    description:
      "Full conversation with every message decrypted server-side. The client renders the bodies directly; no decryption key is involved.",
  });

const renameCoachConversationRequest = z
  .object({
    title: z
      .string()
      .min(1)
      .max(COACH_CONVERSATION_TITLE_MAX)
      .describe(
        "The new title. Trimmed before validation, so whitespace alone is refused as empty. 1..80 characters.",
      ),
  })
  .meta({
    id: "RenameCoachConversationRequest",
    description:
      "Rename body. Strict — an unrecognised key is refused rather than dropped, which is not how most partial updates on this surface behave.",
  });

const coachConversationDeletedResponse = z.object({
  deleted: z
    .literal(true)
    .describe("Always true on success; a foreign / unknown id is a 404."),
});

const coachAttachmentsResponseSchema = z
  .object({
    attachments: z
      .array(coachConversationAttachmentSchema)
      .describe("The conversation's refreshed live attachment set."),
    fenced: z
      .boolean()
      .describe(
        "The sticky fence flag — always true after an attach; unchanged (stays true) by a detach.",
      ),
  })
  .meta({ id: "CoachAttachments" });

const coachChatRequest = coachChatRequestSchema.meta({
  id: "CoachChatRequest",
  description:
    "Inbound Coach turn. `message` is the user's turn (1–4 000 chars). `conversationId` is omitted to start a new conversation (the server mints a title from the first message) and supplied to continue one. `scope` narrows which metrics the snapshot ships and which window the timeline covers; omitted fields fall back to server defaults. `locale` picks the reply language. `guidedQuestion` carries the clarifying question a message answers (client-side bubble, never persisted). v1.39.4 — `followUp: { messageId, id }` names a follow-up chip the person tapped (send the chip's `label` as `message`); the server resolves the chip from the conversation's latest assistant message, and a chip that is no longer current is treated as a plain message. `clarification: { messageId, choiceId? }` answers a clarifying question, `choiceId` absent when the person typed their own answer. No `userId` field — the owner is narrowed from the session / Bearer.",
});

const anamnesisFactCurrentExistsResponse = {
  "409": {
    description:
      "A current revision already exists for this fact kind. `meta.errorCode` = `anamnesis.fact.currentExists`.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const anamnesisFactNotFoundResponse = {
  "404": {
    description:
      "No current revision with this id exists for the authenticated account.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

export const coachPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/insights/chat": {
    get: {
      tags: ["Insights"],
      summary: "List the caller's Coach conversations",
      description:
        "v1.18.0 — cursor-paginated list of the caller's Coach conversations for the history rail, most-recent activity first. Metadata only (id, title, timestamps, message count); message bodies are not decrypted here. `limit` defaults to 20, capped at 50; pass the returned `nextCursor` back as `cursor` for the next page (null at the end). v1.30.2 — optional `q` narrows the page to conversations whose TITLE contains the text (case-insensitive substring, capped at 200 chars); message bodies are encrypted at rest and are not searched. Never AI-gated: stored conversations are the person's data and stay listable, readable and deletable while the Coach is unavailable for any reason. Auth via cookie or Bearer; the owner is narrowed from the session.",
      parameters: [
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Id of the last conversation on the previous page. Omit for the first page.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          description: "Page size. Defaults to 20, capped at 50.",
        },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 200 },
          description:
            "v1.30.2 — case-insensitive substring filter over the conversation TITLE only (message bodies are encrypted and not searched). Omit for the unfiltered list.",
        },
      ],
      responses: {
        "200": {
          description: "A page of the caller's conversations.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachConversationsPageSchema,
                "CoachConversationsPageResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Insights"],
      summary: "Send a Coach turn (streaming reply)",
      description:
        'v1.18.0 — sends a user turn and streams the assistant reply as Server-Sent Events. The response is `text/event-stream`, not JSON: one `data: <json>\\n\\n` frame per event, each a `CoachStreamEvent` dispatched on `type`. Frames, in the order they arrive: `step` (v1.39.4, live progress while the Coach reads the record: `{ type, step }`, upserted by `step.id` from `running` to `done` / `empty` / `failed`; catalog labels, domains, windows and counts only), `token` (a chunk of reply text: `{ type, token }`), `provenance` (the evidence envelope: `{ type, metricSource }`), `result` (v1.39.4, a table of the values the turn read: `{ type, result }`, zero or more, sent only to the account that owns the conversation), `suggestion` (a cadence-suggestion card: `{ type, suggestion }`), `suggestedAction` (v1.22, a confirm-to-apply action card: `{ type, suggestedAction }`; nothing is created until the person confirms it through `POST /api/coach/suggested-actions`), `clarification` (v1.39.4, the choices when the reply is a clarifying question: `{ type, clarification }`; answer with `clarification` on the next request), `followUps` (v1.39.4, up to three chips under the reply: `{ type, followUps }`; send one back with `followUp` on the next request), `reasoning` (v1.18.9, optional reasoning-summary text: `{ type, text }` — emitted only by reasoning-capable providers; absent otherwise), and `done` (`{ type, conversationId, messageId, usage? }` — v1.18.9 adds the optional `usage` envelope `{ totalTokens, promptTokens?, completionTokens?, model? }`, server-authoritative; clients display it, never recompute), or a single `error` (`{ type, code, message, reason? }`). No frame added after v1.18.9 carries a top-level key an older frame uses, so a client decoding every frame into one flat struct is safe. The HTTP status is 200 even for a provider/refusal outcome — clients dispatch on the `error` frame, not the status. Clients ignore unknown frame types (additive evolution). Omitting `conversationId` starts a new conversation. Requires the `coach` AI capability, checked right after auth: an unavailable Coach is refused with the capability envelope before the stream opens, except a missing provider, which keeps its `coach.provider.none` error frame and adds `reason: "no_provider"`. Budget- and rate-limited. Auth via cookie or Bearer.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachChatRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Server-Sent Events stream: each `data: <json>\\n\\n` frame is one `CoachStreamEvent`. Keepalive comment lines (`: ka`) carry no data and are ignored.",
          content: {
            "text/event-stream": {
              schema: coachStreamEventSchema,
            },
          },
        },
        "403": {
          description: aiRefusal403Description("coach"),
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds the 64 KB cap.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": aiCheckFailedResponse,
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/{id}/messages/{messageId}/results": {
    get: {
      tags: ["Insights"],
      summary: "Read the tables one Coach message read",
      description:
        "v1.39.4 — the tables of values one assistant message read, decrypted server-side for the account that owns the conversation. One entry per table the message's `metricSource.results` lists, in that order: the full `CoachResultTable`, or `{ ref, withheld }` when it is not served — `module_disabled` when the table's domain is switched off for the record now, `unavailable` when the stored tables cannot be read. A message without tables answers an empty list. Fetch lazily, per message, when a table scrolls into view. Never AI-gated: the tables are stored data and stay readable while the Coach is unavailable. A foreign or unknown conversation or message id maps to 404 (never 403). Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
        {
          name: "messageId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Assistant message id within the conversation.",
        },
      ],
      responses: {
        "200": {
          description: "The message's tables, each served whole or withheld.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ results: z.array(coachResultEntrySchema) }),
                "CoachMessageResultsResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Conversation or message not found, or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/{id}/messages/{messageId}/trail": {
    get: {
      tags: ["Insights"],
      summary: "Read the trail text of one Coach message",
      description:
        "v1.41 — the text of one assistant message's trail: the screened reasoning titles and summaries by trail entry (model-written), the fact texts the turn recalled, and a pending fact proposal (the person's own data). The trail's structure (phases, statuses, counts) is plaintext on the message's `metricSource.activity`; this route serves only the text, decrypted for the account that owns the conversation. Fetch lazily when the person opens the trail. A mixed read: while the Coach's text may not be shown for the record, `entries` is empty and the `ai` state rides beside it, but `recalled` and `proposal` are still served, since they are the person's data. While the medications module is off, recalled facts and a proposal that concern a medication are left out. `trail` is null when the message has no trail or nothing in it may be served. A foreign or unknown conversation or message id maps to 404 (never 403). Auth via cookie or a full-access Bearer token.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
        {
          name: "messageId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Assistant message id within the conversation.",
        },
      ],
      responses: {
        "200": {
          description:
            "The trail text, or null when there is none or nothing in it may be served.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  trail: coachTrailSchema.nullable(),
                  ai: aiCapabilityState.describe(
                    "The `coach` capability. While unavailable `trail.entries` is empty.",
                  ),
                }),
                "CoachMessageTrailResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Conversation or message not found, or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/{id}": {
    get: {
      tags: ["Insights"],
      summary: "Read one Coach conversation with all messages",
      description:
        "v1.18.0 — returns one conversation with every message decrypted server-side and ordered oldest-first, plus the rolling `summary` when one is on file. The client renders the bodies directly; no decryption key is involved. A foreign / unknown id maps to 404 (never 403) so the existence channel does not leak across accounts. Never AI-gated: a stored conversation stays readable while the Coach is unavailable. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
      ],
      responses: {
        "200": {
          description: "The conversation with all decrypted messages.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachConversationDetailSchema,
                "CoachConversationDetailResponse",
              ),
            },
          },
        },
        "404": {
          description: "Conversation not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Insights"],
      summary: "Rename one Coach conversation",
      description:
        "Sets the conversation's title. The only field this verb writes — the body is `.strict()`, so an unrecognised key is REFUSED rather than ignored, unlike most partial updates on this surface. The title is trimmed and must be 1..80 characters after trimming. A foreign or unknown id maps to 404 (never 403), so the existence channel does not leak across accounts. Never AI-gated. Auth via cookie or Bearer; the caller is always resolved as themselves, so a conversation in a shared record is not reachable here.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: renameCoachConversationRequest },
        },
      },
      responses: {
        "200": {
          description:
            "The new id and title. Deliberately NOT the full conversation — nothing else changed, and re-sending the messages on a rename would be a large body for no new information.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string(), title: z.string() }),
                "CoachConversationRenamed",
              ),
            },
          },
        },
        "404": {
          description: "Conversation not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "The body failed validation — an empty or over-long title, or an unrecognised key. Multi-issue envelope with `meta.errorCode` = `coach.conversation.invalidTitle`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Delete one Coach conversation",
      description:
        "v1.18.0 — hard-deletes a conversation and every message under it. A foreign / unknown id maps to 404 (never 403). Never AI-gated: erasure works while the Coach is unavailable. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
      ],
      responses: {
        "200": {
          description: "The conversation was deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachConversationDeletedResponse,
                "CoachConversationDeleted",
              ),
            },
          },
        },
        "404": {
          description: "Conversation not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/fenced": {
    post: {
      tags: ["Insights"],
      summary: "Send a FENCED multi-document coach turn (streaming reply)",
      description:
        "v1.29.x (S7) — sends a user turn and streams a grounded prose reply about the documents attached to a coach conversation, as Server-Sent Events (`text/event-stream`: one `data: <json>\\n\\n` frame per event; `token` / `done` / `error`, HTTP 200 even for a provider/refusal outcome). FENCED by construction: NO tools, NO health snapshot; every attached document is fenced as untrusted DATA (per-document header fields marker-scrubbed); answers under the `coach` and `documentAi` capabilities, both re-checked for the single picked provider immediately before anything is sent (403 with the capability envelope when either is closed; `consent.ai.required` when that provider leaves the machine without an `ai_extraction` / `ai_full` receipt; no provider is the `documents.chat.provider.none` error frame); the reply is numerically grounded against the LIVE attachments' figures only. `conversationId` continues an existing fenced thread; `attachmentIds` (first-turn ONLY, min 1, max 5) creates a fresh fenced thread — supplying BOTH is a 422. The body is `.strict()`: `scope` / `guidedQuestion` / `prefill` / `userId` are rejected. A plain tool conversation 404s here. Module-gated on `inboundDocuments`; rate-limited (shared `document-chat` bucket). Renders as plain text (no markdown). Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: fencedChatRequestSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Server-Sent Events stream of `token` / `done` / `error` frames.",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                description:
                  "SSE frames: `data: <json>\\n\\n`. See the operation description for the per-`type` frame shapes.",
              },
            },
          },
        },
        "403": {
          description:
            aiExtractionRefusalDescription("documentAi", "coach") +
            " A 422 (`stdResponses`) covers an un-indexed / unavailable attachment (`coach.fenced.attachmentUnavailable`), the attachment cap (`coach.fenced.attachmentLimit`), or `attachmentIds` sent with a `conversationId` (`coach.fenced.attachmentConflict`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description: AI_EXTRACTION_UNAVAILABLE_DESCRIPTION,
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/{id}/attachments": {
    post: {
      tags: ["Insights"],
      summary: "Attach a document to a coach conversation",
      description:
        "v1.29.x (S7) — attaches one already-stored, content-indexed document to an existing conversation and sets its sticky `documentScoped` flag TRUE (the one legal, privilege-reducing tool→fenced transition; audit-logged when a flip occurs). Validates the document is owned + live + indexed + within the 5-document cap. Idempotent: attaching an already-attached document is a 200. A foreign / unknown conversation or document maps to 404. Module-gated on `inboundDocuments`; answers under the `coach` and `documentAi` capabilities (nothing is sent to a provider here, so a missing provider or consent receipt is left to the next turn); rate-limited. Detaching (DELETE) is never refused for AI reasons: it removes the person\'s own data. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachAttachmentCreateSchema },
        },
      },
      responses: {
        "200": {
          description: "The refreshed live attachment set + the fenced flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachAttachmentsResponseSchema,
                "CoachAttachmentsResponse",
              ),
            },
          },
        },
        "404": {
          description: "Conversation or document not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...aiExtractionRefusals("documentAi", "coach"),
        ...stdResponses,
      },
    },
  },
  "/api/insights/chat/{id}/attachments/{documentId}": {
    delete: {
      tags: ["Insights"],
      summary: "Detach a document from a coach conversation",
      description:
        "v1.29.x (S7) — removes the document from the conversation. The conversation stays FENCED (the sticky flag is never cleared — a thread whose history may contain document-derived text must never regain the tool loop). Detaching the last document leaves a fenced conversation with zero attachments. A missing row / foreign conversation maps to 404. Module-gated on `inboundDocuments`; rate-limited. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Conversation id.",
        },
        {
          name: "documentId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "The attached document's id.",
        },
      ],
      responses: {
        "200": {
          description: "The refreshed live attachment set + the fenced flag.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachAttachmentsResponseSchema,
                "CoachAttachmentsResponseDetach",
              ),
            },
          },
        },
        "404": {
          description: "Attachment or conversation not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/layout": {
    get: {
      tags: ["Insights"],
      summary: "Read the calling user's Insights tile layout",
      description:
        "Returns the per-user Insights tile layout (visibility + order) plus the optimistic-concurrency `updatedAt` token. Falls back to the default layout when the user has not customised it. Mirrors the dashboard-widgets contract.",
      responses: {
        "200": {
          description:
            "The resolved layout (custom or default) plus its token.",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutResult, "InsightsLayout"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Replace the calling user's Insights tile layout",
      description:
        "Persists the full tile layout. The normalised layout plus the advanced `updatedAt` token is returned. Optimistic concurrency (v1.32.21): send `baseUpdatedAt` (the token from a prior read) and the write 409s if the stored row changed since; omit it for the legacy unconditional write. Invalid bodies return the multi-issue 422 envelope, matching the dashboard-widgets route.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: insightsLayoutPutBody },
        },
      },
      responses: {
        "200": {
          description:
            "Layout saved; the normalised layout plus the advanced token is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutResult, "InsightsLayoutSaved"),
            },
          },
        },
        ...conflictResponse409("Insights layout", "insights_layout_conflict"),
        // 422 (multi-issue validation envelope) comes from stdResponses;
        // the base-token variant of it narrows that description afterwards.
        ...stdResponses,
        ...invalidBaseTokenResponse,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Reset the calling user's Insights tile layout",
      description:
        "Clears the persisted layout and returns the default layout. Idempotent.",
      responses: {
        "200": {
          description: "Layout reset; the default layout is returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(insightsLayoutResult, "InsightsLayoutReset"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/facts": {
    get: {
      tags: ["Insights"],
      summary: "List the caller's durable Coach facts",
      description:
        "v1.11.1 — returns the active facts the Coach keeps about the caller (highest-confidence then newest first), each decrypted on the fly. The GDPR 'what do you know about me' surface. v1.41 — each fact carries its source, the message it came from and when it was last used in a turn; a health fact still waiting for the caller's confirmation is not listed. Never AI-gated: the facts stay readable and erasable while the Coach is unavailable for any reason. Auth via cookie or Bearer; the owner is always narrowed from the session, never the body. Undecryptable rows are omitted rather than failing the read.",
      responses: {
        "200": {
          description: "The caller's active facts.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachFactsListResponse, "CoachFactsList"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Insights"],
      summary: "Remember one of the caller's own Coach messages",
      description:
        'v1.41 — the remember button. Saves the named user message as a fact with `source: "user"`: the text is the message the server stored, filed as `medication` or `condition` when it names one, `context` otherwise. The tap is the caller\'s confirmation, so a health message is saved too. A message the caller does not own, or an assistant message, is a 404. Saving the same fact again returns the existing one with `created: false`. Gated on the Coach module, never on AI. Auth via cookie or Bearer.',
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachFactCreateRequest },
        },
      },
      responses: {
        "201": {
          description: "The fact was saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactCreatedResponse,
                "CoachFactCreated",
              ),
            },
          },
        },
        "200": {
          description: "The caller's memory already held this fact.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactCreatedResponse,
                "CoachFactAlreadyKnown",
              ),
            },
          },
        },
        "403": {
          description: MODULE_DISABLED_DESCRIPTION,
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "Message not found or not one of the caller's own.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Forget all of the caller's Coach facts",
      description:
        "v1.11.1 — bulk 'forget what you know about me': soft-deletes every active fact for the caller and returns the count cleared. Idempotent (a second call clears 0). Never AI-gated. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "All active facts cleared; the count is returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactsClearedResponse,
                "CoachFactsCleared",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/facts/{id}": {
    patch: {
      tags: ["Insights"],
      summary: "Edit one Coach fact's wording",
      description:
        'v1.41 — rewrites the text of a fact the caller owns (re-encrypted at rest) and files it by its new wording: text that names a medication moves to `medication`, so the medications module keeps filtering it; other health wording moves a non-health category to `condition`; otherwise the category stays. A health fact the caller edited counts as confirmed (`source: "user"`). A proposal still waiting for the caller\'s confirmation, an unknown, cross-user or deleted id are all a 404. Never AI-gated. Auth via cookie or Bearer.',
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Fact id.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachFactPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The fact after the edit.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactUpdatedResponse,
                "CoachFactUpdated",
              ),
            },
          },
        },
        "404": {
          description: "Fact not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Forget one Coach fact",
      description:
        "v1.11.1 — soft-deletes a single fact owned by the caller. An unknown / cross-user / already-deleted id is an idempotent no-op returning `{ deleted: false }`, never revealing whether the id exists under another account. Never AI-gated. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description:
            "The fact was soft-deleted (`deleted: true`) or the id matched nothing the caller owns (`deleted: false`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachFactDeletedResponse,
                "CoachFactDeleted",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/nudge-status": {
    get: {
      tags: ["Insights"],
      summary: "Whether an unopened Coach message is waiting",
      description:
        "v1.18.6 (CCH-03) — server-authoritative unread signal for the Coach FAB. `unread` is true when the caller's newest Coach ASSISTANT message (a proactive nudge or any reply) is newer than `User.coachLastSeenAt`; a user who has never opened the Coach reads an existing nudge as unread exactly once. `nudgedAt` carries that newest assistant-message timestamp (null when none exists) so the client can key a local seen-mirror on a stable value. Never refused for an AI reason: while the `coach` capability is unavailable the answer is the quiet `{ unread: false, nudgedAt: null, conversationId: null }` with `ai` saying why. Auth via cookie or Bearer; the owner is narrowed from the session.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The current unread state.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  nudgedAt: z.iso
                    .datetime({ offset: true })
                    .nullable()
                    .describe(
                      "Timestamp of the newest Coach assistant message; null when none exists.",
                    ),
                  unread: z
                    .boolean()
                    .describe(
                      "True when that message is newer than the last time the caller opened the Coach.",
                    ),
                  conversationId: z
                    .string()
                    .nullable()
                    .describe(
                      "Conversation holding the newest assistant message; null when none exists. The client deep-links into it (`/coach?c=<id>`) on the unread path.",
                    ),
                  ai: aiCapabilityState.describe(
                    "The `coach` capability. While unavailable the three fields above are the quiet empty values.",
                  ),
                }),
                "CoachNudgeStatus",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/coach/seen": {
    post: {
      tags: ["Insights"],
      summary: "Mark the Coach as opened (clear the unread dot)",
      description:
        "v1.18.6 (CCH-03) — opening the Coach (drawer or full page) stamps `User.coachLastSeenAt = now()`, so `GET /api/insights/coach/nudge-status` then reports no assistant message newer than the stamp and the FAB drops the unread dot. Server-authoritative, so the cleared state follows the caller across web + iOS rather than just the opening device. No request body — the timestamp is server-minted, so a client can never backdate the stamp to suppress a future nudge. Never AI-gated: a timestamp on the caller's own row. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The Coach was marked opened; the stamp is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  seenAt: z.iso
                    .datetime({ offset: true })
                    .describe("The server-minted open timestamp."),
                }),
                "CoachSeenResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/coach/about-me": {
    get: {
      tags: ["Insights"],
      summary: "Read the caller's self-context",
      description:
        "v1.16.0 — returns the structured self-context (free text plus chronic conditions, allergies, coach focus) the Coach system prompt and the daily briefing inject as a delimited, user-provided context block, alongside any pending clarifying questions. Every field is stored encrypted at rest; an undecryptable payload reads as null (fail closed). The questions are the one AI part: stored questions cannot be told apart by origin, so while the `aboutMeQuestions` capability is unavailable an outstanding set is replaced by the deterministic completion hints for the same profile, and `ai` says why. Auth via cookie or Bearer; the owner is always narrowed from the session.",
      responses: {
        "200": {
          description:
            "The stored fields (null when never written / cleared) plus pending clarifying questions.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  aboutMe: z.string().nullable(),
                  conditions: z.string().nullable(),
                  allergies: z.string().nullable(),
                  coachFocus: z.string().nullable(),
                  aiIncludedSections: z.array(healthProfileAiSectionSchema),
                  pendingQuestions: z.array(z.string()),
                  updatedAt: z.iso.datetime({ offset: true }).nullable(),
                  maxChars: z.number().int(),
                  fieldMaxChars: z.number().int(),
                  ai: aiCapabilityState.describe(
                    "The `aboutMeQuestions` capability behind model-written questions.",
                  ),
                }),
                "GetCoachAboutMeResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Write (or clear) the caller's self-context",
      description:
        "v1.16.0 — persists the free text (4 000-char cap) and the three structured fields (500-char cap each) encrypted at rest; caps are enforced before encryption. Structured fields are optional: omitted leaves the stored value untouched, an empty string clears it. After a non-empty save the server derives up to 3 clarifying questions (AI when the `aboutMeQuestions` capability is available and the daily Coach token budget allows, deterministic completion hints otherwise, with no provider call) and returns them as `pendingQuestions`. Rate-limited per user. Optimistic concurrency (v1.32.21): send `baseUpdatedAt` (the `updatedAt` from a prior read) and the write 409s if the stored self-context changed since; omit it for the legacy unconditional write. The token is per-surface (`UserHealthProfile.updatedAt`), so it is not perturbed by unrelated account writes.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: aboutMePutSchema.extend({
              baseUpdatedAt: baseUpdatedAtField,
            }),
          },
        },
      },
      responses: {
        "200": {
          description:
            "The effective (trimmed) state echoed back plus the freshly derived pending questions and the advanced `updatedAt` token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  aboutMe: z.string().nullable(),
                  conditions: z.string().nullable(),
                  allergies: z.string().nullable(),
                  coachFocus: z.string().nullable(),
                  aiIncludedSections: z.array(healthProfileAiSectionSchema),
                  pendingQuestions: z.array(z.string()),
                  updatedAt: z.iso.datetime({ offset: true }),
                  maxChars: z.number().int(),
                  fieldMaxChars: z.number().int(),
                  ai: aiCapabilityState.describe(
                    "The `aboutMeQuestions` capability the derivation ran under.",
                  ),
                }),
                "PutCoachAboutMeResponse",
              ),
            },
          },
        },
        ...conflictResponse409("Self-context", "about_me_conflict"),
        ...stdResponses,
        ...invalidBaseTokenResponse,
      },
    },
  },
  "/api/anamnesis/facts": {
    get: {
      tags: ["Insights"],
      summary: "Read effective-dated anamnesis facts",
      description:
        "Returns the current value and immutable revision history for the caller's smoking status, alcohol pattern and shift schedule. Values are decrypted server-side; unreadable ciphertext returns `value: null` with `unreadable: true`.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Current facts and their revision history.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthProfileFactsResponseSchema,
                "GetAnamnesisFactsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Insights"],
      summary: "Create an anamnesis fact",
      description:
        "Creates the first current revision for one closed fact kind. The answer is encrypted before persistence. A second current value for the same kind returns 409; corrections use the revision endpoint.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: healthProfileFactWriteSchema },
        },
      },
      responses: {
        ...idempotentWrite(),
        "201": {
          description: "The newly created current revision.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthProfileFactDtoSchema,
                "CreateAnamnesisFactResponse",
              ),
            },
          },
        },
        ...anamnesisFactCurrentExistsResponse,
        ...stdResponses,
      },
    },
  },
  "/api/anamnesis/facts/{id}": {
    patch: {
      tags: ["Insights"],
      summary: "Correct a current anamnesis fact",
      description:
        "Closes the current revision at the correction instant and creates a successor. Prior ciphertext and its half-open validity interval remain in history.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: healthProfileFactCorrectionSchema },
        },
      },
      responses: {
        "200": {
          description: "The successor revision.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthProfileFactDtoSchema,
                "CorrectAnamnesisFactResponse",
              ),
            },
          },
        },
        ...anamnesisFactNotFoundResponse,
        ...conflictResponse409("Anamnesis fact", "anamnesis.fact.conflict"),
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Remove a current anamnesis fact",
      description:
        "Closes the caller-owned current revision without deleting its encrypted history. The fact kind then resolves as not recorded until a new value is created. The path revision id is the optimistic concurrency token.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Metadata for the revision whose interval was closed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                removedHealthProfileFactSchema,
                "RemoveAnamnesisFactResponse",
              ),
            },
          },
        },
        ...anamnesisFactNotFoundResponse,
        ...conflictResponse409("Anamnesis fact", "anamnesis.fact.conflict"),
        ...stdResponses,
      },
    },
  },
  "/api/anamnesis/emergency": {
    get: {
      tags: ["Insights"],
      summary: "Read the emergency profile",
      description:
        "Returns the caller's emergency (Notfalldaten) profile: blood type, organ-donor and advance-directive declarations, and the decrypted emergency contacts, implants/devices and ICE note. Free text decrypts fail-soft.",
      responses: {
        "200": {
          description: "The emergency profile (fields null when unset).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                emergencyProfile,
                "GetEmergencyProfileResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Insights"],
      summary: "Update the emergency profile",
      description:
        "Partial edit of the emergency profile on the caller's own record. Free-text fields are AES-256-GCM encrypted before persistence. Audits as `anamnesis.emergency.update`.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateEmergencyProfileRequest },
        },
      },
      responses: {
        "200": {
          description: "The updated emergency profile.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                emergencyProfile,
                "UpdateEmergencyProfileResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/coach/about-me/questions": {
    get: {
      tags: ["Insights"],
      summary: "Read the pending clarifying questions",
      description:
        "v1.16.0 — the up-to-3 clarifying questions derived after the last self-context save. The Coach composer renders them as tappable suggestion chips. Stored encrypted; an undecryptable payload reads as an empty list (fail closed).",
      responses: {
        "200": {
          description: "The pending questions (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ questions: z.array(z.string()) }),
                "GetCoachAboutMeQuestionsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Dismiss pending clarifying questions",
      description:
        "v1.16.0 — dismisses one question (body `{ question }`, exact match) or all of them (empty body). Tapping a chip in the Coach composer inserts the question into the chat input and dismisses it here.",
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              question: z
                .string()
                .optional()
                .describe(
                  "Exact question text to dismiss. Omitted = dismiss all.",
                ),
            }),
          },
        },
      },
      responses: {
        "200": {
          description: "The remaining questions after the dismissal.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ questions: z.array(z.string()) }),
                "DeleteCoachAboutMeQuestionsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/coach/about-me/adopt": {
    post: {
      tags: ["Insights"],
      summary: "Fold an answer back into the stored self-context",
      description:
        'v1.16.4 — closes the clarifying-question loop. The Coach composer\'s chips insert a question the person answers in their own words; this endpoint moves that answer out of the chat transcript and into the matching structured self-context field.\n\n**Which field it lands on is inferred from the wording, not chosen by the caller.** The server keyword-matches allergy and condition stems across the six UI locales; anything else lands on `coachFocus`, the generic "worth knowing" slot. `question` is optional — the remember action on a chat message sends only the message text, and the field is then matched from that text. The chosen field is reported back so the client can say where it went.\n\n**Append, never replace.** Existing text stays and the answer joins on its own line, encrypted at rest. A structured field at its 500-character cap overflows into the free-text `aboutMe` instead of failing; only when THAT is full too does the write refuse.\n\n**A duplicate is a success, not an error.** An answer already contained in the target field or in `aboutMe` returns 200 with `adopted: false` and `reason: "duplicate"`, so tapping the offer twice cannot stack the same prose. Containment is checked case-insensitively on whitespace-collapsed text, so a near-identical rephrasing IS adopted as a second line.\n\nThe read-modify-write runs under a row lock, so two concurrent adoptions cannot lose an append or miss each other\'s dedupe. Audit rows carry the field name and the answer\'s LENGTH — never the text, which is free-form health prose. Coach-module-gated; rate-limited to 30 per minute per user; body cap 16 KiB.',
      requestBody: {
        required: true,
        content: { "application/json": { schema: aboutMeAdoptRequest } },
      },
      responses: {
        "200": {
          description:
            'The adoption resolved. `adopted: true` means the text was appended; `adopted: false` with `reason: "duplicate"` means it was already there and nothing was written.',
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  adopted: z.boolean(),
                  field: z
                    .enum(["conditions", "allergies", "coachFocus", "aboutMe"])
                    .describe(
                      "Where the answer went. `aboutMe` appears when the matched structured field was at its cap and the text overflowed into the free-text slot.",
                    ),
                  reason: z
                    .literal("duplicate")
                    .optional()
                    .describe("Present only on the `adopted: false` arm."),
                }),
                "CoachAboutMeAdoptResponse",
              ),
            },
          },
        },
        "403": {
          description: MODULE_DISABLED_DESCRIPTION,
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 16 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Either the body failed validation (every issue is listed), or the self-context is FULL — the matched field and the 4000-character `aboutMe` are both at their caps, so there is nowhere to put the answer. The two are told apart by the presence of the issue list.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/coach/plans": {
    get: {
      tags: ["Insights"],
      summary: "List the caller's Coach goal / if-then plans",
      description:
        'v1.21.3 — returns the durable plans the Coach has proposed for the caller, newest first, each decrypted on the fly. A plan is an "if-then" implementation intention tied to one metric, with an optional target. The Coach extractor writes a plan as `proposed`; only `PATCH /api/coach/plans/{id}` activates it. Pass `?status=` to filter to one lifecycle status, or `?scope=` for a named group (open = proposed + active + review_due, past = met + abandoned + reviewed, all = every non-deleted plan) — mutually exclusive. Both omitted returns the non-terminal set (proposed + active). Not gated on the Coach: the plans belong to the caller and stay readable while the Coach is unavailable (v1.39). Auth via cookie or Bearer; the owner is always narrowed from the session, never the body. Undecryptable rows are omitted rather than failing the read.',
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: [...COACH_PLAN_STATUSES] },
          description:
            "Filter to a single lifecycle status. Mutually exclusive with `scope`. Omit both for the non-terminal set (proposed + active).",
        },
        {
          name: "scope",
          in: "query",
          required: false,
          schema: { type: "string", enum: [...COACH_PLAN_SCOPES] },
          description:
            "Named status group: open (proposed + active + review_due), past (met + abandoned + reviewed), or all. Mutually exclusive with `status`.",
        },
      ],
      responses: {
        "200": {
          description: "The caller's plans.",
          content: {
            "application/json": {
              schema: dataEnvelope(coachPlansListResponse, "CoachPlansList"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/coach/plans/{id}": {
    patch: {
      tags: ["Insights"],
      summary: "Confirm or update a Coach plan's lifecycle",
      description:
        "v1.21.3 — confirm a proposed plan (status proposed → active) or mark it met / abandoned, and optionally set / clear a review date. The body carries ONLY lifecycle fields — never the metric or the encrypted free text — so a client can change a plan's status but never inject or overwrite its prose. A foreign / unknown / already-deleted id maps to 404 (never 403) so the existence channel does not leak across accounts. Coach-gated. Auth via cookie or Bearer; the owner is narrowed from the session.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Plan id.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachPlanPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The plan after the lifecycle update.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachPlanUpdatedResponse,
                "CoachPlanUpdated",
              ),
            },
          },
        },
        "403": {
          description: "Coach surface disabled.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "Plan not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Soft-delete one Coach plan",
      description:
        "v1.21.3 — soft-deletes a single plan owned by the caller. An unknown / cross-user / already-deleted id is an idempotent no-op returning `{ deleted: false }`, never revealing whether the id exists under another account. Not gated on the Coach: erasing one's own plan works while the Coach is unavailable (v1.39). Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Plan id.",
        },
      ],
      responses: {
        "200": {
          description:
            "The plan was soft-deleted (`deleted: true`) or the id matched nothing the caller owns (`deleted: false`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachPlanDeletedResponse,
                "CoachPlanDeleted",
              ),
            },
          },
        },
        "403": {
          description: "Coach surface disabled.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};

export const coachReminderPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/coach/reminders": {
    get: {
      tags: ["Insights"],
      summary: "List the caller's Coach reminders",
      description:
        'v1.22 (B2/B6) — the durable "remind me about X" memory the Coach captured inline, decrypted on the fly, soonest-due first. Pass `?status=` (one status or a comma set like `due,surfaced` for the in-app tile); omitted returns the non-terminal set (proposed + active + due + surfaced). Not gated on the Coach: the reminders belong to the caller and stay readable while the Coach is unavailable (v1.39). Auth via cookie or Bearer; the owner is narrowed from the session. Undecryptable rows are omitted.',
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Filter to one status or a comma-separated set (proposed | active | due | surfaced | done | dismissed). Omit for the non-terminal set.",
        },
      ],
      responses: {
        "200": {
          description: "The caller's reminders.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachRemindersListResponse,
                "CoachRemindersList",
              ),
            },
          },
        },
        // The read is delegable and the create beside it is not, so only this
        // one answers the sharing refusal. It asks no Coach gate.
        ...recordRefusal(),
        ...stdResponses,
      },
    },
    post: {
      tags: ["Insights"],
      summary: "Create a Coach reminder manually",
      description:
        "v1.22 — create a reminder from the ledger. `note` is the only writable content; `when` is the closed grammar (ISO date | +Nd / +Nw | a context cue) resolved into the trigger server-side; `metric` optional. The per-user cap returns 409 when the non-terminal set is full. Coach-gated. Auth via cookie or Bearer; the owner is narrowed from the session.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachReminderCreateSchema },
        },
      },
      responses: {
        "201": {
          description: "The created reminder.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachReminderCreatedResponse,
                "CoachReminderCreated",
              ),
            },
          },
        },
        "403": {
          description: "Coach surface disabled.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "The per-user reminder cap is full.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/coach/reminders/{id}": {
    patch: {
      tags: ["Insights"],
      summary: "Confirm or update a Coach reminder's lifecycle",
      description:
        "v1.22 — confirm a proposed reminder (→ active), mark it done / dismissed, or re-schedule via the closed `when` grammar (null clears the due moment). The body never carries the note text. A foreign / unknown / already-deleted id maps to 404 (never 403) so the existence channel does not leak. Coach-gated. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Reminder id.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachReminderPatchSchema },
        },
      },
      responses: {
        "200": {
          description: "The reminder after the lifecycle update.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachReminderUpdatedResponse,
                "CoachReminderUpdated",
              ),
            },
          },
        },
        "403": {
          description: "Coach surface disabled.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "Reminder not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Insights"],
      summary: "Soft-delete one Coach reminder",
      description:
        "v1.22 — soft-deletes a single reminder owned by the caller. An unknown / cross-user / already-deleted id is an idempotent no-op returning `{ deleted: false }`. Not gated on the Coach: erasing a stored reminder works while the Coach is unavailable (v1.39). Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Reminder id.",
        },
      ],
      responses: {
        "200": {
          description:
            "The reminder was soft-deleted (`deleted: true`) or the id matched nothing the caller owns (`deleted: false`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                coachReminderDeletedResponse,
                "CoachReminderDeleted",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

export const coachSuggestedActionPaths: NonNullable<ZodOpenApiObject["paths"]> =
  {
    "/api/coach/suggested-actions": {
      post: {
        tags: ["Insights"],
        summary: "Confirm a Coach action card",
        description:
          'v1.22 (F6) — the confirm half of the generalised propose→confirm moat. `actionType` is from the CLOSED allowlist (checkup.create | reminder.note) — NEVER a medication or clinical change. `checkup.create` builds a preventive-care Vorsorge `MeasurementReminder` (free-text label + a closed interval id resolved to an RRULE server-side); `reminder.note` builds a `CoachReminder`. Nothing is created without this explicit confirm. Coach-gated (`requireModuleEnabled("coach")`); per-user rate-limited (429). Auth via cookie or Bearer; the owner is narrowed from the session, built field-by-field — no mass assignment, no IDOR.',
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: coachSuggestedActionSchema },
          },
        },
        responses: {
          "201": {
            description: "The action was applied (entity created server-side).",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  coachSuggestedActionResultResponse,
                  "CoachSuggestedActionResultCreated",
                ),
              },
            },
          },
          "403": {
            description: "Coach surface disabled.",
            content: { "application/json": { schema: errorEnvelope } },
          },
          "409": {
            description: "The per-user reminder cap is full (reminder.note).",
            content: { "application/json": { schema: errorEnvelope } },
          },
          ...stdResponses,
        },
      },
    },
  };

export const coachFeedbackPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/insights/chat/messages/{id}/feedback": {
    post: {
      tags: ["Insights"],
      summary: "Rate a Coach assistant message",
      description:
        "Persists a helpful/unhelpful rating for a single Coach reply. Reuses the v1.4.16 RecommendationFeedback table via the polymorphic `targetType` column. The aggregator buckets ratings by (promptVersion, tone, verbosity). Never AI-gated: a rating on a message that already exists calls no model.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachMessageFeedbackBody },
        },
      },
      responses: {
        "201": {
          description: "Feedback saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  createdAt: z.iso.datetime({ offset: true }),
                }),
                "CoachMessageFeedbackResponse",
              ),
            },
          },
        },
        "404": {
          description: "Message not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "Caller has already rated this message text.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
