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
import { COACH_PLAN_STATUSES } from "@/lib/ai/coach/plans";
import {
  COACH_PLAN_SCOPES,
  coachPlanPatchSchema,
} from "@/lib/validations/coach-plan";
import { coachChatRequestSchema } from "@/lib/ai/coach/types";
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

// ── Coach facts (v1.11.1) ────────────────────────────────────────────
// Read + delete surface for the durable facts the Coach extracts. Facts
// are server-extracted, not user-authored, so there is no create/update
// shape — only list, bulk-clear, and single-delete responses.

const coachFactItem = z.object({
  id: z.string(),
  category: z
    .enum(COACH_FACT_CATEGORIES)
    .describe(
      "App-side closed category: preference | condition | goal | constraint | context.",
    ),
  text: z.string().describe("Decrypted fact text."),
  confidence: z
    .number()
    .int()
    .describe("0..100 server-assigned extraction confidence."),
  createdAt: z.iso.datetime({ offset: true }),
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

const coachProvenanceSchema = z
  .object({
    windows: z
      .array(
        z.enum([
          "last7days",
          "last30days",
          "last90days",
          "lastYear",
          "allTime",
        ]),
      )
      .describe("Analysis windows the assistant drew on this turn."),
    metrics: z
      .array(z.string())
      .describe(
        "Stable metric-topic keys referenced (e.g. bp, weight, sleep, glucose). `general` is the empty-snapshot sentinel. The client translates these labels; the server never localises them.",
      ),
    counts: z
      .record(z.string(), z.number().int())
      .optional()
      .describe(
        "Per-metric sample-count summary; absent on an empty snapshot.",
      ),
    keyValues: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          unit: z.string().optional(),
          window: z.string().optional(),
        }),
      )
      .optional()
      .describe(
        "Load-bearing numbers the assistant surfaced, rendered in the collapsible evidence block. Hard-capped at 8 entries.",
      ),
    toolCalls: z
      .array(
        z.object({
          name: z.string(),
          present: z.boolean(),
        }),
      )
      .optional()
      .describe(
        "v1.20.0 — the retrieval-tool trace for this turn: which tools the Coach called and whether each found data. Metadata only (no values). Absent on the legacy snapshot path and on turns that called no tools.",
      ),
    unverifiedFigures: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "v1.32.14 — count of numeric tokens the grounding guard withheld from this reply (each rewritten to the editorial elision mark). Drives the quiet per-message notice. Count only, never the withheld values. Absent when the turn withheld nothing.",
      ),
  })
  .meta({
    id: "CoachProvenance",
    description:
      "Provenance envelope attached to an assistant message — labels and counts only, plus the optional evidence key-values. No raw timestamps.",
  });

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
        "Provider that produced the reply (e.g. anthropic, openai, local, refusal). The sentinel `cancelled` marks an empty assistant row closing a turn the client aborted mid-generation (navigation away); clients should render it as an interrupted turn with a retry affordance. Null for user turns.",
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
    "Inbound Coach turn. `message` is the user's turn (1–4 000 chars). `conversationId` is omitted to start a new conversation (the server mints a title from the first message) and supplied to continue one. `scope` narrows which metrics the snapshot ships and which window the timeline covers; omitted fields fall back to server defaults. `locale` picks the reply language. `guidedQuestion` carries the clarifying question a message answers (client-side bubble, never persisted). No `userId` field — the owner is narrowed from the session / Bearer.",
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
        'v1.18.0 — cursor-paginated list of the caller\'s Coach conversations for the history rail, most-recent activity first. Metadata only (id, title, timestamps, message count); message bodies are not decrypted here. `limit` defaults to 20, capped at 50; pass the returned `nextCursor` back as `cursor` for the next page (null at the end). v1.30.2 — optional `q` narrows the page to conversations whose TITLE contains the text (case-insensitive substring, capped at 200 chars); message bodies are encrypted at rest and are not searched. Coach-gated (`requireAssistantSurface("coach")`); a disabled surface 403s. Auth via cookie or Bearer; the owner is narrowed from the session.',
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
        "v1.18.0 — sends a user turn and streams the assistant reply as Server-Sent Events. The response is `text/event-stream`, not JSON: one `data: <json>\\n\\n` frame per event. Frame `type` is one of `token` (a chunk of reply text: `{ type, token }`), `provenance` (the evidence envelope: `{ type, metricSource }`), `suggestion` (a cadence-suggestion card: `{ type, suggestion }`), `reasoning` (v1.18.9, optional reasoning-summary text: `{ type, text }` — emitted only by reasoning-capable providers; absent otherwise), `done` (`{ type, conversationId, messageId, usage? }` — v1.18.9 adds the optional `usage` envelope `{ totalTokens, promptTokens?, completionTokens?, model? }`, server-authoritative; clients display it, never recompute), or `error` (`{ type, code, message }`). The HTTP status is 200 even for a provider/refusal outcome — clients dispatch on the `error` frame, not the status. Clients ignore unknown frame types (additive evolution). Omitting `conversationId` starts a new conversation. Coach-gated; budget- and rate-limited. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: coachChatRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Server-Sent Events stream of `token` / `provenance` / `done` / `error` frames.",
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
            "Coach surface disabled (`errorCode: assistant.disabled.coach`) or AI consent required (`errorCode: consent.ai.required`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds the 64 KB cap.",
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
        "v1.18.0 — returns one conversation with every message decrypted server-side and ordered oldest-first, plus the rolling `summary` when one is on file. The client renders the bodies directly; no decryption key is involved. A foreign / unknown id maps to 404 (never 403) so the existence channel does not leak across accounts. Coach-gated. Auth via cookie or Bearer.",
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
        "Sets the conversation's title. The only field this verb writes — the body is `.strict()`, so an unrecognised key is REFUSED rather than ignored, unlike most partial updates on this surface. The title is trimmed and must be 1..80 characters after trimming. A foreign or unknown id maps to 404 (never 403), so the existence channel does not leak across accounts. Coach-gated. Auth via cookie or Bearer; the caller is always resolved as themselves, so a conversation in a shared record is not reachable here.",
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
        "v1.18.0 — hard-deletes a conversation and every message under it. A foreign / unknown id maps to 404 (never 403). Coach-gated. Auth via cookie or Bearer.",
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
        "v1.29.x (S7) — sends a user turn and streams a grounded prose reply about the documents attached to a coach conversation, as Server-Sent Events (`text/event-stream`: one `data: <json>\\n\\n` frame per event; `token` / `done` / `error`, HTTP 200 even for a provider/refusal outcome). FENCED by construction: NO tools, NO health snapshot; every attached document is fenced as untrusted DATA (per-document header fields marker-scrubbed); the single picked provider is egress-consent-checked once per attached document (403 `consent.ai.required` if any fails); the reply is numerically grounded against the LIVE attachments' figures only. `conversationId` continues an existing fenced thread; `attachmentIds` (first-turn ONLY, min 1, max 5) creates a fresh fenced thread — supplying BOTH is a 422. The body is `.strict()`: `scope` / `guidedQuestion` / `prefill` / `userId` are rejected. A plain tool conversation 404s here. Module-gated on `inboundDocuments`; rate-limited (shared `document-chat` bucket). Renders as plain text (no markdown). Auth via cookie or Bearer.",
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
            "AI consent required for an external provider (`errorCode: consent.ai.required`). A 422 (`stdResponses`) covers an un-indexed / unavailable attachment (`coach.fenced.attachmentUnavailable`), the attachment cap (`coach.fenced.attachmentLimit`), or `attachmentIds` sent with a `conversationId` (`coach.fenced.attachmentConflict`).",
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
        "v1.29.x (S7) — attaches one already-stored, content-indexed document to an existing conversation and sets its sticky `documentScoped` flag TRUE (the one legal, privilege-reducing tool→fenced transition; audit-logged when a flip occurs). Validates the document is owned + live + indexed + within the 5-document cap. Idempotent: attaching an already-attached document is a 200. A foreign / unknown conversation or document maps to 404. Module-gated on `inboundDocuments`; rate-limited. Auth via cookie or Bearer.",
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
        "v1.11.1 — returns the active facts the Coach has extracted about the caller (highest-confidence then newest first), each decrypted on the fly. The GDPR 'what do you know about me' surface. Coach-gated (`requireAssistantSurface(\"coach\")`). Auth via cookie or Bearer; the owner is always narrowed from the session, never the body. Undecryptable rows are omitted rather than failing the read.",
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
    delete: {
      tags: ["Insights"],
      summary: "Forget all of the caller's Coach facts",
      description:
        "v1.11.1 — bulk 'forget what you know about me': soft-deletes every active fact for the caller and returns the count cleared. Idempotent (a second call clears 0). Coach-gated. Auth via cookie or Bearer.",
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
    delete: {
      tags: ["Insights"],
      summary: "Forget one Coach fact",
      description:
        "v1.11.1 — soft-deletes a single fact owned by the caller. An unknown / cross-user / already-deleted id is an idempotent no-op returning `{ deleted: false }`, never revealing whether the id exists under another account. Coach-gated. Auth via cookie or Bearer.",
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
        'v1.18.6 (CCH-03) — server-authoritative unread signal for the Coach FAB. `unread` is true when the caller\'s newest Coach ASSISTANT message (a proactive nudge or any reply) is newer than `User.coachLastSeenAt`; a user who has never opened the Coach reads an existing nudge as unread exactly once. `nudgedAt` carries that newest assistant-message timestamp (null when none exists) so the client can key a local seen-mirror on a stable value. Coach-gated (`requireAssistantSurface("coach")`); a disabled surface 403s. Auth via cookie or Bearer; the owner is narrowed from the session.',
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
        "v1.18.6 (CCH-03) — opening the Coach (drawer or full page) stamps `User.coachLastSeenAt = now()`, so `GET /api/insights/coach/nudge-status` then reports no assistant message newer than the stamp and the FAB drops the unread dot. Server-authoritative, so the cleared state follows the caller across web + iOS rather than just the opening device. No request body — the timestamp is server-minted, so a client can never backdate the stamp to suppress a future nudge. Coach-gated; a disabled surface 403s. Auth via cookie or Bearer.",
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
        "v1.16.0 — returns the structured self-context (free text plus chronic conditions, allergies, coach focus) the Coach system prompt and the daily briefing inject as a delimited, user-provided context block, alongside any pending clarifying questions. Every field is stored encrypted at rest; an undecryptable payload reads as null (fail closed). Auth via cookie or Bearer; the owner is always narrowed from the session.",
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
        "v1.16.0 — persists the free text (4 000-char cap) and the three structured fields (500-char cap each) encrypted at rest; caps are enforced before encryption. Structured fields are optional: omitted leaves the stored value untouched, an empty string clears it. After a non-empty save the server derives up to 3 clarifying questions (AI when a provider and the daily Coach token budget allow, deterministic completion hints otherwise) and returns them as `pendingQuestions`. Rate-limited per user. Optimistic concurrency (v1.32.21): send `baseUpdatedAt` (the `updatedAt` from a prior read) and the write 409s if the stored self-context changed since; omit it for the legacy unconditional write. The token is per-surface (`UserHealthProfile.updatedAt`), so it is not perturbed by unrelated account writes.",
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
        'v1.21.3 — returns the durable plans the Coach has proposed for the caller, newest first, each decrypted on the fly. A plan is an "if-then" implementation intention tied to one metric, with an optional target. The Coach extractor writes a plan as `proposed`; only `PATCH /api/coach/plans/{id}` activates it. Pass `?status=` to filter to one lifecycle status, or `?scope=` for a named group (open = proposed + active + review_due, past = met + abandoned + reviewed, all = every non-deleted plan) — mutually exclusive. Both omitted returns the non-terminal set (proposed + active). Coach-gated (`requireModuleEnabled("coach")`); a disabled surface 403s. Auth via cookie or Bearer; the owner is always narrowed from the session, never the body. Undecryptable rows are omitted rather than failing the read.',
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
        "403": {
          description: "Coach surface disabled.",
          content: { "application/json": { schema: errorEnvelope } },
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
        "v1.21.3 — soft-deletes a single plan owned by the caller. An unknown / cross-user / already-deleted id is an idempotent no-op returning `{ deleted: false }`, never revealing whether the id exists under another account. Coach-gated. Auth via cookie or Bearer.",
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
        'v1.22 (B2/B6) — the durable "remind me about X" memory the Coach captured inline, decrypted on the fly, soonest-due first. Pass `?status=` (one status or a comma set like `due,surfaced` for the in-app tile); omitted returns the non-terminal set (proposed + active + due + surfaced). Coach-gated (`requireModuleEnabled("coach")`). Auth via cookie or Bearer; the owner is narrowed from the session. Undecryptable rows are omitted.',
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
        // one shares its 403 with the sharing refusal.
        ...recordRefusal("Coach surface disabled."),
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
        "v1.22 — soft-deletes a single reminder owned by the caller. An unknown / cross-user / already-deleted id is an idempotent no-op returning `{ deleted: false }`. Coach-gated. Auth via cookie or Bearer.",
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
        "403": {
          description: "Coach surface disabled.",
          content: { "application/json": { schema: errorEnvelope } },
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
        "Persists a helpful/unhelpful rating for a single Coach reply. Reuses the v1.4.16 RecommendationFeedback table via the polymorphic `targetType` column. The aggregator buckets ratings by (promptVersion, tone, verbosity).",
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
