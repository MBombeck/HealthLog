/**
 * OpenAPI route table — the mood surface: entry CRUD (list, create, single
 * read/edit/delete, restore, bulk delete), the bulk backfill, the linked-day
 * read, and mood-tag taxonomy management (catalog read, custom tags, custom
 * groups, per-user layout, catalogue hide).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Request schemas come from `src/lib/validations/mood.ts` and
 * `src/lib/mood/{custom-tags,tag-layout}.ts` where they are shared with the
 * runtime request parsing, so the wire contract stays single-source. Response
 * DTOs are declared here mirroring the route handlers under
 * `src/app/api/mood-entries/` and `src/app/api/mood/`.
 *
 * v1.13.0 shipped the custom-tag CRUD + hide surface outside the YAML;
 * v1.17.0 adds groups + layout and registers the WHOLE taxonomy surface so
 * the iOS client gets a locked contract. The entry CRUD family itself and
 * the linked-day read joined the published document later — they predated
 * the contract surface and had been served unpublished while their bulk
 * twin was in the YAML, which left grant-scope reviewers unable to see the
 * cross-section read at all.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  createCustomTagSchema,
  updateCustomTagSchema,
  createCustomGroupSchema,
  updateCustomGroupSchema,
  hideCatalogueTagSchema,
} from "@/lib/mood/custom-tags";
import { moodTagLayoutSchema } from "@/lib/mood/tag-layout";
import {
  createMoodEntrySchema,
  listMoodEntriesSchema,
  moodLevelEnum,
  moodSourceEnum,
  updateMoodEntrySchema,
} from "@/lib/validations/mood";
import {
  CONTACT_CIRCLE_KEYS,
  CONTACT_EXTENT_KEYS,
  CONTACT_FORM_KEYS,
  EVENT_TYPE_KEYS,
  LEISURE_CATEGORY_KEYS,
  WORK_STATUS_KEYS,
} from "@/lib/mood/context-vocabulary";
import {
  MODULE_DISABLED_DESCRIPTION,
  baseUpdatedAtField,
  conflictResponse409,
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  invalidBaseTokenResponse,
  moduleDisabledResponse,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
  updatedAtTokenField,
} from "./shared";

// ── Request schemas — annotated for spec emission ────────────────────
//
// Assigned rather than annotated in place: Zod 4's `.meta()` returns a NEW
// instance carrying the id, so the route table below must reference these
// consts for the names to reach `components.schemas`.

const createMoodTagRequest = createCustomTagSchema.meta({
  id: "CreateMoodTagRequest",
  description:
    "Create a per-user custom mood tag (BINARY only). `label` is encrypted at rest. `icon` must come from the curated allowlist (unknown name → 422). `categoryKey` picks the home group — any seeded category key or one of the caller's own `customcat:` group keys; omitted → the seeded `custom` category. Capped at 50 active custom tags per user (422).",
});

const updateMoodTagRequest = updateCustomTagSchema.meta({
  id: "UpdateMoodTagRequest",
  description:
    "Partial custom-tag edit; at least one field required. `isActive:false` archives (history intact), `isActive:true` restores. `categoryKey` moves the tag to another group (a real categoryId move).",
});

const createMoodTagGroupRequest = createCustomGroupSchema.meta({
  id: "CreateMoodTagGroupRequest",
  description:
    "Create a per-user custom mood-tag group. `label` is encrypted at rest; `icon` must come from the curated allowlist. Capped at 12 active custom groups per user (422).",
});

const updateMoodTagGroupRequest = updateCustomGroupSchema.meta({
  id: "UpdateMoodTagGroupRequest",
  description:
    "Partial custom-group edit; at least one field required. `isActive:false` retires the group without touching its tags.",
});

const hideMoodTagRequest = hideCatalogueTagSchema.meta({
  id: "HideMoodTagRequest",
  description:
    "Hide / show a CATALOGUE tag for the calling user. Custom tags are hidden via their own `isActive` flag on the custom PATCH instead (this route 400s a `custom:` key).",
});

const createMoodEntryRequest = createMoodEntrySchema.meta({
  id: "CreateMoodEntryRequest",
  description:
    "Single mood-entry create. `mood` is the five-point label; the server derives `score` (1-5) and pleasantness `a1` from it, so a one-tap check-in writes a complete entry. `a1`-`a5` are the level-A self-state values (0-10): absent says nothing, a number is the answer, an explicit null takes an answer back (`a1` falls back to the derivation instead of clearing). With `externalId` the create UPSERTS on `(userId, source, externalId)` — the idempotent re-post iOS drives over Bearer; without it a same-`(date, moodLoggedAt)` re-post 409s. `moodLoggedAt` is bounded: no future instants beyond a 5-min clock-skew tolerance, nothing before 1900.",
});

const updateMoodEntryRequest = updateMoodEntrySchema.meta({
  id: "UpdateMoodEntryRequest",
  description:
    "Per-field mood-entry edit. Omitted fields keep the stored value. `tagKeys`, `ratedFactors` and `context` replace their whole set when present (`null` clears). `a2`-`a5`: explicit null clears; `a1` null re-derives from the label. Editing `mood` without `a1` re-derives pleasantness the same way it re-derives `score`. Editing `moodLoggedAt` re-anchors the row's `date` (and `tz`) to the account's display timezone.",
});

const listMoodEntriesQuery = listMoodEntriesSchema.meta({
  id: "ListMoodEntriesQuery",
  description:
    "Filters + paging for the mood-entry list. `from` / `to` bound the local-day `date` label (YYYY-MM-DD, inclusive). `limit` capped at 500.",
});

/**
 * Exported for the forced registration in `./index.ts`.
 *
 * Both consumers are an `.extend()` of this base, and `.extend()` builds a new
 * object rather than a reference, so the name never carries forward on its own
 * even though the annotation is in the assigning form. Same shape as
 * `CoachPrefs` and `Medication`, and the same remedy.
 */
export const moodTagLayout = moodTagLayoutSchema.meta({
  id: "MoodTagLayout",
  description:
    "Per-user mood-tag presentation blob. `groupOrder`: category keys in display order (unknown dropped, missing appended in seeded order). `placements`: categoryKey → ordered tag keys; a placed tag renders in that group at that index, un-placed tags follow in their home category. Display-only — placements referencing hidden/archived/unknown keys are silently dropped at read time. Both fields optional: PUT merges preserve-when-absent.",
});

// ── Response DTOs ─────────────────────────────────────────────────────

const moodTagDto = z
  .object({
    key: z.string(),
    labelKey: z.string().nullable(),
    label: z.string().nullable(),
    icon: z.string().nullable(),
    kind: z.enum(["BINARY", "RATED"]),
    scaleMin: z.number().int(),
    scaleMax: z.number().int(),
    inverse: z.boolean(),
    custom: z.boolean(),
    hidden: z
      .boolean()
      .optional()
      .describe(
        "Catalogue tags only, present when `include` contains `hidden`.",
      ),
    archived: z
      .boolean()
      .optional()
      .describe(
        "Custom tags only, present when `include` contains `archived`.",
      ),
    usageCount: z
      .number()
      .int()
      .optional()
      .describe(
        "Live-entry link count for this user, present when `include` contains `usage`.",
      ),
  })
  .meta({
    id: "MoodTagDTO",
    description:
      "One effective mood tag. Render `label` when `custom`, else resolve `labelKey` against the locale.",
  });

const moodTagCategoryDto = z
  .object({
    key: z.string(),
    labelKey: z.string().nullable(),
    label: z.string().nullable(),
    icon: z.string().nullable(),
    custom: z.boolean(),
    tags: z.array(moodTagDto),
  })
  .meta({
    id: "MoodTagCategoryDTO",
    description:
      "One group of the effective tree, already per-user ordered (layout applied server-side). `custom: true` = the caller's own group (render `label`); seeded groups resolve `labelKey`.",
  });

const moodTagTreeResponse = z.object({
  categories: z.array(moodTagCategoryDto),
});

const moodCustomTagResponse = z.object({
  key: z.string(),
  labelKey: z.null(),
  label: z.string().nullable(),
  icon: z.string().nullable(),
  kind: z.enum(["BINARY", "RATED"]),
  scaleMin: z.number().int(),
  scaleMax: z.number().int(),
  inverse: z.boolean(),
  custom: z.literal(true),
});

const moodCustomTagPatchResponse = moodCustomTagResponse.extend({
  isActive: z.boolean(),
});

const moodTagGroupResponse = z.object({
  key: z.string(),
  labelKey: z.null(),
  label: z.string().nullable(),
  icon: z.string().nullable(),
  custom: z.literal(true),
});

const moodTagGroupPatchResponse = moodTagGroupResponse.extend({
  isActive: z.boolean(),
});

const moodTagLayoutResolved = z
  .object({
    groupOrder: z.array(z.string()),
    placements: z.record(z.string(), z.array(z.string())),
    // v1.32.22 (M2) — optimistic-concurrency token echoed on GET / PUT.
    updatedAt: updatedAtTokenField,
  })
  .meta({
    id: "MoodTagLayoutResolved",
    description:
      "The stored layout merged over defaults: `groupOrder` fully resolved against the user's effective category set, `placements` as stored. `updatedAt` is the optimistic-concurrency token — echo it as `baseUpdatedAt` on the next PUT.",
  });

// v1.32.22 (M2) — the PUT request extends the layout schema with the base
// token (stripped pre-Zod at runtime).
const moodTagLayoutPutRequest = moodTagLayout
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "MoodTagLayoutPutRequest",
    description:
      "Mood-tag layout to merge (preserve-when-absent), plus the optional optimistic-concurrency `baseUpdatedAt` token. The two manage cards write different fields of the same blob; echo the token to have a stale write refused with 409 instead of resurrecting the other card's overwritten field. Omit it for the legacy unconditional write.",
  });

const notFoundResponse = {
  "404": {
    description: "Not found / not owned by the caller.",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

/**
 * v1.38 — the day's context on a mood entry, in the one shape both the write
 * path and the sync feed use.
 *
 * Every field optional and nullable. The two multi-selects are closed key
 * lists; a value outside them is refused rather than stored, which is what
 * keeps the analytics and the six locale label sets from drifting apart from
 * the data.
 *
 * Exported so `./sync.ts` publishes the same object rather than declaring a
 * second one — two definitions of one payload is how a client ends up decoding
 * a field the server stopped sending.
 */
export const moodContextWire = z
  .object({
    workStatus: z
      .enum(WORK_STATUS_KEYS)
      .nullish()
      .describe("Shape of the working day."),
    workMinutes: z.number().int().min(0).max(1440).nullish(),
    overtimeMinutes: z.number().int().min(0).max(1440).nullish(),
    workLoad: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullish()
      .describe(
        "0-10, INVERSE-oriented: a higher value is a heavier day, not a better one.",
      ),
    workSatisfaction: z.number().int().min(0).max(10).nullish(),
    contactCircles: z
      .array(z.enum(CONTACT_CIRCLE_KEYS))
      .nullish()
      .describe(
        "Who the day's contact was with. Multi-select. Never scored: the count of people is not a good or a bad number.",
      ),
    contactForm: z.enum(CONTACT_FORM_KEYS).nullish(),
    contactExtent: z.enum(CONTACT_EXTENT_KEYS).nullish(),
    contactQuality: z.number().int().min(0).max(10).nullish(),
    contactSupport: z.number().int().min(0).max(10).nullish(),
    leisureCategories: z.array(z.enum(LEISURE_CATEGORY_KEYS)).nullish(),
    leisureMinutes: z.number().int().min(0).max(1440).nullish(),
    leisureJoy: z.number().int().min(0).max(10).nullish(),
    leisureRecovery: z.number().int().min(0).max(10).nullish(),
    eventType: z
      .enum(EVENT_TYPE_KEYS)
      .nullish()
      .describe("One notable event. One per entry, not a list."),
    eventValence: z
      .number()
      .int()
      .min(-5)
      .max(5)
      .nullish()
      .describe("-5 (clearly bad) to +5 (clearly good)."),
    eventAt: z.iso.datetime({ offset: true }).nullish(),
    note: z
      .string()
      .max(500)
      .nullish()
      .describe(
        "One free-text note for the whole context. AES-256-GCM at rest; the ciphertext never rides the wire.",
      ),
  })
  .meta({
    id: "MoodContext",
    description:
      "The day around a mood entry: work, contacts, leisure and one notable event. Every field optional. Sleep, activity, vitals and body symptoms are deliberately ABSENT — they are owned by their own modules and are read from there, never captured a second time here.",
  });

// ── Bulk mood backfill (iOS SyncMode) — mirrors the route's
// `bulkPayloadSchema` / `bulkEntrySchema` and the batch-envelope response.
const bulkMoodEntry = z
  .object({
    mood: moodLevelEnum,
    tags: z.array(z.string().max(50)).max(20).optional(),
    tagKeys: z
      .array(z.string().max(60))
      .max(30)
      .optional()
      .describe("Structured-tag keys from the catalog; unknown keys dropped."),
    ratedFactors: z
      .array(
        z.object({
          key: z.string().max(60),
          rating: z.number().int().min(1).max(5),
        }),
      )
      .max(30)
      .optional()
      .describe(
        "Rated mood factors; an out-of-scale rating marks THIS entry skipped, never the batch.",
      ),
    note: z.string().max(500).optional(),
    a1: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullish()
      .describe(
        "Pleasantness, 0-10. Optional: the server DERIVES it from `mood` when the entry does not carry one, so an older build that sends only the five-point label still writes a complete row. A value sent here wins over the derivation.",
      ),
    a2: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullish()
      .describe(
        'Stress, 0-10, INVERSE-oriented: a higher value is more stress. Stored exactly as set; a client that wants "up is better" flips the sign itself.',
      ),
    a3: z.number().int().min(0).max(10).nullish().describe("Energy, 0-10."),
    a4: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullish()
      .describe("Connectedness, 0-10."),
    a5: z.number().int().min(0).max(10).nullish().describe("Stability, 0-10."),
    context: moodContextWire
      .nullish()
      .describe(
        "The day's context. Absent leaves a stored context untouched on a re-post; an empty one removes it.",
      ),
    moodLoggedAt: z.iso
      .datetime({ offset: true })
      .describe("ISO instant the entry was logged."),
    source: moodSourceEnum.optional().describe("Defaults to MANUAL."),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "iOS-side source-stable id for idempotent dedup on the `(userId, source, externalId)` key. Must be stable across app restarts — an object description or memory address (`<Class: 0x…>`, `0x12ab34cd`) is a new value on every launch; such an entry is `skipped` with reason `unstable_external_id` while the rest of the batch still lands.",
      ),
  })
  .meta({
    id: "BulkMoodEntry",
    description: "One bulk mood entry (UPSERT keyed by `externalId`).",
  });

const bulkMoodPayload = z
  .object({
    entries: z.array(bulkMoodEntry).min(1).max(500),
  })
  .meta({
    id: "BulkMoodRequest",
    description:
      "iOS SyncMode bulk mood backfill. 1–500 entries per call; per-entry UPSERT keyed by `externalId` so re-runs are idempotent.",
  });

const bulkMoodEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z
      .enum(["inserted", "duplicate", "skipped"])
      .describe(
        "`inserted`/`duplicate` — the row landed (advance the cursor). `skipped` — see `reason`.",
      ),
    reason: z.string().optional(),
    id: z
      .string()
      .optional()
      .describe("The upserted row id (absent on skips)."),
    externalId: z
      .string()
      .optional()
      .describe("Echoed back when the entry carried one, for client mapping."),
  })
  .meta({ id: "BulkMoodEntryResult" });

const bulkMoodResponse = z
  .object({
    processed: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    entries: z.array(bulkMoodEntryResult),
  })
  .meta({ id: "BulkMoodResponse" });

// ── Entry CRUD — mirrors the route handlers under
// `src/app/api/mood-entries/` and the shared list read
// (`src/lib/mood/list-read.ts`). One DTO for the list rows, the single GET,
// the create and the edit response, because the handlers deliberately answer
// one shape: the edit form reads back exactly what the write path takes.

const moodEntryRatedFactor = z
  .object({
    key: z.string(),
    rating: z.number().int(),
  })
  .meta({
    id: "MoodEntryRatedFactor",
    description: "One rated factor on an entry, with its per-entry score.",
  });

const moodEntryDto = z
  .object({
    id: z.string(),
    userId: z.string(),
    date: z
      .string()
      .describe(
        "YYYY-MM-DD, anchored to the row's `tz` (legacy rows with `tz: null` read as Europe/Berlin).",
      ),
    mood: moodLevelEnum,
    score: z
      .number()
      .int()
      .describe("The legacy 1-5 axis, server-derived from `mood`."),
    a1: z
      .number()
      .int()
      .nullable()
      .describe(
        "Pleasantness, 0-10. Server-derived from `mood` on every write when the request carried none, so it is populated even for rows a client posted without it. Consume the value; do not re-derive it.",
      ),
    a2: z
      .number()
      .int()
      .nullable()
      .describe(
        "Stress, 0-10, INVERSE-oriented: a higher value is more stress. NULL when nobody answered it.",
      ),
    a3: z.number().int().nullable().describe("Energy, 0-10, or null."),
    a4: z.number().int().nullable().describe("Connectedness, 0-10, or null."),
    a5: z.number().int().nullable().describe("Stability, 0-10, or null."),
    tags: z
      .array(z.string())
      .describe("Free-text tag list, decoded from storage; `[]` when none."),
    note: z
      .string()
      .nullable()
      .describe(
        "Free-text note, decrypted for the response. AES-256-GCM at rest; the ciphertext never rides the wire.",
      ),
    source: moodSourceEnum,
    externalId: z
      .string()
      .nullable()
      .describe("The sync client's source-stable dedup id, or null."),
    moodLoggedAt: z.iso.datetime({ offset: true }),
    tz: z
      .string()
      .nullable()
      .describe(
        "IANA zone the `date` label is anchored to. Null on legacy rows (read as Europe/Berlin).",
      ),
    syncedAt: z.iso.datetime({ offset: true }),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    syncVersion: z
      .number()
      .int()
      .nonnegative()
      .describe("LWW reconciliation counter; mood is last-writer-wins by it."),
    deletedAt: z
      .null()
      .describe(
        "Always null on this surface: tombstoned rows are hidden from the list and 404 on a direct GET. Tombstones surface on the `/api/sync/changes` feed instead.",
      ),
    tagKeys: z
      .array(z.string())
      .describe("Binary structured-tag keys linked to the entry."),
    ratedFactors: z.array(moodEntryRatedFactor),
    context: moodContextWire
      .nullable()
      .describe(
        "The day's context, or null when the entry carries none. Null and an object of nulls are different answers.",
      ),
  })
  .meta({
    id: "MoodEntryDTO",
    description:
      "One mood entry as every entry surface answers it — list rows, single GET, create and edit responses share this shape, so a client hydrating from a write response renders without a refetch.",
  });

const moodEntryEnvelope = dataEnvelope(moodEntryDto, "MoodEntryEnvelope");

const moodEntryListResponse = z.object({
  entries: z.array(moodEntryDto),
  meta: z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int(),
    offset: z.number().int(),
  }),
});

// Mirrors the route-local `restoreSchema` / `bulkDeleteSchema`
// (`src/app/api/mood-entries/{restore,bulk-delete}/route.ts`) — the two
// declare the identical shape on purpose, so one published schema serves both.
const moodEntryIdsPayload = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(200),
  })
  .meta({
    id: "MoodEntryIdsRequest",
    description:
      "1-200 mood-entry ids, scoped to the resolved record. A forged / foreign / non-matching id is a silent no-op, never a 404 existence leak: the mutation `where` pins the record owner's id.",
  });

// The `(userId, date, moodLoggedAt)` unique — only the legacy no-`externalId`
// create path and a `moodLoggedAt` edit can trip it; a create carrying
// `externalId` upserts instead of 409-ing.
const duplicateTimestampResponse = {
  "409": {
    description:
      "A mood entry with the same `(date, moodLoggedAt)` instant already exists. `meta.errorCode` = `mood.duplicate_timestamp`. Only a request without `externalId` can answer this — with one, the write upserts in place.",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

// ── The linked day — mirrors `src/lib/mood/linked-context.ts` ────────

const linkedFigure = z
  .union([
    z.object({ present: z.literal(false) }),
    z.object({
      present: z.literal(true),
      value: z.number(),
      unit: z.string(),
    }),
  ])
  .meta({
    id: "MoodLinkedFigure",
    description:
      "A figure that either exists or honestly does not. `{ present: false }` means the data is not recorded — never zero, never an error.",
  });

/**
 * A block that can also be absent because its owning module is switched off.
 * A disabled module blanks its block rather than answering zero or a filtered
 * version of itself.
 */
function linkedBlock<T extends z.ZodRawShape>(shape: T) {
  return z.union([
    z.object({
      available: z.literal(false),
      reason: z.literal("module-disabled"),
    }),
    z.object({ available: z.literal(true), ...shape }),
  ]);
}

const moodLinkedContextResponse = z
  .object({
    day: z
      .string()
      .describe("The local day the figures are about, YYYY-MM-DD."),
    sleep: linkedBlock({
      asleep: linkedFigure.describe(
        "Time asleep (minutes) for the night the day woke up on.",
      ),
      inBed: linkedFigure.describe(
        "Time in bed (minutes), when any writer recorded a bed window.",
      ),
    }),
    activity: linkedBlock({
      steps: linkedFigure,
      activeEnergy: linkedFigure,
    }),
    vitals: linkedBlock({
      restingHeartRate: linkedFigure,
      heartRateVariability: linkedFigure,
    }),
    body: linkedBlock({
      logged: z
        .boolean()
        .describe("Whether an illness day-log exists for this day at all."),
      functionalImpact: linkedFigure.describe(
        "How much the day was limited, 0-3, as the illness module records it.",
      ),
      symptoms: z
        .array(z.string())
        .describe("Symptoms linked to the day-log, by catalogue key."),
      episodeId: z
        .string()
        .nullable()
        .describe("The episode to open in the illness module, when any."),
    }),
  })
  .meta({
    id: "MoodLinkedContext",
    description:
      "What the modules that own sleep, activity, vitals and body symptoms already know about one local day. Nothing here is stored on the mood row — every figure is resolved from its owning module at read time, cross-source de-duplicated to one canonical source per metric. A switched-off module blanks its whole block (`available: false`).",
  });

// ── The day's two readings ───────────────────────────────────────────
//
// Published as the RESOLVED value. The server computes the expected value, the
// band, the count, the deviation and the age; the client renders them. Nothing
// here is a hint the client is meant to re-derive — two clients deriving the
// same figure is how they start disagreeing about it, and this figure is about
// somebody's health record.

const moodPrognosisContribution = z
  .object({
    feature: z
      .string()
      .describe(
        "Stable feature identifier: `dimension:a2`, `context:workLoad`, `context:workStatus=off` or `linked:steps`. A client that does not recognise one skips it — an older row can name a feature a later model dropped.",
      ),
    contribution: z
      .number()
      .describe(
        "Signed: how far this feature moved the expected value away from the account's own average day. Ordered by absolute size, largest first.",
      ),
  })
  .meta({ id: "MoodPrognosisContribution" });

const moodPrognosisPresent = z.object({
  present: z.literal(true),
  date: z.string().describe("The local day this is about, `YYYY-MM-DD`."),
  predicted: z
    .number()
    .describe(
      "The expected pleasantness (A1) for that day, 0-10, on the account's own past pattern. A counterfactual, never a measurement — and never to be displayed without `n` and the band.",
    ),
  ciLow: z.number().nullable(),
  ciHigh: z
    .number()
    .nullable()
    .describe(
      "The band, from the validation residuals. It widens when the model fits badly, so a wide band is the signal to present the value cautiously.",
    ),
  n: z
    .number()
    .int()
    .describe(
      "Complete days the fit used. Display it WHEREVER `predicted` is displayed: a value built from 30 days and one built from 300 look identical otherwise.",
    ),
  modelVersion: z.string(),
  computedAt: z.iso.datetime({ offset: true }),
  ageDays: z
    .number()
    .int()
    .nullable()
    .describe("Whole days between that day and the reader's today."),
  current: z
    .boolean()
    .describe(
      "Whether it is fresh enough to back a present-tense sentence. False means the copy must name the day it is about.",
    ),
  provisional: z
    .boolean()
    .describe("True below 60 days of history: label it as provisional."),
  stage: z.enum(["provisional", "regular", "seasonal"]),
  entries: z.number().int().describe("Days of history behind the ladder."),
  seasonalUnlocked: z.boolean(),
  selfAssessment: z
    .number()
    .int()
    .nullable()
    .describe(
      "The person's own rating for that day, stored exactly as they gave it. It LEADS: it is the primary value on any surface that shows both, and it is never merged with `predicted`.",
    ),
  deviation: z
    .enum(["within", "above", "below"])
    .nullable()
    .describe(
      "Where the self-assessment sat against the BAND, not against `predicted`. `within` means the day went as the account's own past days suggest.",
    ),
  deviationAmount: z
    .number()
    .nullable()
    .describe("How far outside the band, in scale points. `0` when inside."),
  contributions: z.array(moodPrognosisContribution),
});

const moodPrognosisAbsent = z.object({
  present: z.literal(false),
  reason: z
    .enum(["no-output-yet", "learning-phase", "no-pattern"])
    .describe(
      "`no-output-yet`: too few days for anything. `learning-phase`: enough to describe, not to compare. `no-pattern`: enough days, nothing steady enough in them. None of the three is an error and none is a zero.",
    ),
  entries: z.number().int(),
  nextThreshold: z
    .number()
    .int()
    .nullable()
    .describe("Days at which the next step unlocks, when a count is missing."),
});

const moodPrognosisResponse = z
  .union([moodPrognosisPresent, moodPrognosisAbsent])
  .meta({
    id: "MoodPrognosis",
    description:
      "Two separate readings of one day: what the person recorded, and what a comparison with their own past days would have expected. They are never merged — the distance between them is the finding, and a single blended figure destroys it. The comparison is a regularised regression over the account's own history: observational only, never causal. Any copy built on it must state the value as a counterfactual (a value around X would have been expected), must carry `n`, and must not say that anything caused anything.",
  });

// ── Mood insights aggregates (v1.8.5) ────────────────────────────────
//
// `GET /api/mood/insights` is the pre-computed aggregate bundle behind the
// Mood Insights page. The browser never receives raw mood rows from it — the
// compute runs server-side and only pre-shaped blocks leave. Every block is
// observational: with-versus-without comparisons and correlations, never a
// cause and never a verdict.

const moodInfluenceConfidence = z
  .enum(["low", "medium", "high"])
  .meta({ id: "MoodInfluenceConfidence" });

const moodPairingMode = z
  .enum(["sameDay", "nextDay"])
  .describe(
    "Pairing lag the row was computed at. `nextDay` is the D → D+1 join used for overnight-recovery channels; caption it, because a next-day row says something different from a same-day one.",
  );

const moodDailyCell = z.object({
  date: z.string().describe("`YYYY-MM-DD` day key."),
  score: z.number().describe("Daily mean pleasantness for the day."),
  samples: z.number().int().describe("Entries that fed the mean."),
});

const moodDimensionSummary = z
  .object({
    key: z
      .enum(["a1", "a2", "a3", "a4", "a5"])
      .describe("Level-A dimension key."),
    present: z
      .boolean()
      .describe(
        "False when nobody answered this dimension in the window. The series is then empty and the surface says so rather than drawing a line through the middle of the scale.",
      ),
    inverse: z
      .boolean()
      .describe(
        "True when higher is worse for this dimension. The analytics layer flips through this flag rather than inline, so a client must read it before comparing dimensions.",
      ),
    min: z.number().describe("Scale floor for the dimension."),
    max: z.number().describe("Scale ceiling for the dimension."),
    count: z.number().int().describe("Entries carrying a value."),
    avg7: z.number().nullable(),
    avg30: z.number().nullable(),
    avg90: z
      .number()
      .nullable()
      .describe("Trailing-window means; null when that window is empty."),
    latest: z.number().nullable(),
    latestDate: z.string().nullable().describe("`YYYY-MM-DD` of `latest`."),
    newestDaysAgo: z.number().int().nullable(),
    series: z
      .array(
        z.object({
          date: z.string(),
          value: z.number(),
          samples: z.number().int(),
        }),
      )
      .describe("Daily means, oldest first, over the longest window."),
  })
  .meta({ id: "MoodDimensionSummary" });

const moodTagInfluenceRow = z
  .object({
    tag: z
      .string()
      .describe("Stable tag key. For a flat tag this is the free text itself."),
    labelKey: z
      .string()
      .nullable()
      .describe("i18n label key for a structured tag; null for a flat one."),
    label: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Decrypted custom-tag label. Absent for catalogue and flat tags — the key is absent, not null.",
      ),
    categoryKey: z.string().nullable(),
    icon: z.string().nullable(),
    withDays: z.number().int(),
    withoutDays: z.number().int(),
    withAvg: z.number().describe("Mean of daily means on tagged days."),
    withoutAvg: z
      .number()
      .describe("Mean of daily means on the other days (the counterfactual)."),
    delta: z
      .number()
      .describe("`withAvg − withoutAvg`, rounded. Signed, never causal."),
    pooledSd: z
      .number()
      .nullable()
      .describe(
        "Pooled mood SD across the two groups (the Cohen's-d denominator); null when neither group has testable spread. Ranking input only — not rendered.",
      ),
    pValue: z.number().describe("Welch two-sided p-value."),
    confidence: moodInfluenceConfidence,
  })
  .meta({ id: "MoodTagInfluenceRow" });

const moodAggregatesResponse = z
  .object({
    summary: z
      .object({
        points: z.number().int().describe("Daily points behind the figures."),
        mean: z.number().nullable(),
        min: z.number().nullable(),
        max: z.number().nullable(),
        latest: z.number().nullable(),
        delta: z
          .number()
          .nullable()
          .describe("Latest daily mean minus the previous daily mean."),
        inTargetPct: z.number().nullable(),
        totalEntries: z.number().int(),
        totalSpanDays: z.number().int(),
        newestEntryDaysAgo: z.number().int().nullable(),
      })
      .describe(
        "Headline figures. Every statistic is null on an empty window.",
      ),
    heatmap: z.object({
      windowDays: z
        .union([z.literal(30), z.literal(90), z.literal(365)])
        .describe("Adaptive window the cells were cut to."),
      cells: z.array(moodDailyCell),
    }),
    distribution: z
      .array(
        z.object({
          score: z.number().describe("Rounded mood level, 1..5."),
          count: z.number().int(),
        }),
      )
      .describe("Entry counts per rounded level."),
    dimensions: z
      .array(moodDimensionSummary)
      .describe(
        "One summary per level-A dimension. A dimension nobody answered is still listed, with `present: false`.",
      ),
    weekday: z
      .array(
        z.object({
          weekday: z.number().int().describe("0 = Monday … 6 = Sunday."),
          avgScore: z.number().nullable(),
          count: z.number().int(),
        }),
      )
      .describe("Per-weekday means; an unlogged weekday carries a null mean."),
    timeOfDay: z
      .object({
        buckets: z.array(
          z.object({
            bucket: z.enum(["morning", "afternoon", "evening", "night"]),
            avgScore: z.number().nullable(),
            count: z.number().int(),
          }),
        ),
        reliable: z
          .boolean()
          .describe(
            "False for the once-a-day logger (everything in one bucket) or a sparse history. Do not chart or narrate the pattern when this is false.",
          ),
        best: z
          .enum(["morning", "afternoon", "evening", "night"])
          .nullable()
          .describe("Null unless `reliable`."),
        worst: z
          .enum(["morning", "afternoon", "evening", "night"])
          .nullable()
          .describe("Null unless `reliable`."),
      })
      .describe(
        "Average pleasantness per part of day, bucketed in each entry's OWN timezone. All four buckets are always listed, in canonical order.",
      ),
    stability: z
      .object({
        score: z.number().describe("0..100; higher means steadier day-to-day."),
        stdDev: z.number().describe("Population SD of the daily means."),
        band: z.enum(["verySteady", "steady", "variable", "veryVariable"]),
        days: z.number().int(),
      })
      .nullable()
      .describe("Null for a sparse logger below the day floor."),
    tags: z
      .array(
        z.object({
          tag: z.string(),
          count: z.number().int(),
          avgScore: z.number(),
        }),
      )
      .describe("Flat free-text tag counts with their mean mood."),
    contextComparison: z
      .array(
        z.object({
          field: z.string().describe("Context field, e.g. `workStatus`."),
          value: z.string().describe("The value inside that field."),
          withDays: z.number().int(),
          withoutDays: z.number().int(),
          withAvg: z.number(),
          withoutAvg: z.number(),
          delta: z
            .number()
            .describe("`withAvg − withoutAvg`. Signed, and never an effect."),
          pValue: z.number(),
          qValue: z.number().describe("Benjamini-Hochberg adjusted p-value."),
        }),
      )
      .describe(
        "How the day's pleasantness sat on days carrying each context value against the days that did not. Every row carries the two counts it was computed from so a reader can weigh it.",
      ),
    structuredTags: z
      .array(
        z.object({
          key: z.string(),
          categoryKey: z.string(),
          labelKey: z.string(),
          label: z
            .string()
            .nullable()
            .optional()
            .describe("Decrypted custom-tag label; absent for catalogue tags."),
          icon: z.string().nullable(),
          count: z.number().int(),
          avgScore: z.number(),
        }),
      )
      .describe("Taxonomy-tag counts with their mean mood."),
    tagInfluence: z
      .object({
        flat: z.array(moodTagInfluenceRow),
        structured: z.array(moodTagInfluenceRow),
      })
      .describe(
        "With-versus-without daily-mean delta plus a Welch confidence band per frequent tag, ranked by |delta| descending.",
      ),
    betterDays: z
      .array(
        z.object({
          source: z.enum(["tag", "metric"]),
          key: z
            .string()
            .describe("Tag key, or the correlation channel key for a metric."),
          labelKey: z.string().nullable(),
          label: z.string().nullable().optional(),
          categoryKey: z.string().nullable(),
          icon: z.string().nullable(),
          direction: z
            .enum(["up", "down"])
            .describe("Associated with higher / lower mood."),
          n: z.number().int(),
          confidence: moodInfluenceConfidence,
          effectSize: z
            .number()
            .describe(
              "Unified 0..1 ranking strength (|r| for a metric, min(1, |delta| / 2) for a tag). Ranking only — surface `delta` or `r`, not this.",
            ),
          delta: z
            .number()
            .nullable()
            .describe(
              "Raw mood-point delta for a tag row; null for a metric row.",
            ),
          r: z
            .number()
            .nullable()
            .describe("Raw Pearson r for a metric row; null for a tag row."),
        }),
      )
      .describe(
        "The effect-size-ranked, confidence-gated board folding the tag deltas and the mood x metric correlations into one observational list.",
      ),
    tagMetricCrosstab: z
      .array(
        z.object({
          tag: z.string(),
          labelKey: z
            .string()
            .describe(
              "Structured tags only — this board never carries a flat tag.",
            ),
          label: z.string().nullable().optional(),
          categoryKey: z.string(),
          icon: z.string().nullable(),
          metricKey: z
            .string()
            .describe(
              "Metric channel. Currently `activeEnergy`, `sleepDuration`, `nextDayRecovery`, `nextDayRestingHeartRate` or `nextDayHeartRateVariability`; the registry is a plain map, so treat this as an open token set rather than a closed enum.",
            ),
          display: z
            .string()
            .describe(
              "Display-unit hint for the client formatter (`hours` / `kcal` / `score` / `bpm` / `ms`). The values are ALREADY in that unit.",
            ),
          mode: moodPairingMode,
          withDays: z.number().int(),
          withoutDays: z.number().int(),
          withAvg: z.number(),
          withoutAvg: z.number(),
          delta: z.number().describe("`withAvg − withoutAvg`, display unit."),
          pValue: z.number(),
          qValue: z.number(),
          confidence: moodInfluenceConfidence,
          patternId: z
            .string()
            .optional()
            .describe(
              "Persisted pattern id; absent when the row is not persisted.",
            ),
          canonicalKey: z.string().optional(),
          dismissed: z
            .boolean()
            .optional()
            .describe("Whether the user dismissed the persisted pattern."),
        }),
      )
      .describe(
        "Per structured tag x health metric: the metric's mean on tag-present versus tag-absent days, Welch-tested and BH-corrected. Association, never cause.",
      ),
    factorCrosstab: z
      .array(
        z.object({
          factor: z.string().describe("Stable RATED-factor key."),
          labelKey: z.string(),
          categoryKey: z.string(),
          icon: z.string().nullable(),
          inverse: z
            .boolean()
            .describe(
              "True for an inverse-scaled factor (stress, conflict). The split already runs on the flipped series, so a `low` row always means a worse day; the flag only changes the phrasing.",
            ),
          metricKey: z
            .string()
            .describe(
              "Metric channel. Currently `sleepDuration`, `steps`, `restingHeartRate`, `heartRateVariability`, `weight` or `bloodPressureSystolic`; an open token set, as above.",
            ),
          display: z
            .string()
            .describe(
              "Display-unit hint (`hours` / `score` / `steps` / `bpm` / `ms` / `kg` / `mmHg`).",
            ),
          mode: moodPairingMode,
          lowDays: z.number().int(),
          highDays: z.number().int(),
          lowAvg: z.number(),
          highAvg: z.number(),
          delta: z
            .number()
            .describe(
              "`lowAvg − highAvg`, display unit. Negative means the vital runs lower on low-factor days.",
            ),
          pValue: z.number(),
          qValue: z.number(),
          confidence: moodInfluenceConfidence,
          patternId: z.string().optional(),
          canonicalKey: z.string().optional(),
          dismissed: z.boolean().optional(),
        }),
      )
      .describe(
        "The cross-domain bridge: per rated factor x health metric, the vital's mean on the days the factor was rated LOW versus HIGH (median split), Welch-tested and BH-corrected. Association, never cause.",
      ),
    narratives: z
      .array(
        z.object({
          kind: z.enum([
            "weekday-dip",
            "weekday-peak",
            "trend",
            "weekend",
            "tag-lift",
            "tag-drop",
            "in-target",
            "streak",
            "time-of-day",
          ]),
          messageKey: z
            .string()
            .describe("i18n template key the client resolves."),
          vars: z
            .record(z.string(), z.string())
            .describe(
              "Interpolation values, all stringified so they survive transport unchanged.",
            ),
          strength: z
            .number()
            .describe("Normalised ranking weight; higher is stronger."),
        }),
      )
      .describe(
        "Ranked, threshold-gated takeaways — the read-this-first layer above the charts. The same array feeds the LLM snapshot so prose and feed cannot drift.",
      ),
    correlations: z
      .record(
        z.string(),
        z.object({
          result: z
            .object({
              r: z.number(),
              strength: z
                .enum(["stark", "moderat", "schwach", "keine"])
                .describe(
                  "Strength bucket. The tokens are GERMAN on the wire — a legacy of where the helper was written; treat them as opaque identifiers and localise client-side rather than displaying them.",
                ),
              n: z.number().int(),
            })
            .nullable()
            .describe("Null when the pairing produced no testable series."),
          points: z
            .array(z.object({ x: z.number(), y: z.number() }))
            .describe("Mood (x) versus metric (y), paired by day."),
          n: z.number().int().describe("Paired-day count."),
        }),
      )
      .describe(
        "Mood against five health channels, keyed `sleep`, `steps`, `pulse`, `weight`, `bloodPressureSystolic`. Every key is always present; an empty channel carries `result: null` with no points.",
      ),
  })
  .meta({
    id: "MoodAggregates",
    description:
      "The pre-computed Mood Insights bundle: headline summary, heatmap, distribution, per-dimension summaries, weekday and time-of-day patterns, stability, tag boards, context and crosstab comparisons, narratives and cross-metric correlations. Everything is observational — comparisons and correlations, never a cause and never a verdict. Served through a 60 s stale-while-revalidate cache; a mood write marks the cell so the account's own entry lands on the next read.",
  });

const moodDailySeriesResponse = z
  .object({
    entries: z
      .array(
        z.object({
          date: z.string().describe("`YYYY-MM-DD` day key."),
          score: z
            .number()
            .describe("The day's mean pleasantness on the 1..5 scale."),
          samples: z.number().int().describe("Entries behind the mean."),
        }),
      )
      .describe("One entry per day that carries a mood, oldest first."),
    summary: z
      .object({
        count: z.number().int(),
        latest: z.number().nullable(),
        min: z.number().nullable(),
        max: z.number().nullable(),
        mean: z.number().nullable(),
        median: z.number().nullable(),
        avg7: z.number().nullable(),
        avg30: z.number().nullable(),
        slope7: z
          .object({
            slope: z.number(),
            direction: z.enum(["up", "down", "stable"]),
            confidence: z.number(),
          })
          .nullable(),
        slope30: z
          .object({
            slope: z.number(),
            direction: z.enum(["up", "down", "stable"]),
            confidence: z.number(),
          })
          .nullable(),
        anomalyCount: z.number().int().optional(),
        avg30LastMonth: z.number().nullable().optional(),
        avg30LastYear: z.number().nullable().optional(),
      })
      .describe(
        "The shared summary shape computed over the DAILY MEANS, not over the raw entries — so `count` is the number of days with a mood, not the number of moods logged. Every statistic is null on an empty series rather than 0.",
      ),
  })
  .meta({
    id: "MoodDailySeries",
    description:
      "The canonical daily mood series. `entryCount` and the rollup-versus-live `source` the builder also resolves are annotated for observability and deliberately NOT on this wire — the two keys below are the whole payload.",
  });

export const moodPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/mood/analytics": {
    get: {
      tags: ["Mood"],
      summary: "The canonical daily mood series",
      description:
        "One series, read by the mood page sparkline, the dashboard tile and the native client alike, so all three render the same number — the dashboard snapshot resolves it through the same builder rather than aggregating again. Answered from the mood rollup tier with a live fallback on a coverage miss; which tier answered is annotated for operators and is not on the wire. Plain read-through cache (NOT stale-while-revalidate, unlike the insights sibling). Module-gated on `mood`; a disabled module answers 403 `module.disabled` even for a valid Bearer token. Cookie or Bearer auth; the caller is always resolved as themselves, so this read cannot be delegated to a shared record.",
      responses: {
        "200": {
          description: "The daily series and its summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodDailySeriesResponse,
                "MoodDailySeriesEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/mood/insights": {
    get: {
      tags: ["Mood"],
      summary: "Pre-computed mood aggregates (v1.8.5)",
      description:
        "The whole Mood Insights page in one read. The compute runs server-side and only pre-shaped blocks leave — no raw mood row is on this wire, and no LLM is reachable from this path. Stale-while-revalidate: past the fresh window the prior aggregate is served immediately while one background recompute warms a new one, so an active logger never re-pays the cold compute. Module-gated on `mood`; a disabled module answers 403 `module.disabled` even for a valid Bearer token. Cookie or Bearer auth; the caller is always resolved as themselves, so this read cannot be delegated to a shared record — which makes it the one mood surface a delegate cannot reach.",
      responses: {
        "200": {
          description: "The aggregate bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodAggregatesResponse,
                "MoodAggregatesEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/mood/prognosis": {
    get: {
      tags: ["Mood"],
      summary: "The day's own rating and what the account's days imply (v1.38)",
      description:
        "The newest stored comparison for the account, with the person's own rating for that day beside it. Written nightly by a job and never by a request: the value cannot be overwritten, which is what keeps the two readings separate. Absence is explicit (`present: false` with a reason and a count) and is a normal answer, not an error — the comparison refuses when the history does not support one. Whole-record read: the fit takes the day's context AND the sleep, activity and recovery figures the owning modules hold, and it names them, so a section-scoped grant is refused rather than served a filtered list. Gated: `module.disabled` 403 when the mood module is off.",
      responses: {
        "200": {
          description: "The day's two readings, or an explained absence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodPrognosisResponse,
                "MoodPrognosisEnvelope",
              ),
            },
          },
        },
        // Two reasons, one status: the module gate and the sharing fence both
        // answer 403, and OpenAPI allows one response per status.
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/mood-entries/bulk": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Mood"],
      summary: "Bulk mood backfill (iOS SyncMode)",
      description:
        "Drains the iOS local mood log in one shot: up to 500 entries per call with per-entry UPSERT semantics keyed by `externalId`, so an adopt-on-pair backfill or a retried batch is idempotent. Idempotent via the `Idempotency-Key` header too. Per-entry status (`inserted` / `duplicate` / `skipped`) advances the client cursor. Rate-limited 60/min/user. An over-size batch 422s (`meta.errorCode = mood.bulk.too_large`); a malformed body 422s (`mood.bulk.invalid`).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: bulkMoodPayload } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Batch processed (always 200 on a well-formed body).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                bulkMoodResponse,
                "BulkMoodResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags": {
    get: {
      tags: ["Mood"],
      summary: "Effective per-user mood-tag tree (v1.8.5 / v1.13.0 / v1.17.0)",
      description:
        "The fully-resolved, ordered Category → Tag tree: seeded catalogue + the caller's custom tags and groups, per-user layout (group order + placements) applied server-side, hidden catalogue tags omitted. `include` is a comma list: `hidden` (hidden catalogue tags, `hidden:true`), `archived` (own inactive custom tags, `archived:true`), `usage` (per-tag `usageCount`). With any flag set, the caller's own empty groups are kept; the plain read drops empty categories.",
      requestParams: {
        query: z.object({
          include: z
            .string()
            .optional()
            .describe("Comma list of `hidden`, `archived`, `usage`."),
        }),
      },
      responses: {
        "200": {
          description: "The effective tag tree.",
          content: {
            "application/json": {
              schema: dataEnvelope(moodTagTreeResponse, "MoodTagTreeEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/custom": {
    post: {
      tags: ["Mood"],
      summary: "Create a custom mood tag (v1.13.0 / v1.17.0)",
      description:
        "Mints a `custom:<uuid>` key, encrypts the label at rest, stores a BINARY tag owned by the caller under the chosen group (default: the seeded `custom` category). 422 over the 50-tag cap or on an unknown / foreign `categoryKey`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMoodTagRequest } },
      },
      responses: {
        "201": {
          description: "Custom tag created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodCustomTagResponse,
                "MoodCustomTagCreatedEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/custom/{key}": {
    patch: {
      tags: ["Mood"],
      summary: "Update a custom mood tag (v1.13.0 / v1.17.0)",
      description:
        "Owner-scoped: another user's key or a catalogue key 404s. Rename (re-encrypts), re-icon, archive/restore via `isActive`, or move groups via `categoryKey`.",
      requestParams: { path: z.object({ key: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMoodTagRequest } },
      },
      responses: {
        "200": {
          description: "Custom tag updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodCustomTagPatchResponse,
                "MoodCustomTagPatchEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Mood"],
      summary: "Archive or purge a custom mood tag (v1.13.0)",
      description:
        "Default: soft-deactivates (`isActive:false`) — history intact, restorable via PATCH. `?purge=true`: hard-deletes the row; the FK cascade removes its entry links. Owner-scoped 404.",
      requestParams: {
        path: z.object({ key: z.string() }),
        query: z.object({ purge: z.enum(["true", "false"]).optional() }),
      },
      responses: {
        "200": {
          description: "Archived (or purged).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ key: z.string(), purged: z.boolean() }),
                "MoodCustomTagDeleteEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/{key}/hidden": {
    put: {
      tags: ["Mood"],
      summary: "Hide / show a catalogue mood tag (v1.13.0)",
      description:
        "Per-user hide of a CATALOGUE tag (upserts / removes a `mood_tag_hidden` row). 400 on a `custom:` key — custom tags archive via their own `isActive`.",
      requestParams: { path: z.object({ key: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: hideMoodTagRequest } },
      },
      responses: {
        "200": {
          description: "Visibility updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ key: z.string(), hidden: z.boolean() }),
                "MoodTagHiddenEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "Custom-tag key — use the custom PATCH instead.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/groups": {
    post: {
      tags: ["Mood"],
      summary: "Create a custom mood-tag group (v1.17.0)",
      description:
        "Mints a `customcat:<uuid>` key, encrypts the label at rest, stores a group owned by the caller. 422 over the 12-group cap.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMoodTagGroupRequest } },
      },
      responses: {
        "201": {
          description: "Custom group created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodTagGroupResponse,
                "MoodTagGroupCreatedEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/groups/{key}": {
    patch: {
      tags: ["Mood"],
      summary: "Update a custom mood-tag group (v1.17.0)",
      description:
        "Owner-scoped: another user's key or a seeded category key 404s. Rename (re-encrypts), re-icon, retire/restore via `isActive`.",
      requestParams: { path: z.object({ key: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMoodTagGroupRequest } },
      },
      responses: {
        "200": {
          description: "Custom group updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodTagGroupPatchResponse,
                "MoodTagGroupPatchEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Mood"],
      summary: "Delete a custom mood-tag group (v1.17.0)",
      description:
        "Non-destructive: the group's custom tags re-home to the seeded `custom` category, catalogue-tag placements evaporate back to their seeded category, the layout drops the group, then the row soft-deactivates (default) or hard-deletes (`?purge=true`). No tag and no entry link is deleted.",
      requestParams: {
        path: z.object({ key: z.string() }),
        query: z.object({ purge: z.enum(["true", "false"]).optional() }),
      },
      responses: {
        "200": {
          description: "Group deleted; `rehomedCount` custom tags moved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  key: z.string(),
                  purged: z.boolean(),
                  rehomedCount: z.number().int(),
                }),
                "MoodTagGroupDeleteEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/layout": {
    get: {
      tags: ["Mood"],
      summary: "Read the per-user mood-tag layout (v1.17.0)",
      description:
        "Returns the stored blob merged over defaults: `groupOrder` resolved against the caller's effective category set (seeded + own groups), `placements` as stored.",
      responses: {
        "200": {
          description: "Resolved layout.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodTagLayoutResolved,
                "MoodTagLayoutGetEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Mood"],
      summary: "Update the per-user mood-tag layout (v1.17.0)",
      description:
        "Preserve-when-absent merge: a `groupOrder`-only PUT keeps the stored `placements` and vice versa. Bounded: ≤ 50 groups, ≤ 400 placement entries, keys ≤ 80 chars. Returns the resolved layout.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: moodTagLayoutPutRequest } },
      },
      responses: {
        "200": {
          description: "Merged + resolved layout with the fresh token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodTagLayoutResolved,
                "MoodTagLayoutPutEnvelope",
              ),
            },
          },
        },
        ...conflictResponse409("Mood-tag layout", "mood_tag_layout_conflict"),
        ...stdResponses,
        ...invalidBaseTokenResponse,
      },
    },
  },
  // ── Entry CRUD (published later than its bulk twin; see file header) ─
  "/api/mood-entries": {
    get: {
      tags: ["Mood"],
      summary: "List mood entries",
      description:
        "The record's mood entries, filtered and paged. Soft-deleted (tombstoned) rows are hidden; the `/api/sync/changes` feed is where tombstones surface. Every row carries the same `MoodEntryDTO` shape the write paths answer, structured-tag keys and rated factors included, so the edit form pre-populates without per-row requests. A malformed query 422s with every issue listed (`meta.errorCode` = `mood.list.invalid`).",
      requestParams: { query: listMoodEntriesQuery },
      responses: {
        "200": {
          description: "One page of entries plus paging meta.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodEntryListResponse,
                "MoodEntryListEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Mood"],
      summary: "Create a mood entry",
      description:
        "Writes the entry, its structured-tag links and its day context in one transaction — a link or context failure rolls the entry back rather than letting a retry mint a duplicate. Idempotent via the `Idempotency-Key` header. With `externalId` the write UPSERTS on `(userId, source, externalId)` (a re-post updates the row in place and restates pleasantness from the label, while A2-A5 and a stored context are only touched when the request carries them); without it, a same-`(date, moodLoggedAt)` re-post 409s. A delegated manager cannot supply `externalId` (422, `meta.errorCode` = `mood.create.external_id_not_delegable`) — it is a device's contract with its own rows. A rated factor outside its catalog scale 422s (`mood.ratedFactor.out_of_range`); a malformed body 422s (`mood.create.invalid`). An unstable `externalId` (an object description or memory address that rotates per launch) is refused at validation.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMoodEntryRequest } },
      },
      responses: {
        ...idempotentWrite(),
        "201": {
          description:
            "Entry created (or upserted in place via `externalId`), with its persisted tag keys, rated factors and context.",
          content: { "application/json": { schema: moodEntryEnvelope } },
        },
        ...duplicateTimestampResponse,
        ...recordRefusal(),
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/mood-entries/{id}": {
    get: {
      tags: ["Mood"],
      summary: "Read one mood entry",
      description:
        "The full entry with its day context, so the edit surface loads both in one request. A soft-deleted row 404s, matching the list read's invariant.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "The entry.",
          content: { "application/json": { schema: moodEntryEnvelope } },
        },
        ...notFoundResponse,
        ...recordRefusal(),
        ...stdResponses,
      },
    },
    put: {
      tags: ["Mood"],
      summary: "Edit a mood entry",
      description:
        "Per-field edit: omitted fields keep their stored value; `tagKeys`, `ratedFactors` and `context` replace their whole set when present (`null` clears). Editing `mood` re-derives `score` and — when the label actually moved — pleasantness `a1`; editing `moodLoggedAt` re-anchors the row's `date` and `tz` to the account's display timezone. Bumps `syncVersion` so paired clients reconcile last-writer-wins. A soft-deleted row 404s (`meta.errorCode` = `mood.not_found`); an edit landing on another row's `(date, moodLoggedAt)` 409s (`mood.duplicate_timestamp`); a rated factor outside its catalog scale 422s (`mood.ratedFactor.out_of_range`); a malformed body 422s (`mood.update.invalid`).",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMoodEntryRequest } },
      },
      responses: {
        "200": {
          description:
            "The entry after the edit, with its persisted tag keys, rated factors and context.",
          content: { "application/json": { schema: moodEntryEnvelope } },
        },
        ...notFoundResponse,
        ...duplicateTimestampResponse,
        ...recordRefusal(),
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Mood"],
      summary: "Delete a mood entry (soft)",
      description:
        "Tombstones the row (`deletedAt` set, `syncVersion` bumped) rather than hard-deleting, so the `/api/sync/changes` feed carries the tombstone to paired clients that were offline. Invisible to every normal read from here on; `POST /api/mood-entries/restore` puts it back. Re-deleting an already-tombstoned row is a harmless idempotent no-op.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Entry tombstoned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.literal(true) }),
                "MoodEntryDeleteEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
  "/api/mood-entries/restore": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Mood"],
      summary: "Restore soft-deleted mood entries",
      description:
        "Un-tombstones every owned, currently-deleted id in one statement — the delete-Undo affordance. Clears `deletedAt` and bumps `syncVersion` so the row re-surfaces in normal reads and rides the `/api/sync/changes` feed as an upsert. A forged / foreign / not-deleted id is a silent no-op, never a 404 existence leak. Idempotent via the `Idempotency-Key` header. Rate-limited 60/min (keyed on the ACTING user, so a manager burns their own allowance). A malformed body 422s (`meta.errorCode` = `mood.restore.invalid`).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: moodEntryIdsPayload } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "`restored` counts the rows actually un-tombstoned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ restored: z.number().int().nonnegative() }),
                "MoodEntriesRestoreEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
  "/api/mood-entries/bulk-delete": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Mood"],
      summary: "Soft-delete mood entries in bulk",
      description:
        "Tombstones every owned, not-already-deleted id in one statement — the management list's multi-select delete, matching the single-DELETE tombstone contract. A forged / foreign id is a silent no-op, never a 404 existence leak. Idempotent via the `Idempotency-Key` header. Rate-limited 60/min (keyed on the ACTING user). A malformed body 422s (`meta.errorCode` = `mood.bulk-delete.invalid`).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: moodEntryIdsPayload } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "`deleted` counts the rows actually tombstoned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.number().int().nonnegative() }),
                "MoodEntriesBulkDeleteEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(),
        ...stdResponses,
      },
    },
  },
  "/api/mood/linked-context": {
    get: {
      tags: ["Mood"],
      summary: "The linked figures of one local day",
      description:
        "What the modules that own sleep, activity, vitals and body symptoms already know about one day, resolved at read time and never stored on the mood row — a corrected sleep session shows up here with nothing to re-sync. Keyed by local day rather than entry id, deliberately: the capture sheet needs the figures BEFORE an entry exists. `tz` anchors the day's boundaries — the capture sheet sends the browser's zone, the edit dialog the entry's stored `tz`; absent falls back to the account's display timezone. Whole-record read: the payload crosses into the measurements and illness sections from a mood surface, so a section-scoped grant is refused outright rather than served a filtered day that would read as empty. Gated: 403 `module.disabled` when the mood module is off. A malformed query 422s (`meta.errorCode` = `mood.linkedContext.invalid`).",
      requestParams: {
        query: z.object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("The local day to resolve, YYYY-MM-DD."),
          tz: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe(
              "IANA zone the day is anchored to. Send the entry's stored `tz` when editing; omit to use the account's display timezone.",
            ),
        }),
      },
      responses: {
        "200": {
          description:
            "The day's linked blocks; absence is explicit per figure and per module.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodLinkedContextResponse,
                "MoodLinkedContextEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
};
