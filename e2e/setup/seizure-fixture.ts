/**
 * The seizure-diary spec's account hygiene (#1368).
 *
 * `seizures.spec.ts` counts the seeded e2e user's seizures, so it owns them:
 * every test starts from no seizure and no type, with the opt-in `seizures`
 * module switched on. Rescue doses cascade with their seizure; types go after
 * the seizures that name them. Other modules in the preferences blob are left
 * as they are.
 */
import pg from "pg";

import { E2E_USER } from "./global-setup";

async function withUser<T>(
  run: (pool: pg.Pool, userId: string) => Promise<T>,
): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[seizure-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const res = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [E2E_USER.username],
    );
    const userId = res.rows[0]?.id;
    if (!userId) {
      throw new Error(
        "[seizure-fixture] e2e user not seeded — global-setup must run first",
      );
    }
    return await run(pool, userId);
  } finally {
    await pool.end();
  }
}

/** Remove the seeded user's seizures, types and cluster rule. */
export async function resetSeizures(): Promise<void> {
  await withUser(async (pool, userId) => {
    await pool.query("DELETE FROM seizure_events WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM seizure_type_profiles WHERE user_id = $1", [
      userId,
    ]);
    await pool.query("DELETE FROM seizure_diary_settings WHERE user_id = $1", [
      userId,
    ]);
  });
}

/** Switch the opt-in module on or off for the seeded user. */
export async function setSeizuresModule(on: boolean): Promise<void> {
  await withUser(async (pool, userId) => {
    await pool.query(
      `UPDATE users
          SET module_preferences_json =
              COALESCE(module_preferences_json, '{}'::jsonb)
              || jsonb_build_object('seizures', $2::boolean)
        WHERE id = $1`,
      [userId, on],
    );
  });
}
