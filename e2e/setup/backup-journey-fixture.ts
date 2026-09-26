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
 * Copy one stored snapshot and flip a single byte of its ciphertext.
 *
 * Since v1.39.2 a stored copy is a row in `data_backups` that names its
 * pieces (`chunk_count`, `chunk_stream_id`) and ordered, separately sealed
 * pieces in `data_backup_chunks`. Each piece is `iv | ciphertext | tag`
 * under AES-256-GCM (see `src/lib/export/backup-chunks.ts`), so a byte four
 * fifths of the way into the middle piece sits inside ciphertext its tag
 * covers: what the restore meets is a well-formed copy whose one piece no
 * longer authenticates, not a missing or reordered piece.
 *
 * A COPY rather than the row itself: the journey still needs the good
 * snapshot afterwards, and a control that destroys its own subject can only
 * be run once. The copy keeps the original stream id, which the pieces'
 * sealed headers are bound to, so the only fault in it is the flipped byte.
 */
export async function storeTamperedCopy(backupId: string): Promise<string> {
  return withPool(async (pool) => {
    const { rows } = await pool.query<{
      user_id: string;
      chunk_count: number | null;
      chunk_stream_id: string | null;
    }>(
      `SELECT user_id, chunk_count, chunk_stream_id FROM data_backups WHERE id = $1`,
      [backupId],
    );
    if (rows.length !== 1) {
      throw new Error(`no stored backup ${backupId} to copy`);
    }
    const { user_id, chunk_count, chunk_stream_id } = rows[0];
    if (!chunk_count || !chunk_stream_id) {
      throw new Error(`stored backup ${backupId} is not kept in pieces`);
    }
    const { rows: pieces } = await pool.query<{ seq: number; data: Buffer }>(
      `SELECT seq, data FROM data_backup_chunks WHERE backup_id = $1 ORDER BY seq`,
      [backupId],
    );
    if (pieces.length !== chunk_count) {
      throw new Error(
        `stored backup ${backupId} names ${chunk_count} pieces but has ${pieces.length}`,
      );
    }

    const target = pieces[Math.floor(pieces.length / 2)];
    const at = Math.floor(target.data.length * 0.8);
    const tampered = Buffer.from(target.data);
    tampered[at] ^= 0x01;
    if (tampered.equals(target.data)) {
      throw new Error("the tamper changed nothing");
    }

    const copyId = `c${Date.now().toString(36)}tampered${Math.floor(Math.random() * 1e6)}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO data_backups (id, user_id, type, data, chunk_count, chunk_stream_id, created_at)
         VALUES ($1, $2, $3, NULL, $4, $5, now())`,
        [
          copyId,
          user_id,
          `MANUAL_UPLOAD_${Date.now()}`,
          chunk_count,
          chunk_stream_id,
        ],
      );
      for (const piece of pieces) {
        await client.query(
          `INSERT INTO data_backup_chunks (id, backup_id, seq, data)
           VALUES ($1, $2, $3, $4)`,
          [
            `${copyId}p${piece.seq}`,
            copyId,
            piece.seq,
            piece.seq === target.seq ? tampered : piece.data,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return copyId;
  });
}

/**
 * Drop one stored copy again.
 *
 * The tampered copy the refusal control writes is the journey's own litter: it
 * is not deleted until the next repetition's `beforeAll`, and until then it
 * sits in the console's list for anyone who opens `/admin/backups`.
 */
export async function deleteStoredCopy(backupId: string): Promise<void> {
  await withPool(async (pool) => {
    await pool.query(`DELETE FROM data_backups WHERE id = $1`, [backupId]);
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
      // `id` after the timestamp: the journey compares two whole arrays to
      // prove a refusal changed nothing, and two readings sharing a timestamp
      // could otherwise come back in either order and present as a change.
      `SELECT id, type, value, deleted_at
       FROM measurements WHERE user_id = $1
       ORDER BY measured_at ASC, id ASC`,
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
       WHERE user_id = $1 ORDER BY scheduled_for ASC, id ASC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    }));
  });
}
