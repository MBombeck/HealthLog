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
  createMoodEntrySchema,
  listMoodEntriesSchema,
  getScoreForMood,
} from "@/lib/validations/moodlog";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { encryptNote, readNote, shapeMoodNote } from "@/lib/crypto/note-cipher";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import { pushMoodEntriesToMoodLog } from "@/lib/moodlog/push";
import {
  createTagLinks,
  RatedFactorOutOfRangeError,
} from "@/lib/mood/tag-links";

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags) as string[];
  } catch {
    return [];
  }
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMoodEntriesSchema.safeParse(params);
  if (!parsed.success) {
    // v1.4.43 W6 — surface every Zod issue + audit breadcrumb keyed
    // `mood-entries.list.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "mood-entries.list.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row so Zod
    // codes that embed the offending value (`invalid_enum_value` etc.)
    // cannot leak user-typed content. Mood-entries carry free-text
    // `note` + `tags`; defensive strip everywhere mood content can
    // reach a Zod issue.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "mood-entries.list.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.list.invalid",
    });
  }

  const { mood, source, from, to, limit, offset, sortBy, sortDir } =
    parsed.data;

  const where = {
    userId: user.id,
    // v1.7.0 sync — hide soft-deleted (tombstoned) rows from the list.
    deletedAt: null,
    ...(mood && { mood }),
    // v1.15.13 — management-list source filter.
    ...(source && { source }),
    ...(from || to
      ? {
          date: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  const [entries, total] = await Promise.all([
    prisma.moodEntry.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      take: limit,
      skip: offset,
      // v1.8.5 — include the structured-tag link keys so the edit form
      // can pre-populate the taxonomy picker.
      // v1.12.0 — also carry the per-link `rating` + the tag `kind` so
      // the client can split binary tags from rated factors on hydrate.
      include: {
        tagLinks: {
          select: {
            rating: true,
            moodTag: { select: { key: true, kind: true } },
          },
        },
      },
    }),
    prisma.moodEntry.count({ where }),
  ]);

  annotate({
    action: { name: "mood-entries.list" },
    meta: { total, limit, offset },
  });

  const entriesWithParsedTags = entries.map(({ tagLinks, ...e }) => ({
    // v1.23 — decrypt `noteEncrypted` onto `note`, strip the ciphertext.
    ...shapeMoodNote(e),
    tags: parseTags(e.tags),
    // v1.8.5 — flat list of binary structured-tag keys attached to the
    // entry (rated factors are surfaced separately below).
    tagKeys: tagLinks
      .filter((link) => link.moodTag.kind !== "RATED")
      .map((link) => link.moodTag.key),
    // v1.12.0 — rated factors with their per-entry score, so the edit
    // form re-renders the sliders without a refetch.
    ratedFactors: tagLinks
      .filter((link) => link.moodTag.kind === "RATED" && link.rating !== null)
      .map((link) => ({
        key: link.moodTag.key,
        rating: link.rating as number,
      })),
  }));

  return apiSuccess({
    entries: entriesWithParsedTags,
    meta: { total, limit, offset },
  });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postMoodEntry));

async function postMoodEntry(request: NextRequest) {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = createMoodEntrySchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — iOS mood log hot path; multi-issue 422 + audit
    // breadcrumb keyed `mood-entries.create.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "mood-entries.create.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; the
    // mood-create schema's free-text `note` + `tags` could land in a
    // Zod issue message verbatim.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "mood-entries.create.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.create.invalid",
    });
  }

  const {
    mood,
    tags,
    tagKeys,
    ratedFactors,
    note,
    moodLoggedAt,
    source,
    externalId,
  } = parsed.data;
  // v1.4.25 W7b (Decision A) — anchor the `date` string to the user's
  // current displayTimezone and store the resolved zone on the row.
  // Legacy rows with `tz IS NULL` continue to read as Europe/Berlin
  // (see `src/lib/mood/date-key.ts`).
  const tz = user.timezone ?? DEFAULT_TIMEZONE;
  const date = moodDateKey(moodLoggedAt, tz);
  const score = getScoreForMood(mood);
  // v1.12.1 — `source` carries a schema default of "MANUAL"; resolve it
  // once so the externalId upsert key (`(userId, source, externalId)`)
  // and the row write agree on the exact value.
  const resolvedSource = source ?? "MANUAL";

  try {
    // v1.8.5 — write the entry and its structured-tag links in one
    // transaction. The links are user-intended content, not a cache, so a
    // tag-link failure must roll the entry back too — otherwise a client
    // retry on the 5xx mints a duplicate entry. The tx client is threaded
    // through the helper so both writes commit (or abort) together.
    const { entry, persistedTagKeys, persistedRatedFactors } =
      await prisma.$transaction(async (tx) => {
        // v1.12.1 — when the client supplies a source-stable `externalId`,
        // upsert on the NULL-distinct `(userId, source, externalId)` key so
        // a re-post with the same id updates the existing row in place
        // (idempotent re-import) instead of minting a duplicate or 409-ing.
        // Without an `externalId`, fall back to the legacy first-write
        // `create` exactly as before — a same-tuple re-post then trips the
        // `(userId, date, moodLoggedAt)` unique and surfaces as a 409 below.
        const created = externalId
          ? await tx.moodEntry.upsert({
              where: {
                userId_source_externalId: {
                  userId: user.id,
                  source: resolvedSource,
                  externalId,
                },
              },
              create: {
                userId: user.id,
                date,
                tz,
                mood,
                score,
                tags: tags ? JSON.stringify(tags) : null,
                note: null,
                noteEncrypted: encryptNote(note ?? null),
                source: resolvedSource,
                externalId,
                moodLoggedAt,
              },
              update: {
                date,
                tz,
                mood,
                score,
                tags: tags ? JSON.stringify(tags) : null,
                note: null,
                noteEncrypted: encryptNote(note ?? null),
                moodLoggedAt,
              },
            })
          : await tx.moodEntry.create({
              data: {
                userId: user.id,
                date,
                tz,
                mood,
                score,
                tags: tags ? JSON.stringify(tags) : null,
                note: null,
                noteEncrypted: encryptNote(note ?? null),
                source: resolvedSource,
                moodLoggedAt,
              },
            });

        if (
          (tagKeys && tagKeys.length > 0) ||
          (ratedFactors && ratedFactors.length > 0)
        ) {
          // Unknown / non-RATED keys are dropped inside the helper (the
          // catalog is the source of truth). An out-of-scale rating
          // throws `RatedFactorOutOfRangeError`, rolling the tx back.
          await createTagLinks(
            created.id,
            user.id,
            tagKeys ?? [],
            tx,
            ratedFactors ?? [],
          );
        }

        // v1.8.5 / v1.12.0 — read the persisted links back so the create
        // response mirrors the list GET shape exactly: binary keys and
        // rated factors split by `kind` (unknown keys already filtered).
        const links = await tx.moodEntryTagLink.findMany({
          where: { moodEntryId: created.id },
          select: {
            rating: true,
            moodTag: { select: { key: true, kind: true } },
          },
        });

        return {
          entry: created,
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

    await auditLog("moodEntry.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: entry.id, mood },
    });

    annotate({
      action: { name: "mood-entries.create" },
      meta: { moodEntryId: entry.id, mood },
    });

    // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 W-MOOD — refresh the persisted DAY rollup for the
    // entry's bucket and enqueue the WEEK / MONTH / YEAR folds.
    // Best-effort: a failure here must not surface as a 5xx to the
    // user, the rollup is a cache tier, not a write-path invariant.
    try {
      await recomputeMoodBucketsForEntry(user.id, moodLoggedAt);
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }

    // v1.4.50 — reverse-sync push to MoodLog. Fire-and-forget; the
    // helper itself is best-effort and never throws, so a 502 from
    // MoodLog or a transient network blip can never bubble back to
    // the user's create. The pull side (15-min cron) backfills any
    // entry that fails the push window. Entries with `source ===
    // "MOODLOG"` skip inside the helper to avoid an echo loop.
    void pushMoodEntriesToMoodLog(user.id, [
      {
        date: entry.date,
        moodLoggedAt: entry.moodLoggedAt,
        mood: entry.mood,
        note: readNote(entry.noteEncrypted, entry.note),
        tags: entry.tags,
        source: entry.source,
      },
    ]).catch(() => {
      // The helper already wraps its own errors in wide-event
      // warnings. The void + .catch is defence-in-depth so a
      // synchronous throw inside the helper's promise chain (e.g. a
      // future refactor that adds an await on a rejected promise
      // before the first try/catch) can't surface as an unhandled
      // rejection in the Next.js runtime.
    });

    return apiSuccess(
      {
        // v1.23 — decrypt `noteEncrypted` onto `note`, strip the ciphertext.
        ...shapeMoodNote(entry),
        tags: parseTags(entry.tags),
        // v1.8.5 — surface the persisted structured-tag keys so a client
        // hydrating from the create response renders the tag set without a
        // refetch (shape-matches the list GET).
        tagKeys: persistedTagKeys,
        // v1.12.0 — rated factors with their per-entry score.
        ratedFactors: persistedRatedFactors,
      },
      201,
    );
  } catch (err) {
    // v1.12.0 — a factor rating outside its catalog scale is a client
    // error, not a 5xx. The Zod schema only enforces the 1..5 envelope;
    // the per-tag scale (e.g. 1..2 for conflict) is the real gate.
    if (err instanceof RatedFactorOutOfRangeError) {
      annotate({
        action: { name: "mood-entries.create.rated-factor-out-of-range" },
        meta: { scaleMin: err.scaleMin, scaleMax: err.scaleMax },
      });
      return apiError(err.message, 422, {
        errorCode: "mood.ratedFactor.out_of_range",
      });
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return apiError("A mood entry with this data already exists", 409, {
        errorCode: "mood.duplicate_timestamp",
      });
    }
    throw err;
  }
}
