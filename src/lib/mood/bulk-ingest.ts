/**
 * The bulk mood ingest behind `POST /api/mood-entries/bulk`.
 *
 * The route authenticates, meters, caps and parses the batch; this module
 * writes it. Per-entry UPSERT keyed by `externalId` when the entry carries
 * one, else by the legacy `(userId, date, moodLoggedAt)` key, so a re-run is
 * idempotent. A bad entry is `skipped` and the rest of the batch lands: an
 * unstable external id, a context outside the vocabulary, dimensions out of
 * range, or a rated factor outside its own scale each refuse that one row.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { markSyncCheckpoint } from "@/lib/sync/checkpoint";
import {
  getScoreForMood,
  moodContextSchema,
  type moodLevelEnum,
  type moodSourceEnum,
} from "@/lib/validations/mood";
import {
  classifyExternalId,
  unstableExternalIdMeta,
  UNSTABLE_EXTERNAL_ID_REASON,
  type UnstableExternalIdShape,
} from "@/lib/validations/external-id";
import { moodDateKey } from "@/lib/mood/date-key";
import { levelAForWrite, type LevelAInput } from "@/lib/mood/level-a";
import { persistMoodContext } from "@/lib/mood/context";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import {
  createTagLinks,
  droppedLinkKeysForWire,
  NO_DROPPED_LINK_KEYS,
  type DroppedLinkKeys,
  type RatedFactorInput,
} from "@/lib/mood/tag-links";

/** One entry as the route's batch schema parsed it. */
export interface BulkMoodEntry {
  mood: z.infer<typeof moodLevelEnum>;
  tags?: string[];
  tagKeys?: string[];
  ratedFactors?: RatedFactorInput[];
  note?: string;
  a1?: unknown;
  a2?: unknown;
  a3?: unknown;
  a4?: unknown;
  a5?: unknown;
  context?: unknown;
  moodLoggedAt: Date;
  source: z.infer<typeof moodSourceEnum>;
  externalId?: string;
}

/**
 * The route's per-entry dimension parse. It stays beside the batch schema
 * so the bound is pinned against the single-entry one
 * (`bulk-dimension-bounds.test.ts`).
 */
export type ParseBulkDimensions = (
  dimensions: Pick<BulkMoodEntry, "a1" | "a2" | "a3" | "a4" | "a5">,
) => { success: true; data: LevelAInput } | { success: false };

type EntryStatus = "inserted" | "duplicate" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  id?: string;
  // Echo the client-supplied source-stable id back on each result so iOS can
  // map a server row id onto its local SwiftData row without re-deriving it.
  // Omitted when the entry sent no externalId.
  externalId?: string;
  // Submitted keys the catalog did not resolve (unknown, archived, another
  // account's custom tag, or the wrong kind). Present only when non-empty,
  // on an "inserted" or "duplicate" result: the entry landed, these did not.
  droppedTagKeys?: string[];
  droppedFactorKeys?: string[];
}

export interface BulkMoodIngestResult {
  processed: number;
  inserted: number;
  duplicates: number;
  skipped: Array<{ index: number; reason: string }>;
  entries: EntryResult[];
}

interface ExistingMoodRow {
  id: string;
  deletedAt: Date | null;
}

interface ExistingRows {
  byExternalKey: Map<string, ExistingMoodRow>;
  byDateKey: Map<string, ExistingMoodRow>;
}

/** The running totals of one batch, filled entry by entry. */
interface Tally {
  results: EntryResult[];
  skipped: Array<{ index: number; reason: string }>;
  inserted: number;
  duplicates: number;
  droppedTagKeyCount: number;
  droppedFactorKeyCount: number;
  unstableShapes: UnstableExternalIdShape[];
}

function echoExternalId(entry: BulkMoodEntry): { externalId?: string } {
  return entry.externalId ? { externalId: entry.externalId } : {};
}

function skip(
  tally: Tally,
  index: number,
  entry: BulkMoodEntry,
  reason: string,
): void {
  tally.skipped.push({ index, reason });
  tally.results.push({
    index,
    status: "skipped",
    reason,
    ...echoExternalId(entry),
  });
}

/**
 * Perf — a single indexed existence read replaces the per-entry `findUnique`
 * probe (up to 500 sequential round trips before). Every entry still resolves
 * through exactly the key its own dedup contract uses (externalId when
 * carried, else the legacy date+moodLoggedAt key), so the lookups are
 * byte-identical to the per-entry probe; only the read is batched. The
 * per-entry `upsert` + tombstone check + tag links stay per entry; batching
 * those further would risk the correctness-sensitive per-row side effects
 * for a write path that is usually small (a normal sync posts the current +
 * previous local day, not a full historical backfill).
 */
async function readExistingRows(
  userId: string,
  tz: string,
  entries: BulkMoodEntry[],
): Promise<ExistingRows> {
  const orClauses: Array<
    | { source: string; externalId: string }
    | { date: string; moodLoggedAt: Date }
  > = entries.map((entry) =>
    entry.externalId
      ? { source: entry.source, externalId: entry.externalId }
      : {
          date: moodDateKey(entry.moodLoggedAt, tz),
          moodLoggedAt: entry.moodLoggedAt,
        },
  );
  const existingRows =
    orClauses.length > 0
      ? await prisma.moodEntry.findMany({
          where: { userId, OR: orClauses },
          select: {
            id: true,
            deletedAt: true,
            source: true,
            externalId: true,
            date: true,
            moodLoggedAt: true,
          },
        })
      : [];
  const byExternalKey = new Map<string, ExistingMoodRow>();
  const byDateKey = new Map<string, ExistingMoodRow>();
  for (const row of existingRows) {
    if (row.externalId !== null) {
      byExternalKey.set(`${row.source}::${row.externalId}`, row);
    }
    byDateKey.set(`${row.date}::${row.moodLoggedAt.toISOString()}`, row);
  }
  return { byExternalKey, byDateKey };
}

/**
 * The upsert and the tag/factor links run in ONE transaction, matching the
 * single-entry POST path. Split apart, an out-of-scale `ratedFactors` value
 * (validated inside `createTagLinks`, i.e. AFTER the row committed) left a
 * persisted mood entry with no links while the per-entry catch reported the
 * entry as "skipped": the client believes nothing saved and a half-written
 * row is on disk.
 */
async function writeEntry(args: {
  userId: string;
  tz: string;
  entry: BulkMoodEntry;
  date: string;
  levelA: ReturnType<typeof levelAForWrite>;
  context: z.infer<typeof moodContextSchema> | null | undefined;
}): Promise<{ id: string; droppedKeys: DroppedLinkKeys }> {
  const { userId, tz, entry, date, levelA } = args;
  const score = getScoreForMood(entry.mood);
  // When the entry carries a source-stable `externalId`, dedup on the
  // NULL-distinct `(userId, source, externalId)` key so a re-post with the
  // same id (an iOS retry after a network hiccup, or a second adopt-on-pair
  // backfill) updates the existing row in place instead of minting a
  // duplicate when `moodLoggedAt` re-rounds / re-zones. Absent → the legacy
  // `(userId, date, moodLoggedAt)` key. `source` carries a schema default of
  // "MANUAL"; resolve it once so the probe, upsert key, and create write all
  // agree on the value.
  const resolvedSource = entry.source;
  const probeWhere = entry.externalId
    ? {
        userId_source_externalId: {
          userId,
          source: resolvedSource,
          externalId: entry.externalId,
        },
      }
    : {
        userId_date_moodLoggedAt: {
          userId,
          date,
          moodLoggedAt: entry.moodLoggedAt,
        },
      };
  return prisma.$transaction(async (tx) => {
    const upserted = await tx.moodEntry.upsert({
      where: probeWhere,
      create: {
        userId,
        date,
        tz,
        mood: entry.mood,
        score,
        ...levelA,
        tags: entry.tags ? JSON.stringify(entry.tags) : null,
        note: null,
        noteEncrypted: encryptNote(entry.note ?? null),
        source: resolvedSource,
        externalId: entry.externalId ?? null,
        moodLoggedAt: entry.moodLoggedAt,
      },
      update: {
        // Last-writer-wins on the mood + tags + note triple. The iOS client
        // only re-posts an existing entry when it has new data; the server
        // trusts that decision. When the dedup key is `externalId`, also
        // refresh `date` / `moodLoggedAt` so a re-zoned re-import lands the
        // corrected wall-clock on the same row.
        mood: entry.mood,
        score,
        ...levelA,
        tags: entry.tags ? JSON.stringify(entry.tags) : null,
        note: null,
        noteEncrypted: encryptNote(entry.note ?? null),
        ...(entry.externalId ? { date, moodLoggedAt: entry.moodLoggedAt } : {}),
      },
    });

    // Structured-tag links, mirroring the single-entry `createTagLinks`
    // path. Additive + idempotent: `createTagLinks` resolves keys against the
    // catalog (dropping unknown keys) and `skipDuplicates` on the join insert
    // keeps a re-posted entry from minting duplicate links. Runs for both
    // fresh and re-posted (upserted) rows so a backfill that adds tag keys on
    // a second pass still lands them. Rated factors ride the same path; an
    // out-of-scale rating throws `RatedFactorOutOfRangeError`, which inside
    // the transaction rolls the mood row back with it, so a "skipped" result
    // means nothing was written. The day context sits inside the same
    // transaction as the row for the same reason.
    await persistMoodContext(tx, upserted.id, userId, args.context);

    // The keys the catalog did not resolve are reported on this entry's
    // result: "inserted" alone told a client its tags had landed.
    let droppedKeys = NO_DROPPED_LINK_KEYS;
    if (
      (entry.tagKeys && entry.tagKeys.length > 0) ||
      (entry.ratedFactors && entry.ratedFactors.length > 0)
    ) {
      droppedKeys = await createTagLinks(
        upserted.id,
        userId,
        entry.tagKeys ?? [],
        tx,
        entry.ratedFactors ?? [],
      );
    }
    return { id: upserted.id, droppedKeys };
  });
}

/**
 * P2002 = a concurrent batch raced the same NULL-distinct
 * `(userId, source, externalId)` key and won. That is the plain duplicate the
 * sequential probe would have classified; reporting it as "skipped" with a
 * raw Prisma message told the client its row was dropped when it is in fact
 * stored. Resolve the winning row's id so the caller's cursor advances,
 * exactly like the intake bulk route.
 */
function isRacedDuplicate(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

async function ingestEntry(args: {
  userId: string;
  tz: string;
  entry: BulkMoodEntry;
  index: number;
  existing: ExistingRows;
  parseDimensions: ParseBulkDimensions;
  tally: Tally;
}): Promise<void> {
  const { userId, tz, entry, index: i, tally } = args;

  // The `(userId, source, externalId)` dedup key only holds while the id is
  // STABLE across client launches; a per-process value (an object
  // description carrying a memory address) mints a fresh entry on every
  // re-post. Per-entry refusal, never a whole-batch 422.
  const unstable =
    entry.externalId === undefined
      ? null
      : classifyExternalId(entry.externalId);
  if (unstable) {
    tally.unstableShapes.push(unstable);
    tally.skipped.push({ index: i, reason: UNSTABLE_EXTERNAL_ID_REASON });
    tally.results.push({
      index: i,
      status: "skipped",
      reason: UNSTABLE_EXTERNAL_ID_REASON,
      externalId: entry.externalId,
    });
    return;
  }

  // The context, parsed for THIS entry. A value outside the vocabulary skips
  // this row and nothing else.
  const parsedContext =
    entry.context === undefined
      ? { success: true as const, data: undefined }
      : moodContextSchema.nullable().safeParse(entry.context);
  if (!parsedContext.success) {
    skip(tally, i, entry, "invalid_context");
    return;
  }

  // The five dimensions, parsed for THIS entry. Out of range skips this row
  // and nothing else.
  const parsedDimensions = args.parseDimensions({
    a1: entry.a1,
    a2: entry.a2,
    a3: entry.a3,
    a4: entry.a4,
    a5: entry.a5,
  });
  if (!parsedDimensions.success) {
    skip(tally, i, entry, "invalid_dimensions");
    return;
  }

  const date = moodDateKey(entry.moodLoggedAt, tz);
  // The same resolution the single-entry path uses: pleasantness derived
  // from the label unless the entry states its own, and the other four
  // present only when this entry carried them. An omitted dimension is left
  // alone rather than written as null, so a row that already carries
  // hand-set values keeps them across a re-import.
  const levelA = levelAForWrite(entry.mood, parsedDimensions.data);

  try {
    // The response distinguishes "inserted" from "duplicate" via the batched
    // pre-read (keyed exactly like the upsert key), so the per-entry probe
    // here is a Map lookup, not a round trip.
    const existing =
      (entry.externalId
        ? args.existing.byExternalKey.get(
            `${entry.source}::${entry.externalId}`,
          )
        : args.existing.byDateKey.get(
            `${date}::${entry.moodLoggedAt.toISOString()}`,
          )) ?? null;

    // Tombstone suppression: a soft-deleted match stays deleted. The
    // user-facing DELETE route flips `deletedAt` so the `/api/sync/changes`
    // feed surfaces the deletion to paired clients offline at delete time
    // (see the MoodEntry schema note); an offline client's later re-post of
    // the same entry is stale state, not a recreation, and must not resurrect
    // the row. True no-op: no value churn, no `updatedAt` bump, no tag-link
    // writes on the hidden row; report `duplicate` so the client checkpoints
    // past it exactly like a live-row match.
    if (existing?.deletedAt) {
      tally.duplicates += 1;
      tally.results.push({
        index: i,
        status: "duplicate",
        id: existing.id,
        ...echoExternalId(entry),
      });
      return;
    }

    const written = await writeEntry({
      userId,
      tz,
      entry,
      date,
      levelA,
      context: parsedContext.data,
    });
    tally.droppedTagKeyCount += written.droppedKeys.droppedTagKeys.length;
    tally.droppedFactorKeyCount += written.droppedKeys.droppedFactorKeys.length;

    if (existing) tally.duplicates += 1;
    else tally.inserted += 1;
    tally.results.push({
      index: i,
      status: existing ? "duplicate" : "inserted",
      id: written.id,
      ...echoExternalId(entry),
      ...droppedLinkKeysForWire(written.droppedKeys),
    });
  } catch (err: unknown) {
    if (isRacedDuplicate(err) && entry.externalId) {
      const winner = await prisma.moodEntry.findFirst({
        where: {
          userId,
          // Same resolution as the upsert key: the schema defaults `source`
          // to "MANUAL" at parse time.
          source: entry.source,
          externalId: entry.externalId,
        },
        select: { id: true },
      });
      tally.duplicates += 1;
      tally.results.push({
        index: i,
        status: "duplicate",
        ...(winner ? { id: winner.id } : {}),
        externalId: entry.externalId,
      });
      return;
    }
    const reason =
      err instanceof Error ? err.message.slice(0, 120) : "upsert_failed";
    skip(tally, i, entry, reason);
  }
}

/**
 * Refresh the rollup tier for every distinct day the batch touched. The bulk
 * endpoint is an iOS one-shot backfill, so the batch can span many days; the
 * set of `date` labels (the same per-row `moodDateKey` the insert used, so
 * the rollup keys byte-identically to the stored `MoodEntry.date`) bounds the
 * recompute count. Best-effort: a rollup failure must not surface as a 5xx.
 */
async function refreshTouchedRollups(
  userId: string,
  tz: string,
  entries: BulkMoodEntry[],
  results: EntryResult[],
): Promise<void> {
  const touchedLabels = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const status = results[i]?.status;
    if (status === "inserted" || status === "duplicate") {
      touchedLabels.add(moodDateKey(entries[i].moodLoggedAt, tz));
    }
  }
  try {
    await Promise.all(
      Array.from(touchedLabels).map((label) =>
        recomputeMoodBucketsForEntry(userId, label),
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

/** Write one parsed batch for `userId` and answer its per-entry envelope. */
export async function ingestMoodBulk(input: {
  userId: string;
  tz: string;
  entries: BulkMoodEntry[];
  ipAddress: string | null;
  parseDimensions: ParseBulkDimensions;
}): Promise<BulkMoodIngestResult> {
  const { userId, tz, entries } = input;
  const tally: Tally = {
    results: [],
    skipped: [],
    inserted: 0,
    duplicates: 0,
    droppedTagKeyCount: 0,
    droppedFactorKeyCount: 0,
    unstableShapes: [],
  };
  const existing = await readExistingRows(userId, tz, entries);

  for (let i = 0; i < entries.length; i++) {
    await ingestEntry({
      userId,
      tz,
      entry: entries[i],
      index: i,
      existing,
      parseDimensions: input.parseDimensions,
      tally,
    });
  }

  await auditLog("mood.bulk.ingest", {
    userId,
    ipAddress: input.ipAddress,
    details: {
      processed: entries.length,
      inserted: tally.inserted,
      duplicates: tally.duplicates,
      skipped: tally.skipped.length,
    },
  });

  annotate({
    action: { name: "mood.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted: tally.inserted,
      duplicates: tally.duplicates,
      skipped: tally.skipped.length,
      dropped_tag_keys: tally.droppedTagKeyCount,
      dropped_factor_keys: tally.droppedFactorKeyCount,
      ...(tally.unstableShapes.length > 0
        ? unstableExternalIdMeta("mood.bulk", tally.unstableShapes)
        : {}),
    },
  });

  // Bust the per-user mood + achievements + analytics caches when at least
  // one row landed so the next read picks up the ingested batch. Skipped /
  // duplicate-only ingests are no-ops.
  if (tally.inserted > 0) {
    invalidateUserMood(userId);
  }

  if (tally.inserted > 0 || tally.duplicates > 0) {
    await refreshTouchedRollups(userId, tz, entries, tally.results);
  }

  // The SyncMode checkpoint belongs to the push that moved the data, not to
  // the `/api/sync/state` handshake that reports it. This endpoint is one of
  // the three domains that handshake summarises, so a mood drain advances it.
  await markSyncCheckpoint(userId);

  return {
    processed: entries.length,
    inserted: tally.inserted,
    duplicates: tally.duplicates,
    skipped: tally.skipped,
    entries: tally.results,
  };
}
