/**
 * `POST /api/mood-entries/bulk` — iOS SyncMode bulk backfill.
 *
 * When iOS pairs a fresh device with the server, it drains its local
 * SwiftData mood log via this endpoint in one shot. Per-entry UPSERT
 * semantics keyed by `externalId` so re-runs are idempotent.
 *
 * Body:
 *   { entries: BulkMoodEntry[] }     — capped at 500 per call.
 *
 * Response (always 200):
 *   {
 *     processed,
 *     inserted,
 *     duplicates,
 *     skipped: [{ index, reason }, ...],
 *     entries: [{ index, status, id? }, ...]
 *   }
 *
 * Locked contract — see `.planning/v15-ios-handoff/06-ios-responsibilities.md`
 * §"Cumulative metrics" sibling section for the SyncMode rationale,
 * and `08-locked-contracts.md` §2 for the batch envelope shape.
 *
 * The route authenticates, meters, caps and parses; the per-entry writes live
 * in `src/lib/mood/bulk-ingest.ts`.
 */
import { auditLog } from "@/lib/auth/audit";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { moodLevelEnum, moodSourceEnum } from "@/lib/validations/mood";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { ingestMoodBulk } from "@/lib/mood/bulk-ingest";
import { isoDateTime } from "@/lib/validations/datetime";

const MAX_ENTRIES_PER_BATCH = 500;
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkEntrySchema = z.object({
  mood: moodLevelEnum,
  tags: z.array(z.string().max(50)).max(20).optional(),
  /**
   * v1.12.0 — structured-tag keys from the catalog (`mood_tags.key`),
   * mirroring the single-entry `POST /api/mood-entries` contract.
   * Without this the bulk path Zod-stripped the field, so iOS-sent
   * taxonomy links were silently dropped on the adopt-on-pair backfill.
   * The server resolves each key to a `MoodTag` row and writes the
   * `MoodEntryTagLink` join; an unknown or archived key is not stored (the
   * catalog is the source of truth) and is listed on that entry's result
   * as `droppedTagKeys`. Bounds match the single-entry
   * `structuredTagKeys` schema so one entry can't fan out an unbounded
   * link set.
   */
  tagKeys: z.array(z.string().max(60)).max(30).optional(),
  /**
   * v1.12.0 — rated mood factors (`kind = 'RATED'` catalog tags carrying
   * a per-entry score). Parallel to the binary `tagKeys`; persisted on
   * `MoodEntryTagLink.rating`. The outer 1..5 here is the envelope; the
   * server rejects a rating outside the resolved factor's own
   * `scaleMin..scaleMax` (e.g. 1..2 for `factor_conflict`) — on the bulk
   * path that marks the single entry `skipped`, never the whole batch.
   */
  ratedFactors: z
    .array(
      z.object({
        key: z.string().max(60),
        rating: z.number().int().min(1).max(5),
      }),
    )
    .max(30)
    .optional(),
  note: z.string().max(500).optional(),
  /**
   * v1.38 — the five level-A self-state values, each 0-10, each optional.
   * A batch that carries none still writes complete rows: the server derives
   * `a1` from the five-point label, so an older client build needs no change
   * to stay correct.
   *
   * `unknown` here and parsed with {@link bulkDimensionsSchema} PER ENTRY in
   * the bulk ingest, for the same reason `context` is: the doc comment beside
   * this field used to promise that an out-of-range value marks THIS entry
   * skipped while the field itself sat in the batch schema and 422'd all five
   * hundred. The words were right and the code was not. A phone draining a
   * year of local history must not lose the year to one row.
   * @per-entry-parse: bulkDimensionsSchema, in src/lib/mood/bulk-ingest.ts
   */
  a1: z.unknown().optional(),
  a2: z.unknown().optional(),
  a3: z.unknown().optional(),
  a4: z.unknown().optional(),
  a5: z.unknown().optional(),
  /**
   * v1.38 — the day's context. Optional, and absent leaves a stored context
   * alone on a re-post, matching the single-entry path: a build with no
   * context surface must not blank one filled in on the web.
   *
   * Declared as `unknown` here and parsed with `moodContextSchema` PER ENTRY
   * in the bulk ingest, deliberately. Validating it in the batch schema would
   * make one entry carrying a retired key fail all five hundred, and this
   * endpoint's whole contract — stated in its own OpenAPI description — is
   * that a bad row is `skipped` and the rest of the batch lands. A phone
   * draining a year of local history must not lose the year to one row.
   * @per-entry-parse: moodContextSchema, in src/lib/mood/bulk-ingest.ts
   */
  context: z.unknown().optional(),
  moodLoggedAt: isoDateTime().transform((s) => new Date(s)),
  source: moodSourceEnum.optional().default("MANUAL"),
  /**
   * Optional iOS-side identifier (e.g. SwiftData row UUID) that lets
   * the bulk endpoint dedup idempotently when iOS retries the same
   * batch after a network hiccup. Mirrors the `externalId` posture on
   * the measurements batch endpoint. NULL = no dedup hint; the
   * existing `(userId, date, moodLoggedAt)` unique index still
   * protects against straight-up duplicates.
   *
   * Stability is enforced per entry in the bulk ingest, not at the field:
   * a schema-level refusal would fail the whole batch on one bad row.
   * @external-id-checked-per-entry: src/lib/mood/bulk-ingest.ts
   */
  externalId: z.string().min(1).max(120).optional(),
});

/**
 * The five dimensions, validated for one entry.
 *
 * The bound is the scale itself, matching the single-entry schema exactly —
 * one definition of "0 to 10" would be better still, but the single-entry
 * schema states it as a shared const and this one has to answer per entry, so
 * the two are pinned to each other by
 * `src/app/api/mood-entries/__tests__/bulk-dimension-bounds.test.ts` instead.
 */
const bulkDimensionsSchema = z.object({
  a1: z.number().int().min(0).max(10).nullable().optional(),
  a2: z.number().int().min(0).max(10).nullable().optional(),
  a3: z.number().int().min(0).max(10).nullable().optional(),
  a4: z.number().int().min(0).max(10).nullable().optional(),
  a5: z.number().int().min(0).max(10).nullable().optional(),
});

const bulkPayloadSchema = z.object({
  entries: z.array(bulkEntrySchema).min(1).max(MAX_ENTRIES_PER_BATCH),
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulk));

async function postBulk(request: NextRequest): Promise<Response> {
  // Metered by this route's own bulk bucket below, not the shared per-account
  // write bucket: the native client syncs through here in bursts (see
  // `meterAccountWrite`).
  const { user } = await requireAuth(undefined, { writeBucket: "own" });

  const rl = await checkRateLimit(
    `mood-entries:bulk:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 2 * 1024 * 1024,
  });
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_ENTRIES_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_ENTRIES_PER_BATCH}-entry limit`,
      422,
      { errorCode: "mood.bulk.too_large" },
    );
  }

  const parsed = bulkPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    // v1.4.43 — bulk mood ingest; keep the `mood.bulk.invalid`
    // errorCode meta intact so the iOS Sync engine's retry classifier
    // still branches on it. Adds the audit-ledger breadcrumb keyed
    // `mood.bulk.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "mood.bulk.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; bulk mood
    // entries carry free-text `note` + `tags` per row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    auditLog("mood.bulk.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.bulk.invalid",
    });
  }

  return apiSuccess(
    await ingestMoodBulk({
      userId: user.id,
      tz: user.timezone ?? DEFAULT_TIMEZONE,
      entries: parsed.data.entries,
      ipAddress: getClientIp(request),
      parseDimensions: (dimensions) =>
        bulkDimensionsSchema.safeParse(dimensions),
    }),
  );
}
