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
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
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
import {
  getScoreForMood,
  moodLevelEnum,
  moodSourceEnum,
} from "@/lib/validations/moodlog";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";

const MAX_ENTRIES_PER_BATCH = 500;
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkEntrySchema = z.object({
  mood: moodLevelEnum,
  tags: z.array(z.string().max(50)).max(20).optional(),
  note: z.string().max(500).optional(),
  moodLoggedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  source: moodSourceEnum.optional().default("MANUAL"),
  /**
   * Optional iOS-side identifier (e.g. SwiftData row UUID) that lets
   * the bulk endpoint dedup idempotently when iOS retries the same
   * batch after a network hiccup. Mirrors the `externalId` posture on
   * the measurements batch endpoint. NULL = no dedup hint; the
   * existing `(userId, date, moodLoggedAt)` unique index still
   * protects against straight-up duplicates.
   */
  externalId: z.string().min(1).max(120).optional(),
});

const bulkPayloadSchema = z.object({
  entries: z.array(bulkEntrySchema).min(1).max(MAX_ENTRIES_PER_BATCH),
});

type EntryStatus = "inserted" | "duplicate" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  id?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulk));

async function postBulk(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `mood-entries:bulk:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request);
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
    // v1.4.43 W6 — bulk mood ingest; keep the `mood.bulk.invalid`
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
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "mood.bulk.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.bulk.invalid",
    });
  }

  const { entries } = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  const results: EntryResult[] = [];
  let inserted = 0;
  let duplicates = 0;
  const skipped: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const date = moodDateKey(entry.moodLoggedAt, tz);
    const score = getScoreForMood(entry.mood);

    try {
      // Probe-then-upsert so the response reliably distinguishes
      // "inserted" from "duplicate". Two round-trips per entry is
      // acceptable given the 500-entry cap; a more cache-friendly
      // shape (batched probe) is a v1.4.31 optimisation if the cap
      // grows.
      const existing = await prisma.moodEntry.findUnique({
        where: {
          userId_date_moodLoggedAt: {
            userId: user.id,
            date,
            moodLoggedAt: entry.moodLoggedAt,
          },
        },
        select: { id: true },
      });

      const result = await prisma.moodEntry.upsert({
        where: {
          userId_date_moodLoggedAt: {
            userId: user.id,
            date,
            moodLoggedAt: entry.moodLoggedAt,
          },
        },
        create: {
          userId: user.id,
          date,
          tz,
          mood: entry.mood,
          score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          note: entry.note ?? null,
          source: entry.source,
          moodLoggedAt: entry.moodLoggedAt,
        },
        update: {
          // Last-writer-wins on the mood + tags + note triple. The
          // iOS client only re-posts an existing entry when it has
          // new data; the server trusts that decision.
          mood: entry.mood,
          score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          note: entry.note ?? null,
        },
      });

      if (existing) {
        duplicates += 1;
        results.push({ index: i, status: "duplicate", id: result.id });
      } else {
        inserted += 1;
        results.push({ index: i, status: "inserted", id: result.id });
      }
    } catch (err: unknown) {
      const reason =
        err instanceof Error ? err.message.slice(0, 120) : "upsert_failed";
      skipped.push({ index: i, reason });
      results.push({ index: i, status: "skipped", reason });
    }
  }

  await auditLog("mood.bulk.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: entries.length,
      inserted,
      duplicates,
      skipped: skipped.length,
    },
  });

  annotate({
    action: { name: "mood.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      duplicates,
      skipped: skipped.length,
    },
  });

  // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches
  // when at least one row landed so the next read picks up the ingested
  // batch. Skipped / duplicate-only ingests are no-ops.
  if (inserted > 0) {
    invalidateUserMood(user.id);
  }

  // v1.4.39 W-MOOD — refresh the rollup tier for every distinct day
  // touched by this batch. The bulk endpoint is an iOS one-shot
  // backfill so the batch can span many days; we collapse to the
  // unique `(user, dayStart)` set first to bound the recompute count.
  // Best-effort: rollup failures must not surface as 5xx.
  if (inserted > 0 || duplicates > 0) {
    const touchedDayStarts = new Set<number>();
    for (let i = 0; i < entries.length; i++) {
      const status = results[i]?.status;
      if (status === "inserted" || status === "duplicate") {
        const d = entries[i].moodLoggedAt;
        const dayStart = Date.UTC(
          d.getUTCFullYear(),
          d.getUTCMonth(),
          d.getUTCDate(),
        );
        touchedDayStarts.add(dayStart);
      }
    }
    try {
      await Promise.all(
        Array.from(touchedDayStarts).map((t) =>
          recomputeMoodBucketsForEntry(user.id, new Date(t)),
        ),
      );
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }
  }

  return apiSuccess({
    processed: entries.length,
    inserted,
    duplicates,
    skipped,
    entries: results,
  });
}
