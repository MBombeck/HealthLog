/**
 * Account hygiene for the blood-glucose journey.
 *
 * `glucose-unit-journey.spec.ts` counts rows and reads a display unit off
 * them, and both verdicts are global: "the list holds three glucose readings,
 * all of them in mmol/L" is only true of an account whose glucose history the
 * test itself wrote. A reading left by an earlier run, by a Playwright retry,
 * or by a sibling worker would add a fourth row and a stale unit, and the
 * assertions would read somebody else's data.
 *
 * The display unit needs the same treatment, and for a sharper reason: the
 * journey's whole subject is switching it, so the spec ENDS with the shared
 * account on mmol/L. Left there, the next run's mg/dL half would start from
 * the answer it is trying to reach — a test that can only pass once is worse
 * than no test. `resetGlucose()` puts the column back to NULL (the default
 * mg/dL resolution) before every test.
 *
 * Deletes rather than soft-deletes: the list route filters on `deleted_at IS
 * NULL`, but the dashboard tile and the analytics summaries are the other half
 * of this journey and a soft-deleted row would still have to be reasoned
 * about. These are fixture rows, so they go.
 */
import pg from "pg";

import { E2E_USER } from "./global-setup";

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[glucose-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function getUserId(pool: pg.Pool): Promise<string> {
  const res = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username = $1",
    [E2E_USER.username],
  );
  const id = res.rows[0]?.id;
  if (!id) {
    throw new Error(
      "[glucose-fixture] e2e user not seeded — global-setup must run first",
    );
  }
  return id;
}

/**
 * Clear the seeded account's blood-glucose history and put its display unit
 * back to the default. Safe to call from every test's `beforeEach`.
 */
export async function resetGlucose(): Promise<void> {
  await withPool(async (pool) => {
    const userId = await getUserId(pool);
    await pool.query(
      "DELETE FROM measurements WHERE user_id = $1 AND type = 'BLOOD_GLUCOSE'",
      [userId],
    );
    await pool.query("UPDATE users SET glucose_unit = NULL WHERE id = $1", [
      userId,
    ]);
  });
}
