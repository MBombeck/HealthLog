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
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";
import {
  createMoodEntrySchema,
  listMoodEntriesSchema,
  getScoreForMood,
} from "@/lib/validations/mood";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { encryptNote, shapeMoodNote } from "@/lib/crypto/note-cipher";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { levelAForWrite, shapeLevelA } from "@/lib/mood/level-a";
import { contextForWire, persistMoodContext } from "@/lib/mood/context";
import { listMoodEntriesPage } from "@/lib/mood/list-read";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
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
  const { user } = await requireRecordAuth("read", "mind");

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
    // v1.36.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only thing that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a delegate's malformed query would read as the owner's own.
    void auditLog("mood-entries.list.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.list.invalid",
    });
  }

  // The query + wire shaping (note decryption, tag split, day context) live
  // in the shared list read so this route and the `/mood` SSR prefetch
  // cannot drift.
  const body = await listMoodEntriesPage(user.id, parsed.data);

  annotate({
    action: { name: "mood-entries.list" },
    meta: {
      total: body.meta.total,
      limit: body.meta.limit,
      offset: body.meta.offset,
    },
  });

  return apiSuccess(body);
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postMoodEntry));

async function postMoodEntry(request: NextRequest) {
  // v1.37.0 — MANAGE. A mood row entered by a manager is an observation
  // transcribed, and the audit trail says so for the retention window. What
  // the delegated arm does not get is the sync client's upsert handle; see
  // the `externalId` refusal below.
  const { user, actor } = await requireRecordAuth("manage", "mind");

  // Shared per-account write ceiling — see `checkRecordWriteRateLimit`. The
  // batch siblings have always been capped; the per-record creates a looping
  // client hits were not.
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = createMoodEntrySchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — iOS mood log hot path; multi-issue 422 + audit
    // breadcrumb keyed `mood-entries.create.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    const shape = unstableExternalIdShape(body);
    annotate({
      action: { name: "mood-entries.create.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...(shape ? unstableExternalIdMeta("mood.create", [shape]) : {}),
      },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; the
    // mood-create schema's free-text `note` + `tags` could land in a
    // Zod issue message verbatim.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only writer that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a manager's malformed payload would read as the owner's own.
    void auditLog("mood-entries.create.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
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
    context,
    moodLoggedAt,
    source,
    externalId,
  } = parsed.data;
  // v1.37 — the five level-A values, built field by field from the parsed
  // body (never spread) and resolved once for every branch below. A1 falls
  // back to the derivation from `mood`; the other four are whatever the user
  // set, or nothing.
  const levelA = levelAForWrite(mood, {
    a1: parsed.data.a1,
    a2: parsed.data.a2,
    a3: parsed.data.a3,
    a4: parsed.data.a4,
    a5: parsed.data.a5,
  });
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

  // C6 — the delegated arm refuses `externalId`. It is the sync client's dedup
  // handle: supplying it turns this create into an upsert on
  // `(userId, source, externalId)`, which is a device's contract with its own
  // rows and not something a second person should be able to aim at somebody
  // else's record. A person entering a mood through the UI never sends one.
  if (actor.id !== user.id && externalId) {
    annotate({
      action: { name: "mood-entries.create.external-id-refused" },
      meta: { delegated: true },
    });
    return apiError(
      "externalId cannot be supplied on a record you manage",
      422,
      { errorCode: "mood.create.external_id_not_delegable" },
    );
  }

  try {
    // v1.8.5 — write the entry and its structured-tag links in one
    // transaction. The links are user-intended content, not a cache, so a
    // tag-link failure must roll the entry back too — otherwise a client
    // retry on the 5xx mints a duplicate entry. The tx client is threaded
    // through the helper so both writes commit (or abort) together.
    const {
      entry,
      persistedTagKeys,
      persistedRatedFactors,
      persistedContext,
      contextOutcome,
    } = await prisma.$transaction(async (tx) => {
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
              ...levelA,
              tags: tags ? JSON.stringify(tags) : null,
              note: null,
              noteEncrypted: encryptNote(note ?? null),
              source: resolvedSource,
              externalId,
              moodLoggedAt,
            },
            // A re-post restates pleasantness, because the label it carries
            // always implies one and a stale A1 beside a changed mood would
            // contradict the entry's own face. It does NOT restate the other
            // four: `levelA` carries them only when this request did, so a
            // client re-posting without sliders — the phone, whose build has
            // none — leaves the stress and energy somebody answered on the
            // web exactly where they were. An explicit null clears one.
            update: {
              date,
              tz,
              mood,
              score,
              ...levelA,
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
              // A fresh row: an omitted dimension lands as NULL, which is
              // the same thing the upsert's arms mean by omitting it.
              ...levelA,
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

      // v1.38 — the day context, in the SAME transaction as the entry and
      // its links, for the same reason they are: it is user-intended
      // content, not a cache, so a context write that fails has to roll the
      // entry back rather than leave a client retrying a 5xx into a
      // duplicate entry. An absent `context` key leaves a stored one alone;
      // a context that says nothing removes the row.
      const contextOutcome = await persistMoodContext(
        tx,
        created.id,
        user.id,
        context,
      );
      const storedContext = await tx.moodContext.findUnique({
        where: { moodEntryId: created.id },
      });

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
        contextOutcome,
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

    await auditLog("moodEntry.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: entry.id, mood },
    });

    annotate({
      action: { name: "mood-entries.create" },
      // `mood_context` says written / removed / untouched rather than a
      // boolean, because "the request said nothing" and "the request cleared
      // it" are different acts and a dashboard that folded them together
      // could not tell an abandoned section from a deliberate one.
      meta: { moodEntryId: entry.id, mood, mood_context: contextOutcome },
    });

    // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 W-MOOD — refresh the persisted DAY rollup for the
    // entry's bucket and enqueue the WEEK / MONTH / YEAR folds.
    // Best-effort: a failure here must not surface as a 5xx to the
    // user, the rollup is a cache tier, not a write-path invariant.
    try {
      await recomputeMoodBucketsForEntry(user.id, date);
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }

    return apiSuccess(
      {
        // v1.23 — decrypt `noteEncrypted` onto `note`, strip the ciphertext.
        // v1.37 — level-A values under their wire keys (see the list read).
        ...shapeLevelA(shapeMoodNote(entry)),
        tags: parseTags(entry.tags),
        // v1.8.5 — surface the persisted structured-tag keys so a client
        // hydrating from the create response renders the tag set without a
        // refetch (shape-matches the list GET).
        tagKeys: persistedTagKeys,
        // v1.12.0 — rated factors with their per-entry score.
        ratedFactors: persistedRatedFactors,
        // v1.38 — the stored context, lists decoded and note decrypted. Null
        // when the entry carries none, which is a different answer from an
        // object full of nulls and reads as one.
        context: persistedContext ? contextForWire(persistedContext) : null,
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
