/**
 * v1.39 (C2) — the state the setup-flow journeys start from, and nothing else.
 *
 * Each journey owns one account and walks it from the welcome screen to the
 * dashboard. What a walk leaves behind — the answers row, the completion
 * stamp, the module map, the seeded dashboard, the reading or medication the
 * first-result step produced, a managed profile — is exactly what the next
 * run would then find already done, so every journey resets its own account
 * before it starts. Seeded through `pg`, the same transport `global-setup.ts`
 * and the other fixtures use, because there is no product endpoint that
 * un-completes an account.
 *
 * Idempotent, and scoped to the one account it is given.
 */
import pg from "pg";

function connect(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[setup-flow-fixture] DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString: url });
}

/**
 * Put one account back before its first run: no answers, no completion, no
 * module map, no dashboard seed, no rows the first-result step could have
 * written, and a clean write bucket for the answers route.
 */
export async function resetSetupFlow(username: string): Promise<void> {
  const pool = connect();
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE username = $1`,
      [username],
    );
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(`[setup-flow-fixture] no account named ${username}`);
    }
    await pool.query(`DELETE FROM onboarding_records WHERE user_id = $1`, [id]);
    await pool.query(
      `UPDATE users
         SET onboarding_completed_at = NULL,
             module_preferences_json = NULL,
             dashboard_widgets_json = NULL,
             glucose_unit = NULL,
             unit_preference = NULL
       WHERE id = $1`,
      [id],
    );
    await pool.query(`DELETE FROM measurements WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM medications WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM encounters WHERE user_id = $1`, [id]);
    await pool.query(
      `DELETE FROM rate_limits
        WHERE key IN (
          'onboarding-answers:' || $1,
          'onboarding-restart:' || $1,
          'managed-profile:create:' || $1
        )`,
      [id],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Remove every managed profile this account looks after. A managed profile
 * is a real account row, so a journey that created one and left it behind
 * would find the guardian looking after two records on the next run.
 */
export async function clearManagedProfilesOf(username: string): Promise<void> {
  const pool = connect();
  try {
    await pool.query(
      `DELETE FROM users
       WHERE managed_profile_at IS NOT NULL
         AND id IN (
           SELECT g.grantor_id FROM account_grants g
           JOIN users u ON u.id = g.grantee_id
           WHERE u.username = $1
         )`,
      [username],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Make the account's step-up fresh, exactly as `managed-profile-fixture.ts`
 * does for the guardian: creating a managed profile resolves
 * `requireFreshMfa`, which needs a confirmed factor on the account and a
 * session stamp newer than five minutes. Not a bypass — the route still runs
 * its gate; this is the state in which the surface is usable at all.
 */
export async function stampFreshMfa(username: string): Promise<void> {
  const pool = connect();
  try {
    const stamped = await pool.query(
      `UPDATE sessions SET mfa_verified_at = NOW()
       WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
      [username],
    );
    if ((stamped.rowCount ?? 0) === 0) {
      throw new Error(`[setup-flow-fixture] no session for ${username}`);
    }
    await pool.query(
      `UPDATE users SET totp_confirmed_at = COALESCE(totp_confirmed_at, NOW())
       WHERE username = $1`,
      [username],
    );
  } finally {
    await pool.end();
  }
}
