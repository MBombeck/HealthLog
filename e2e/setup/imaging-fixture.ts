/**
 * The imaging spec's account hygiene: it owns the exams it counts, and puts
 * the `imaging` module back to its default-on state before each test.
 */
import pg from "pg";

import { E2E_USER } from "./global-setup";

async function withUser<T>(fn: (pool: pg.Pool, userId: string) => Promise<T>) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[imaging-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const res = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [E2E_USER.username],
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("[imaging-fixture] e2e user not seeded");
    return await fn(pool, id);
  } finally {
    await pool.end();
  }
}

/** Remove the e2e user's imaging exams; their links cascade. */
export async function resetImaging(): Promise<void> {
  await withUser((pool, userId) =>
    pool.query("DELETE FROM imaging_exams WHERE user_id = $1", [userId]),
  );
}

/** Default-on is absence: clear the `imaging` key from the preferences. */
export async function ensureImagingModuleOn(): Promise<void> {
  await withUser((pool, userId) =>
    pool.query(
      "UPDATE users SET module_preferences_json = module_preferences_json - 'imaging' WHERE id = $1 AND module_preferences_json ? 'imaging'",
      [userId],
    ),
  );
}
