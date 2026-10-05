/**
 * v1.23 — boot-time converging backfill that migrates the two free-text
 * health-note columns from plaintext to AES-256-GCM at rest:
 * `MoodEntry.note` -> `MoodEntry.noteEncrypted` and
 * `Measurement.notes` -> `Measurement.notesEncrypted`.
 *
 * Modelled on `mean-consolidation.ts` / `rollup-full-backfill`: a discovery
 * query enqueues one job per user still holding an un-migrated row, the
 * per-user handler walks that user's rows, and the pass is idempotent across
 * reboots — once a row is migrated it drops off the discovery + candidate sets.
 *
 * DATA-LOSS SAFETY (the property the security review must confirm):
 *  - Per row, the encrypt-then-null happens in a SINGLE interactive
 *    transaction guarded by a re-read inside the tx, so the plaintext column is
 *    only nulled AFTER the ciphertext is committed in the same atomic unit. A
 *    row that had content is never left both-null.
 *  - FAIL-CLOSED: `encryptNote` throws on a missing / malformed key. The throw
 *    aborts the transaction (the plaintext row is untouched) and propagates so
 *    pg-boss retries — the backfill never silently drops a note or writes a
 *    plaintext-shaped value into the ciphertext column.
 *  - IDEMPOTENT: the per-row guard (`notesEncrypted IS NULL AND notes != null`)
 *    is re-checked inside the tx, so a re-run — or two workers racing — migrates
 *    a row at most once; a second pass migrates zero rows.
 *
 * The legacy plaintext columns are intentionally NOT dropped in this release.
 * That is a deliberate FOLLOW-UP release boundary, once this backfill reports
 * zero remaining un-migrated rows on every instance — the same discipline the
 * encryption-key-rotation playbook uses before dropping a legacy key.
 *
 * The queue name MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it at
 * boot; an unregistered queue silently never drains.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { encryptNote } from "@/lib/crypto/note-cipher";

export const NOTE_ENCRYPTION_BACKFILL_QUEUE = "note-encryption-backfill";

/**
 * Serial concurrency — the populator walks a user's plaintext-note rows and
 * writes one transaction per row; concurrency-1 keeps it off the request pool,
 * matching the consolidation / rollup-backfill convention.
 */
export const NOTE_ENCRYPTION_BACKFILL_CONCURRENCY = 1;

/** How many candidate rows to pull per page within a user's pass. */
const PAGE_SIZE = 200;

export interface NoteEncryptionBackfillPayload {
  /** Absent on the daily discovery tick; present for a per-user job. */
  userId?: string;
  enqueuedAt?: string;
}

export interface NoteEncryptionBackfillSummary {
  measurementsMigrated: number;
  moodEntriesMigrated: number;
}

/**
 * Migrate one measurement row's plaintext `notes` into `notesEncrypted` and
 * null the plaintext — atomically and idempotently. Returns true if it
 * migrated the row, false if a concurrent pass already did.
 */
async function migrateMeasurementRow(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.measurement.findUnique({
      where: { id },
      select: { notes: true, notesEncrypted: true, updatedAt: true },
    });
    // Already migrated (ciphertext present) or nothing to migrate.
    if (!fresh || fresh.notesEncrypted || fresh.notes === null) return false;
    // FAIL-CLOSED: a key error throws here and rolls the tx back, leaving the
    // plaintext row untouched.
    const encrypted = encryptNote(fresh.notes);
    // `updatedAt` is the sync cursor; a storage-only rewrite carries it so no
    // client re-pulls a reading that did not change.
    const { count } = await tx.measurement.updateMany({
      where: { id, updatedAt: fresh.updatedAt },
      data: {
        notesEncrypted: encrypted,
        notes: null,
        updatedAt: fresh.updatedAt,
      },
    });
    return count === 1;
  });
}

/**
 * Migrate one mood row's plaintext `note` into `noteEncrypted` and null the
 * plaintext — atomically and idempotently.
 */
async function migrateMoodRow(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.moodEntry.findUnique({
      where: { id },
      select: { note: true, noteEncrypted: true, updatedAt: true },
    });
    if (!fresh || fresh.noteEncrypted || fresh.note === null) return false;
    const encrypted = encryptNote(fresh.note);
    const { count } = await tx.moodEntry.updateMany({
      where: { id, updatedAt: fresh.updatedAt },
      data: {
        noteEncrypted: encrypted,
        note: null,
        updatedAt: fresh.updatedAt,
      },
    });
    return count === 1;
  });
}

/**
 * Per-user queue handler. Walks every un-migrated measurement + mood note for
 * one account and migrates each in its own transaction. Safe to re-run.
 */
export async function runNoteEncryptionBackfillForUser(
  userId: string,
): Promise<NoteEncryptionBackfillSummary> {
  let measurementsMigrated = 0;
  let moodEntriesMigrated = 0;

  // Measurements — page through candidates until the predicate is empty.
  // Each migration nulls `notes`, so a migrated row drops out of the next
  // `notes: { not: null }, notesEncrypted: null` page.
  for (;;) {
    const rows = await prisma.measurement.findMany({
      where: { userId, notes: { not: null }, notesEncrypted: null },
      select: { id: true },
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;
    let migratedThisPage = 0;
    for (const { id } of rows) {
      if (await migrateMeasurementRow(id)) {
        measurementsMigrated += 1;
        migratedThisPage += 1;
      }
    }
    // Guard against an unexpected non-converging page (every row already
    // migrated by a racing worker) so the loop always terminates.
    if (migratedThisPage === 0) break;
  }

  for (;;) {
    const rows = await prisma.moodEntry.findMany({
      where: { userId, note: { not: null }, noteEncrypted: null },
      select: { id: true },
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;
    let migratedThisPage = 0;
    for (const { id } of rows) {
      if (await migrateMoodRow(id)) {
        moodEntriesMigrated += 1;
        migratedThisPage += 1;
      }
    }
    if (migratedThisPage === 0) break;
  }

  annotate({
    action: {
      name: "note.encryption.backfill",
      details: {
        measurements_migrated: measurementsMigrated,
        mood_entries_migrated: moodEntriesMigrated,
      },
    },
  });

  return { measurementsMigrated, moodEntriesMigrated };
}

/**
 * Boot-time discovery. Finds every user holding at least one row whose note is
 * still in the legacy plaintext column (no ciphertext yet) across either table
 * and enqueues one backfill job per account.
 *
 * Idempotent across reboots: once a user's rows are migrated, the
 * `*Encrypted IS NULL AND * != null` predicate drops them from the discovery
 * set. pg-boss `singletonKey` coalesces duplicate sends. Best-effort: errors
 * come back through the result value so worker boot never fails on a miss.
 */
export async function enqueueBootTimeNoteEncryptionBackfill(
  // Optional boot-storm stagger. When > 0 the per-user sends carry a
  // `startAfter` delay (seconds) so this migration does not drain in parallel
  // with the other boot backfills onto one heavy tenant. Default 0 keeps
  // immediate semantics for any non-boot caller.
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // v1.28.46 perf (H4) — DB-level SELECT DISTINCT, not Prisma `distinct`.
    // Prisma `distinct` fetches EVERY matching row then de-dupes in JS; on the
    // densest table (`measurements`) that is a full un-migrated-partition scan
    // materialised into the worker at boot. `SELECT DISTINCT user_id` de-dupes
    // in Postgres and, with the migration-0243 partial indexes matching each
    // predicate, becomes an index-only scan that shrinks to nothing as the
    // backfill converges.
    const [measurementUsers, moodUsers] = await Promise.all([
      prisma.$queryRaw<{ user_id: string }[]>`
        SELECT DISTINCT user_id FROM measurements
        WHERE notes IS NOT NULL AND notes_encrypted IS NULL`,
      prisma.$queryRaw<{ user_id: string }[]>`
        SELECT DISTINCT user_id FROM mood_entries
        WHERE note IS NOT NULL AND note_encrypted IS NULL`,
    ]);

    const userIds = new Set<string>();
    for (const { user_id } of measurementUsers) userIds.add(user_id);
    for (const { user_id } of moodUsers) userIds.add(user_id);

    if (userIds.size === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const userId of userIds) {
      const payload: NoteEncryptionBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(NOTE_ENCRYPTION_BACKFILL_QUEUE, payload, {
        retryLimit: 5,
        retryDelay: 60,
        retryBackoff: true,
        singletonKey: `note-encryption-backfill|${userId}`,
        ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
      });
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
