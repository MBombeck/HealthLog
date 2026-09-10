/**
 * Database-side fixture for the backup/restore journey.
 *
 * Everything the journey WRITES it writes through the browser: the readings,
 * the medication and its dose, the mood entry, the document, the snapshot, the
 * deletions and the restore all ride the app's own routes. What lives here is
 * only what a browser has no way to express — clearing the account back to a
 * known state so the file survives `--repeat-each`, and corrupting one stored
 * copy so the restore path has an authenticated envelope to refuse.
 *
 * Raw SQL through `pg` for the same reason `global-setup.ts` uses it:
 * Playwright's TS loader does not handle the generated Prisma client's
 * `import.meta.url` indirection.
 */
import pg from "pg";

import { E2E_BACKUP_ADMIN, E2E_BACKUP_DELEGATE } from "./global-setup";

/** One row of the account's readings, as the journey needs to compare it. */
export interface StoredMeasurement {
  id: string;
  type: string;
  value: number;
  deletedAt: string | null;
}

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is unset — the backup journey needs the same database the app is running against.",
    );
  }
  const pool = new pg.Pool({ connectionString });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** The journey account's id, resolved by username rather than assumed. */
export async function backupAccountId(): Promise<string> {
  return withPool(async (pool) => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE username = $1`,
      [E2E_BACKUP_ADMIN.username],
    );
    if (rows.length !== 1) {
      throw new Error(
        `expected exactly one ${E2E_BACKUP_ADMIN.username} row, found ${rows.length}`,
      );
    }
    return rows[0].id;
  });
}

/**
 * Put the account back where the journey expects to find it.
 *
 * Deletes only what this file's account holds, and only the classes the
 * journey writes. The stored snapshots go too: a row left behind from the
 * previous repetition is indistinguishable from the one this repetition is
 * about to take, and the whole journey turns on picking the right one.
 *
 * The rate buckets are cleared for the same reason `global-setup.ts` clears
 * the login bucket: the manual-run and upload endpoints allow three calls a
 * minute each and the export bucket ten an hour, which are the right
 * production numbers and fewer than three repetitions of this file need.
 */
export async function resetBackupJourney(): Promise<void> {
  await withPool(async (pool) => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE username = ANY($1)`,
      [[E2E_BACKUP_ADMIN.username, E2E_BACKUP_DELEGATE.username]],
    );
    const ids = rows.map((row) => row.id);

    // Intake events before medications: the child rows carry the foreign key.
    await pool.query(
      `DELETE FROM medication_intake_events WHERE user_id = ANY($1)`,
      [ids],
    );
    await pool.query(`DELETE FROM medications WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM measurements WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM mood_entries WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM inbound_documents WHERE user_id = ANY($1)`, [
      ids,
    ]);
    await pool.query(`DELETE FROM data_backups WHERE user_id = ANY($1)`, [ids]);

    // The delegate is switched back out of the record; the refusal control
    // switches in and a stamp that outlived a repetition would start the next
    // one already inside.
    await pool.query(
      `UPDATE sessions SET acting_as_user_id = NULL WHERE user_id = ANY($1)`,
      [ids],
    );

    for (const id of ids) {
      await pool.query(
        `DELETE FROM rate_limits
         WHERE key IN ($1, $2, $3)`,
        [
          `admin-backups-run:${id}`,
          `admin-backups-upload:${id}`,
          `export:${id}`,
        ],
      );
    }
  });
}

/**
 * Copy one stored snapshot and flip a single character of its ciphertext.
 *
 * `DataBackup.data` is `~hlgcm1.<keyId>.<base64(iv | ciphertext | authTag)>`
 * (see `src/lib/crypto.ts`), so the flip lands four fifths of the way in —
 * well past the header, inside the ciphertext the tag covers. The replacement
 * stays inside the base64 alphabet, so what the restore meets is a
 * well-formed envelope whose authentication tag no longer matches, and not a
 * decoder error standing in for one.
 *
 * A COPY rather than the row itself: the journey still needs the good
 * snapshot afterwards, and a control that destroys its own subject can only
 * be run once.
 */
export async function storeTamperedCopy(backupId: string): Promise<string> {
  return withPool(async (pool) => {
    const { rows } = await pool.query<{
      user_id: string;
      data: string;
    }>(`SELECT user_id, data FROM data_backups WHERE id = $1`, [backupId]);
    if (rows.length !== 1) {
      throw new Error(`no stored backup ${backupId} to copy`);
    }
    const stored = rows[0].data;
    const at = Math.floor(stored.length * 0.8);
    const original = stored[at];
    if (!/[A-Za-z0-9+/]/.test(original)) {
      throw new Error(
        `the byte at ${at} of the stored blob is '${original}', not ciphertext base64`,
      );
    }
    const flipped = original === "A" ? "B" : "A";
    const tampered = stored.slice(0, at) + flipped + stored.slice(at + 1);
    if (tampered === stored) {
      throw new Error("the tamper changed nothing");
    }

    const { rows: created } = await pool.query<{ id: string }>(
      `INSERT INTO data_backups (id, user_id, type, data, created_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id`,
      [
        `c${Date.now().toString(36)}tampered${Math.floor(Math.random() * 1e6)}`,
        rows[0].user_id,
        `MANUAL_UPLOAD_${Date.now()}`,
        tampered,
      ],
    );
    return created[0].id;
  });
}

/** Every reading the account holds, tombstoned ones included. */
export async function storedMeasurements(): Promise<StoredMeasurement[]> {
  const userId = await backupAccountId();
  return withPool(async (pool) => {
    const { rows } = await pool.query<{
      id: string;
      type: string;
      value: string;
      deleted_at: Date | null;
    }>(
      `SELECT id, type, value, deleted_at
       FROM measurements WHERE user_id = $1 ORDER BY measured_at ASC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      value: Number(row.value),
      deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    }));
  });
}

/** Every dose the account holds, tombstoned ones included. */
export async function storedIntakeIds(): Promise<
  Array<{ id: string; deletedAt: string | null }>
> {
  const userId = await backupAccountId();
  return withPool(async (pool) => {
    const { rows } = await pool.query<{ id: string; deleted_at: Date | null }>(
      `SELECT id, deleted_at FROM medication_intake_events
       WHERE user_id = $1 ORDER BY scheduled_for ASC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    }));
  });
}
