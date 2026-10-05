/**
 * v1.25 — boot-time converging backfill that migrates the three medication
 * free-text note columns from plaintext to AES-256-GCM at rest:
 * `MedicationSideEffect.notes` -> `notesEncrypted`,
 * `MedicationDoseChange.note` -> `noteEncrypted`, and
 * `MedicationInventoryItem.notes` -> `notesEncrypted`. These are the last
 * plaintext PHI columns left after the v1.23 note-encryption rollout.
 *
 * Modelled on `note-encryption-backfill.ts`: a discovery query enqueues one
 * job per user still holding an un-migrated row, the per-user handler walks
 * that user's rows, and the pass is idempotent across reboots — once a row is
 * migrated it drops off the discovery + candidate sets.
 *
 * OWNERSHIP: `MedicationSideEffect` and `MedicationInventoryItem` carry a
 * direct `userId` column, so they page/discover on `userId` directly.
 * `MedicationDoseChange` has no `userId` — it hangs off a parent `Medication`
 * — so its candidate + discovery queries join through `medication: { userId }`.
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
 *  - IDEMPOTENT: the per-row guard (`*Encrypted IS NULL AND * != null`) is
 *    re-checked inside the tx, so a re-run — or two workers racing — migrates a
 *    row at most once; a second pass migrates zero rows.
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

export const MED_NOTES_ENCRYPTION_BACKFILL_QUEUE =
  "med-notes-encryption-backfill";

/**
 * Serial concurrency — the populator walks a user's plaintext-note rows and
 * writes one transaction per row; concurrency-1 keeps it off the request pool,
 * matching the v1.23 note-encryption-backfill convention.
 */
export const MED_NOTES_ENCRYPTION_BACKFILL_CONCURRENCY = 1;

/** How many candidate rows to pull per page within a user's pass. */
const PAGE_SIZE = 200;

export interface MedNotesEncryptionBackfillPayload {
  /** Absent on the daily discovery tick; present for a per-user job. */
  userId?: string;
  enqueuedAt?: string;
}

export interface MedNotesEncryptionBackfillSummary {
  sideEffectsMigrated: number;
  doseChangesMigrated: number;
  inventoryItemsMigrated: number;
}

/**
 * Migrate one side-effect row's plaintext `notes` into `notesEncrypted` and
 * null the plaintext — atomically and idempotently. Returns true if it
 * migrated the row, false if a concurrent pass already did.
 */
async function migrateSideEffectRow(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.medicationSideEffect.findUnique({
      where: { id },
      select: { notes: true, notesEncrypted: true },
    });
    // Already migrated (ciphertext present) or nothing to migrate.
    if (!fresh || fresh.notesEncrypted || fresh.notes === null) return false;
    // FAIL-CLOSED: a key error throws here and rolls the tx back, leaving the
    // plaintext row untouched.
    const encrypted = encryptNote(fresh.notes);
    await tx.medicationSideEffect.update({
      where: { id },
      data: { notesEncrypted: encrypted, notes: null },
    });
    return true;
  });
}

/**
 * Migrate one dose-change row's plaintext `note` into `noteEncrypted` and null
 * the plaintext — atomically and idempotently.
 */
async function migrateDoseChangeRow(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.medicationDoseChange.findUnique({
      where: { id },
      select: { note: true, noteEncrypted: true },
    });
    if (!fresh || fresh.noteEncrypted || fresh.note === null) return false;
    const encrypted = encryptNote(fresh.note);
    await tx.medicationDoseChange.update({
      where: { id },
      data: { noteEncrypted: encrypted, note: null },
    });
    return true;
  });
}

/**
 * Migrate one inventory-item row's plaintext `notes` into `notesEncrypted` and
 * null the plaintext — atomically and idempotently.
 */
async function migrateInventoryItemRow(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.medicationInventoryItem.findUnique({
      where: { id },
      select: { notes: true, notesEncrypted: true, updatedAt: true },
    });
    if (!fresh || fresh.notesEncrypted || fresh.notes === null) return false;
    const encrypted = encryptNote(fresh.notes);
    // Storage-only rewrite: the row keeps its own `updatedAt`.
    const { count } = await tx.medicationInventoryItem.updateMany({
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
 * Per-user queue handler. Walks every un-migrated medication note for one
 * account across all three tables and migrates each in its own transaction.
 * Safe to re-run. Dose-changes carry no `userId`, so they are scoped through
 * the parent medication's owner.
 */
export async function runMedNotesEncryptionBackfillForUser(
  userId: string,
): Promise<MedNotesEncryptionBackfillSummary> {
  let sideEffectsMigrated = 0;
  let doseChangesMigrated = 0;
  let inventoryItemsMigrated = 0;

  // Side-effects — direct userId. Each migration nulls `notes`, so a migrated
  // row drops out of the next `notes: { not: null }, notesEncrypted: null` page.
  for (;;) {
    const rows = await prisma.medicationSideEffect.findMany({
      where: { userId, notes: { not: null }, notesEncrypted: null },
      select: { id: true },
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;
    let migratedThisPage = 0;
    for (const { id } of rows) {
      if (await migrateSideEffectRow(id)) {
        sideEffectsMigrated += 1;
        migratedThisPage += 1;
      }
    }
    // Guard against an unexpected non-converging page (every row already
    // migrated by a racing worker) so the loop always terminates.
    if (migratedThisPage === 0) break;
  }

  // Dose-changes — no userId column; scope through the parent medication owner.
  for (;;) {
    const rows = await prisma.medicationDoseChange.findMany({
      where: {
        medication: { userId },
        note: { not: null },
        noteEncrypted: null,
      },
      select: { id: true },
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;
    let migratedThisPage = 0;
    for (const { id } of rows) {
      if (await migrateDoseChangeRow(id)) {
        doseChangesMigrated += 1;
        migratedThisPage += 1;
      }
    }
    if (migratedThisPage === 0) break;
  }

  // Inventory items — direct userId.
  for (;;) {
    const rows = await prisma.medicationInventoryItem.findMany({
      where: { userId, notes: { not: null }, notesEncrypted: null },
      select: { id: true },
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;
    let migratedThisPage = 0;
    for (const { id } of rows) {
      if (await migrateInventoryItemRow(id)) {
        inventoryItemsMigrated += 1;
        migratedThisPage += 1;
      }
    }
    if (migratedThisPage === 0) break;
  }

  annotate({
    action: {
      name: "med.notes.encryption.backfill",
      details: {
        side_effects_migrated: sideEffectsMigrated,
        dose_changes_migrated: doseChangesMigrated,
        inventory_items_migrated: inventoryItemsMigrated,
      },
    },
  });

  return { sideEffectsMigrated, doseChangesMigrated, inventoryItemsMigrated };
}

/**
 * Boot-time discovery. Finds every user holding at least one medication note
 * still in the legacy plaintext column (no ciphertext yet) across any of the
 * three tables and enqueues one backfill job per account.
 *
 * Idempotent across reboots: once a user's rows are migrated, the
 * `*Encrypted IS NULL AND * != null` predicate drops them from the discovery
 * set. pg-boss `singletonKey` coalesces duplicate sends. Best-effort: errors
 * come back through the result value so worker boot never fails on a miss.
 */
export async function enqueueBootTimeMedNotesEncryptionBackfill(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // v1.28.46 perf (H4) — DB-level SELECT DISTINCT, not Prisma `distinct`
    // (which fetches every matching row then de-dupes in JS at boot). Dose-
    // changes carry no userId, so their owner comes through a join on the
    // parent medication. The migration-0243 partial indexes match each
    // predicate so the scans stay index-only and converge to empty.
    const [sideEffectUsers, doseChangeUsers, inventoryUsers] =
      await Promise.all([
        prisma.$queryRaw<{ user_id: string }[]>`
          SELECT DISTINCT user_id FROM medication_side_effects
          WHERE notes IS NOT NULL AND notes_encrypted IS NULL`,
        prisma.$queryRaw<{ user_id: string }[]>`
          SELECT DISTINCT m.user_id AS user_id
          FROM medication_dose_changes dc
          JOIN medications m ON m.id = dc.medication_id
          WHERE dc.note IS NOT NULL AND dc.note_encrypted IS NULL`,
        prisma.$queryRaw<{ user_id: string }[]>`
          SELECT DISTINCT user_id FROM medication_inventory_items
          WHERE notes IS NOT NULL AND notes_encrypted IS NULL`,
      ]);

    const userIds = new Set<string>();
    for (const { user_id } of sideEffectUsers) userIds.add(user_id);
    for (const { user_id } of doseChangeUsers) userIds.add(user_id);
    for (const { user_id } of inventoryUsers) userIds.add(user_id);

    if (userIds.size === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const userId of userIds) {
      const payload: MedNotesEncryptionBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        MED_NOTES_ENCRYPTION_BACKFILL_QUEUE,
        payload,
        {
          retryLimit: 5,
          retryDelay: 60,
          retryBackoff: true,
          singletonKey: `med-notes-encryption-backfill|${userId}`,
        },
      );
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
