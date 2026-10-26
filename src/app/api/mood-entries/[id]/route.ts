import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiSuccess,
  apiError,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { updateMoodEntrySchema, getScoreForMood } from "@/lib/validations/mood";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { moodDateKey } from "@/lib/mood/date-key";
import { MOOD_ENTRY_WIRE_INCLUDE, toMoodEntryWire } from "@/lib/mood/list-read";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { deriveA1, shapeLevelA } from "@/lib/mood/level-a";
import { contextForWire, persistMoodContext } from "@/lib/mood/context";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import {
  RatedFactorOutOfRangeError,
  replaceRatedFactorLinks,
  replaceTagLinks,
  droppedLinkKeysForWire,
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
    const { user } = await requireRecordAuth("read", "mind");

    const { id } = await params;

    // v1.7.0 sync — a soft-deleted (tombstoned) row 404s on a direct GET,
    // matching the list / analytics / rollup read invariant. `findFirst`
    // (not `findUnique`) because `deletedAt` is not part of a unique index.
    const entry = await prisma.moodEntry.findFirst({
      where: { id, deletedAt: null },
      // The same joins and the same projection as the list read, so an
      // entry opened on its own carries `tagKeys` and `ratedFactors` too.
      include: MOOD_ENTRY_WIRE_INCLUDE,
    });

    if (!entry || entry.userId !== user.id) {
      return apiError("Mood entry not found", 404);
    }

    annotate({
      action: { name: "mood-entries.get" },
      meta: { moodEntryId: id },
    });

    return apiSuccess(toMoodEntryWire(entry));
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Correcting an entry in a record somebody manages.
    const { user } = await requireRecordAuth("manage", "mind");

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

    // v1.4.43 — mood edit hot path; multi-issue 422 + audit
    // breadcrumb keyed `mood-entries.update.validation-failed`.
    const parsed = await parseJsonBody(request, updateMoodEntrySchema, {
      maxBytes: 64 * 1024,
      action: "mood-entries.update.validation-failed",
      countIssues: true,
      meta: { moodEntryId: id },
      errorCode: "mood.update.invalid",
      onInvalid: (error) => {
        // v1.4.49 — strip `message` from the audit-ledger row; mood
        // update carries free-text `note` + `tags`.
        const auditIssues = sanitiseZodIssues(error.issues, {
          stripValuesFromMessage: true,
        });
        // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
        // .create`, because that helper is the only writer that stamps
        // `actorUserId`. Filed under the resolved record either way; without
        // the stamp a manager's malformed payload would read as the owner's own.
        void auditLog("mood-entries.update.validation-failed", {
          userId: user.id,
          details: { issues: auditIssues, moodEntryId: id },
        }).catch(() => {
          /* swallow — 422 response is the contract */
        });
      },
    });
    if (!parsed.ok) return parsed.error;

    const data = parsed.data;

    const updateData: Record<string, unknown> = {};
    if (data.mood !== undefined) {
      updateData.mood = data.mood;
      updateData.score = getScoreForMood(data.mood);
      // v1.37 — pleasantness follows the label the same way `score` does, so
      // an entry corrected from "okay" to "bad" cannot keep yesterday's A1.
      // Only when the label actually moved, though: the edit dialog sends the
      // whole entry back on every save, and re-deriving on an unchanged label
      // would overwrite a value the person set by hand every time they
      // corrected the timestamp. An explicit `a1` below overrides either way.
      if (data.mood !== existing.mood) {
        updateData.moodA1 = deriveA1(data.mood);
      }
    }
    // v1.37 — level-A values are per-field on this path: omitted keeps the
    // stored value, an explicit number replaces it, an explicit null clears
    // it. Built one at a time from the parsed body, never spread.
    //
    // Pleasantness is the exception, and it is the same exception the create
    // path makes: an entry always carries a five-point label, so it always
    // implies a pleasantness value, and a null falls back to the derivation
    // rather than emptying the column. One rule on both routes — the capture
    // surfaces therefore offer no clear control for it.
    if (data.a1 !== undefined) {
      updateData.moodA1 = data.a1 ?? deriveA1(data.mood ?? existing.mood);
    }
    if (data.a2 !== undefined) updateData.stressA2 = data.a2;
    if (data.a3 !== undefined) updateData.energyA3 = data.a3;
    if (data.a4 !== undefined) updateData.connectionA4 = data.a4;
    if (data.a5 !== undefined) updateData.stabilityA5 = data.a5;
    if (data.moodLoggedAt !== undefined) {
      // v1.4.25 — re-anchor the row's `date` to the user's current
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
        // Each replacement returns the submitted keys it could not store,
        // reported on the response rather than dropped in silence.
        const droppedTagKeys =
          data.tagKeys !== undefined
            ? await replaceTagLinks(id, user.id, data.tagKeys ?? [], tx)
            : [];
        let droppedFactorKeys: string[] = [];
        if (data.ratedFactors !== undefined) {
          droppedFactorKeys = await replaceRatedFactorLinks(
            id,
            user.id,
            data.ratedFactors ?? [],
            tx,
          );
        }

        // v1.38 — the day context replaces whole when the request carried
        // one, and is left alone when it did not, matching the two link sets
        // above. Inside the same transaction: a context write that fails rolls
        // the edit and its syncVersion increment back with it.
        const contextOutcome = await persistMoodContext(
          tx,
          id,
          user.id,
          data.context,
        );
        const storedContext = await tx.moodContext.findUnique({
          where: { moodEntryId: id },
        });

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
          contextOutcome,
          droppedKeys: { droppedTagKeys, droppedFactorKeys },
          persistedContext: storedContext,
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
    const {
      entry,
      persistedTagKeys,
      persistedRatedFactors,
      persistedContext,
      contextOutcome,
      droppedKeys,
    } = transactionOutcome.result;

    await auditLog("moodEntry.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The replaced fields. The note and the free-text tags are named
      // and never quoted; the note is encrypted at rest.
      details: {
        moodEntryId: id,
        ...overwriteDetails({
          before: {
            mood: existing.mood,
            score: existing.score,
            moodLoggedAt: existing.moodLoggedAt,
          },
          after: {
            mood: entry.mood,
            score: entry.score,
            moodLoggedAt: entry.moodLoggedAt,
          },
          redacted: [
            ...(data.note !== undefined ? ["note"] : []),
            ...(data.tags !== undefined ? ["tags"] : []),
            ...(data.tagKeys !== undefined ? ["tagKeys"] : []),
            ...(data.ratedFactors !== undefined ? ["ratedFactors"] : []),
            ...(data.context !== undefined ? ["context"] : []),
          ],
        }),
      },
    });

    annotate({
      action: { name: "mood-entries.update" },
      meta: {
        moodEntryId: id,
        mood_context: contextOutcome,
        dropped_tag_keys: droppedKeys.droppedTagKeys.length,
        dropped_factor_keys: droppedKeys.droppedFactorKeys.length,
      },
    });

    // v1.4.34 — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 — refresh the persisted rollup for the new
    // bucket AND the old bucket when the entry's `moodLoggedAt`
    // changed. The two recomputes are independent (different
    // (user, day) tuples) so we fan them out in parallel. Best-
    // effort: rollup failures must not surface as 5xx.
    try {
      // v1.32.12 — key on the `date` label. When the update moved the
      // entry across a local-day boundary its `date` changed, so both
      // the old and new labels need a recompute (independent buckets).
      const targets = new Set<string>([entry.date]);
      if (existing.date !== entry.date) {
        targets.add(existing.date);
      }
      await Promise.all(
        Array.from(targets).map((label) =>
          recomputeMoodBucketsForEntry(user.id, label),
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
      // v1.37 — level-A values under the keys the write path takes.
      ...shapeLevelA(entry),
      tags: parseTags(entry.tags),
      // v1.8.5 — surface the persisted structured-tag keys so a client
      // hydrating from the update response renders the tag set without a
      // refetch (shape-matches the list GET).
      tagKeys: persistedTagKeys,
      ratedFactors: persistedRatedFactors,
      // v1.38 — the stored context after the edit, or null when there is none.
      context: persistedContext ? contextForWire(persistedContext) : null,
      // Submitted keys that are not on the entry after the edit, each list
      // present only when non-empty (an archived link the edit preserved is
      // on the entry and is not listed).
      ...droppedLinkKeysForWire(droppedKeys),
    });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Soft delete with `mood-entries/restore` beside it.
    const { user } = await requireRecordAuth("manage", "mind");

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

    // v1.4.34 — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 — refresh the persisted rollup for the
    // deleted entry's bucket; the recompute helper handles the
    // "now-empty day → drop the rollup row" branch internally.
    try {
      await recomputeMoodBucketsForEntry(user.id, existing.date);
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
