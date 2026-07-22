import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import {
  updateMoodEntrySchema,
  getScoreForMood,
} from "@/lib/validations/moodlog";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { encryptNote, shapeMoodNote } from "@/lib/crypto/note-cipher";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import {
  RatedFactorOutOfRangeError,
  replaceRatedFactorLinks,
  replaceTagLinks,
} from "@/lib/mood/tag-links";

type RouteParams = { params: Promise<{ id: string }> };

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags) as string[];
  } catch {
    return [];
  }
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    // v1.7.0 sync — a soft-deleted (tombstoned) row 404s on a direct GET,
    // matching the list / analytics / rollup read invariant. `findFirst`
    // (not `findUnique`) because `deletedAt` is not part of a unique index.
    const entry = await prisma.moodEntry.findFirst({
      where: { id, deletedAt: null },
    });

    if (!entry || entry.userId !== user.id) {
      return apiError("Mood entry not found", 404);
    }

    annotate({
      action: { name: "mood-entries.get" },
      meta: { moodEntryId: id },
    });

    return apiSuccess({ ...shapeMoodNote(entry), tags: parseTags(entry.tags) });
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    // v1.7.0 sync — refuse to resurrect-edit a tombstoned row; the
    // `deletedAt: null` filter makes a soft-deleted entry 404 on PUT.
    const existing = await prisma.moodEntry.findFirst({
      where: { id, deletedAt: null },
    });

    if (!existing || existing.userId !== user.id) {
      return apiError("Mood entry not found", 404, {
        errorCode: "mood.not_found",
      });
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });

    if (jsonError) return jsonError;
    const parsed = updateMoodEntrySchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — mood edit hot path; multi-issue 422 + audit
      // breadcrumb keyed `mood-entries.update.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "mood-entries.update.validation-failed" },
        meta: { issue_count: issues.length, moodEntryId: id },
      });
      // v1.4.49 — strip `message` from the audit-ledger row; mood
      // update carries free-text `note` + `tags`.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "mood-entries.update.validation-failed",
            details: JSON.stringify({ issues: auditIssues, moodEntryId: id }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "mood.update.invalid",
      });
    }

    const data = parsed.data;

    const updateData: Record<string, unknown> = {};
    if (data.mood !== undefined) {
      updateData.mood = data.mood;
      updateData.score = getScoreForMood(data.mood);
    }
    if (data.moodLoggedAt !== undefined) {
      // v1.4.25 W7b — re-anchor the row's `date` to the user's current
      // displayTimezone. Also refresh the `tz` column so the row's
      // attribution stays consistent with the new `date`. Legacy rows
      // promoted via this PUT therefore migrate to per-row tz without
      // a separate backfill.
      const tz = user.timezone ?? DEFAULT_TIMEZONE;
      updateData.moodLoggedAt = data.moodLoggedAt;
      updateData.date = moodDateKey(data.moodLoggedAt, tz);
      updateData.tz = tz;
    }
    if (data.tags !== undefined) {
      updateData.tags = data.tags ? JSON.stringify(data.tags) : null;
    }
    if (data.note !== undefined) {
      // v1.23 — write to the encrypted column; null the legacy plaintext. An
      // explicit `null` clears the note.
      updateData.note = null;
      updateData.noteEncrypted = encryptNote(data.note);
    }

    // v1.7.0 sync — mood is last-writer-wins by syncVersion; bump it on
    // every server-side edit so the `/api/sync/changes` feed echoes a
    // monotonic value and paired clients reconcile higher-wins.
    updateData.syncVersion = { increment: 1 };

    // Update the row and replace each submitted half of the structured-link
    // contract in one transaction. A failure in either replacement rolls
    // back the mood edit and its syncVersion increment as one unit.
    const persistUpdate = () =>
      prisma.$transaction(async (tx) => {
        const updated = await tx.moodEntry.update({
          where: { id },
          data: updateData,
        });

        // Omission preserves the corresponding link set. Explicit null/empty
        // clears it, matching the validated update contract.
        if (data.tagKeys !== undefined) {
          await replaceTagLinks(id, user.id, data.tagKeys ?? [], tx);
        }
        if (data.ratedFactors !== undefined) {
          await replaceRatedFactorLinks(
            id,
            user.id,
            data.ratedFactors ?? [],
            tx,
          );
        }

        // Return the same split shape as list/create: binary keys are
        // independent from rated-factor keys and their per-entry scores.
        const links = await tx.moodEntryTagLink.findMany({
          where: { moodEntryId: id },
          select: {
            rating: true,
            moodTag: { select: { key: true, kind: true } },
          },
        });

        return {
          entry: updated,
          persistedTagKeys: links
            .filter((link) => link.moodTag.kind !== "RATED")
            .map((link) => link.moodTag.key),
          persistedRatedFactors: links
            .filter(
              (link) => link.moodTag.kind === "RATED" && link.rating !== null,
            )
            .map((link) => ({
              key: link.moodTag.key,
              rating: link.rating as number,
            })),
        };
      });

    const transactionOutcome = await persistUpdate().then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!transactionOutcome.ok) {
      const { error } = transactionOutcome;
      if (error instanceof RatedFactorOutOfRangeError) {
        annotate({
          action: { name: "mood-entries.update.rated-factor-out-of-range" },
          meta: { scaleMin: error.scaleMin, scaleMax: error.scaleMax },
        });
        return apiError(error.message, 422, {
          errorCode: "mood.ratedFactor.out_of_range",
        });
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return apiError("A mood entry with this data already exists", 409, {
          errorCode: "mood.duplicate_timestamp",
        });
      }
      throw error;
    }
    const { entry, persistedTagKeys, persistedRatedFactors } =
      transactionOutcome.result;

    await auditLog("moodEntry.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: id },
    });

    annotate({
      action: { name: "mood-entries.update" },
      meta: { moodEntryId: id },
    });

    // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 W-MOOD — refresh the persisted rollup for the new
    // bucket AND the old bucket when the entry's `moodLoggedAt`
    // changed. The two recomputes are independent (different
    // (user, day) tuples) so we fan them out in parallel. Best-
    // effort: rollup failures must not surface as 5xx.
    try {
      const targets = new Set<number>([entry.moodLoggedAt.getTime()]);
      if (existing.moodLoggedAt.getTime() !== entry.moodLoggedAt.getTime()) {
        targets.add(existing.moodLoggedAt.getTime());
      }
      await Promise.all(
        Array.from(targets).map((t) =>
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

    return apiSuccess({
      ...entry,
      tags: parseTags(entry.tags),
      // v1.8.5 — surface the persisted structured-tag keys so a client
      // hydrating from the update response renders the tag set without a
      // refetch (shape-matches the list GET).
      tagKeys: persistedTagKeys,
      ratedFactors: persistedRatedFactors,
    });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    const existing = await prisma.moodEntry.findUnique({ where: { id } });

    if (!existing || existing.userId !== user.id) {
      return apiError("Mood entry not found", 404);
    }

    // v1.7.0 sync — soft-delete instead of a hard `delete`. Setting
    // `deletedAt` (+ bumping `syncVersion`) leaves the row in place so the
    // `/api/sync/changes` feed surfaces it as a tombstone (keyed on the
    // server `id`) to paired clients that were offline at delete time.
    // Every list / detail / analytics / rollup read filters
    // `deletedAt: null`, so the row is invisible to normal reads from
    // here on. A re-delete of an already-tombstoned row re-bumps
    // `syncVersion` harmlessly (idempotent).
    await prisma.moodEntry.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        syncVersion: { increment: 1 },
      },
    });

    await auditLog("moodEntry.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: id, mood: existing.mood },
    });

    annotate({
      action: { name: "mood-entries.delete" },
      meta: { moodEntryId: id },
    });

    // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 W-MOOD — refresh the persisted rollup for the
    // deleted entry's bucket; the recompute helper handles the
    // "now-empty day → drop the rollup row" branch internally.
    try {
      await recomputeMoodBucketsForEntry(user.id, existing.moodLoggedAt);
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }

    return apiSuccess({ deleted: true });
  },
);
