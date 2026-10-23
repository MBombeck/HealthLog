/**
 * The mood rows of a JSON import (`POST /api/import`).
 *
 * A row with an external id upserts on `(userId, source, externalId)`. A row
 * without a logged instant gets a stable fallback instant inside its day,
 * derived from the row's content and its occurrence in the file, so the same
 * file lands on the same instants every time and twin rows land on distinct
 * ones.
 *
 * Each entry is written with its note, its level-A values, its zone, its day
 * context and its tag and factor links, in one transaction, the way the bulk
 * mood ingest writes one: a link that throws (a rating outside its factor's
 * own scale) takes the entry back with it, so a skipped row left nothing
 * behind.
 */
import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { ENTRY_INSTANT_CLOCK_SKEW_MS } from "@/lib/validations/entry-instant";
import { classifyExternalId } from "@/lib/validations/external-id";
import { isP2002 } from "@/lib/prisma-errors";
import { levelAForWrite } from "@/lib/mood/level-a";
import { persistMoodContext } from "@/lib/mood/context";
import {
  RatedFactorOutOfRangeError,
  replaceRatedFactorLinks,
  replaceTagLinks,
} from "@/lib/mood/tag-links";

import { fallbackMoodDateStart } from "./mood-instant";
import type { JsonImportMoodEntry } from "./schema";
import type { JsonImportTally } from "./tally";

export type { JsonImportMoodEntry } from "./schema";

function fallbackMoodIdentity(entry: JsonImportMoodEntry): string {
  return JSON.stringify([
    entry.date,
    entry.mood,
    entry.score,
    entry.tags ?? null,
    entry.externalId ?? null,
  ]);
}

function stableFallbackMoodInstant(
  entry: JsonImportMoodEntry,
  occurrence: number,
  probe: number,
): Date {
  const digest = createHash("sha256")
    .update(`${fallbackMoodIdentity(entry)}:${occurrence}`)
    .digest();
  const initialOffset = digest.readUInt32BE(0) % ENTRY_INSTANT_CLOCK_SKEW_MS;
  const offset = (initialOffset + probe) % ENTRY_INSTANT_CLOCK_SKEW_MS;
  const dateStart = fallbackMoodDateStart(entry.date);
  if (!dateStart) throw new Error("Invalid mood date");
  return new Date(dateStart.getTime() + offset);
}

/** The fallback instants this import has handed out, and how often each row content occurred. */
interface FallbackState {
  occurrences: Map<string, number>;
  reserved: Set<number>;
}

/**
 * The entry's own columns, as both arms of the write state them. The level-A
 * values follow `levelAForWrite`: the file's `a1` wins over the one derived
 * from the label, and an `a2` to `a5` the file leaves out is left alone on a
 * row the import updates rather than blanked.
 */
function moodEntryColumns(e: JsonImportMoodEntry, loggedAt: Date) {
  return {
    date: e.date,
    mood: e.mood,
    score: e.score,
    ...levelAForWrite(e.mood, {
      a1: e.a1,
      a2: e.a2,
      a3: e.a3,
      a4: e.a4,
      a5: e.a5,
    }),
    tags: e.tags || null,
    note: null,
    noteEncrypted: encryptNote(e.note ?? null),
    ...(e.tz === undefined ? {} : { tz: e.tz }),
    moodLoggedAt: loggedAt,
  };
}

/** Link keys an entry's write could not resolve. */
interface DroppedKeys {
  tags: Set<string>;
  factors: Set<string>;
}

/** The entry's links and day context, when the file states them. */
async function writeMoodEntryParts(
  tx: Prisma.TransactionClient,
  userId: string,
  moodEntryId: string,
  e: JsonImportMoodEntry,
  dropped: DroppedKeys,
): Promise<void> {
  await persistMoodContext(tx, moodEntryId, userId, e.context);
  if (e.factors !== undefined) {
    const keys = await replaceRatedFactorLinks(
      moodEntryId,
      userId,
      e.factors,
      tx,
    );
    for (const key of keys) dropped.factors.add(key);
  }
  if (e.structuredTags !== undefined) {
    const keys = await replaceTagLinks(
      moodEntryId,
      userId,
      e.structuredTags,
      tx,
    );
    for (const key of keys) dropped.tags.add(key);
  }
}

async function writeMoodEntry(
  userId: string,
  e: JsonImportMoodEntry,
  loggedAt: Date,
  tally: JsonImportTally,
): Promise<void> {
  const columns = moodEntryColumns(e, loggedAt);
  // Links resolve against what the importing account can see. Collected
  // here and handed to the tally only once the transaction committed, so a
  // rolled-back entry reports nothing.
  const dropped: DroppedKeys = { tags: new Set(), factors: new Set() };
  await prisma.$transaction(async (tx) => {
    // Idempotent re-import keyed on the source-stable id. A second import
    // of the same export updates the row in place rather than skipping it as
    // a duplicate, so an upstream edit (re-scored mood, added tag) is
    // reflected.
    const row = e.externalId
      ? await tx.moodEntry.upsert({
          where: {
            userId_source_externalId: {
              userId,
              source: "IMPORT",
              externalId: e.externalId,
            },
          },
          update: columns,
          create: {
            userId,
            ...columns,
            source: "IMPORT",
            externalId: e.externalId,
          },
          select: { id: true },
        })
      : await tx.moodEntry.create({
          data: { userId, ...columns, source: "IMPORT" },
          select: { id: true },
        });
    await writeMoodEntryParts(tx, userId, row.id, e, dropped);
  });
  for (const key of dropped.tags) tally.droppedTagKeys.add(key);
  for (const key of dropped.factors) tally.droppedFactorKeys.add(key);
}

/**
 * Whether the row already stored at `loggedAt` is this very fallback row
 * from an earlier import of the same file. Throws when the probe fails.
 */
async function sameImportedRow(
  userId: string,
  e: JsonImportMoodEntry,
  loggedAt: Date,
): Promise<boolean> {
  const existing = await prisma.moodEntry.findUnique({
    where: {
      userId_date_moodLoggedAt: {
        userId,
        date: e.date,
        moodLoggedAt: loggedAt,
      },
    },
    select: {
      source: true,
      mood: true,
      score: true,
      tags: true,
      externalId: true,
    },
  });
  return (
    existing?.source === "IMPORT" &&
    existing.mood === e.mood &&
    existing.score === e.score &&
    existing.tags === (e.tags || null) &&
    (existing.externalId ?? null) === null
  );
}

async function importMoodEntry(
  userId: string,
  e: JsonImportMoodEntry,
  fallback: FallbackState,
  tally: JsonImportTally,
): Promise<void> {
  // Same stability floor as the measurement rows: the mood upsert keys on
  // `(userId, source, externalId)`.
  const unstableMood =
    e.externalId === undefined ? null : classifyExternalId(e.externalId);
  if (unstableMood) {
    tally.unstableShapes.push(unstableMood);
    tally.stats.skipped++;
    return;
  }
  const identity = e.loggedAt ? null : fallbackMoodIdentity(e);
  const occurrence =
    identity === null ? 0 : (fallback.occurrences.get(identity) ?? 0);
  if (identity !== null) {
    fallback.occurrences.set(identity, occurrence + 1);
  }

  for (let probe = 0; probe < ENTRY_INSTANT_CLOCK_SKEW_MS; probe++) {
    const loggedAt =
      e.loggedAt ?? stableFallbackMoodInstant(e, occurrence, probe);
    if (!e.loggedAt && fallback.reserved.has(loggedAt.getTime())) {
      continue;
    }
    try {
      await writeMoodEntry(userId, e, loggedAt, tally);
      if (!e.loggedAt) {
        fallback.reserved.add(loggedAt.getTime());
      }
      tally.stats.moodEntries++;
      return;
    } catch (err) {
      // A rating outside its factor's own scale refuses that one entry, the
      // way the bulk ingest refuses it; the transaction took the row back.
      if (err instanceof RatedFactorOutOfRangeError) {
        tally.stats.skipped++;
        return;
      }
      if (!isP2002(err)) {
        tally.writeFailed = true;
        return;
      }
      if (e.loggedAt) {
        tally.stats.skipped++;
        return;
      }
      if (!e.externalId) {
        try {
          if (await sameImportedRow(userId, e, loggedAt)) {
            fallback.reserved.add(loggedAt.getTime());
            tally.stats.skipped++;
            return;
          }
        } catch {
          tally.writeFailed = true;
          return;
        }
      }
      if (probe === ENTRY_INSTANT_CLOCK_SKEW_MS - 1) {
        tally.writeFailed = true;
      }
    }
  }
}

/**
 * Write `rows` for `userId`, counting into `tally`. Stops at the first row
 * whose write failed for a reason other than a duplicate.
 */
export async function importJsonMoodEntries(
  userId: string,
  rows: JsonImportMoodEntry[],
  tally: JsonImportTally,
): Promise<void> {
  const fallback: FallbackState = {
    occurrences: new Map(),
    reserved: new Set(),
  };
  for (const e of rows) {
    await importMoodEntry(userId, e, fallback, tally);
    if (tally.writeFailed) break;
  }
}
