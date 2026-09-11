/**
 * v1.38.19 — the instance state the shared-provider offer reads.
 *
 * Two rows decide what the setup flow's last screen may say, and neither has
 * a product endpoint that writes them the way this journey needs:
 *
 *   `app_settings.admin_ai_key_encrypted` — presence alone makes the operator
 *   the origin that would serve a user with no provider of their own
 *   (`managedBy: "server"`). Nothing decrypts it on this path, so the value
 *   below is a placeholder ciphertext and not a credential of any kind.
 *
 *   `provider_health` — the ledger the tri-state folds. It is written only as
 *   a side effect of a real completion, which this suite must never make, so
 *   the journey states the outcome it wants to reason about instead.
 *
 * Both are INSTANCE-wide by nature: the projection deliberately folds across
 * accounts, because a fresh account's own ledger is empty by construction.
 * That is why the spec runs serially and puts both back afterwards.
 *
 * Seeded through `pg`, the same transport `global-setup.ts` and the other
 * fixtures use.
 */
import pg from "pg";

/** Not a key. Presence is the only thing read on this path. */
const PLACEHOLDER_ADMIN_KEY = "e2e-admin-key-presence-only";

function connect(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[ai-offer-fixture] DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString: url });
}

async function userId(pool: pg.Pool, username: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE username = $1`,
    [username],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`[ai-offer-fixture] no account named ${username}`);
  return id;
}

/** The operator has configured a shared provider on this instance. */
export async function seedOperatorProvider(): Promise<void> {
  const pool = connect();
  try {
    await pool.query(
      `INSERT INTO app_settings (id, admin_ai_key_encrypted)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET admin_ai_key_encrypted = EXCLUDED.admin_ai_key_encrypted`,
      [PLACEHOLDER_ADMIN_KEY],
    );
  } finally {
    await pool.end();
  }
}

/** Put the instance back: no operator key, no ledger rows for either tag. */
export async function clearOperatorProvider(): Promise<void> {
  const pool = connect();
  try {
    await pool.query(
      `UPDATE app_settings SET admin_ai_key_encrypted = NULL WHERE id = 'singleton'`,
    );
    await pool.query(
      `DELETE FROM provider_health
        WHERE provider_type IN ('admin-openai', 'admin-codex')`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * State one outcome for the operator's OpenAI provider.
 *
 *   `ok`          — it served somebody `okMinutesAgo` minutes ago.
 *   `auth_failed` — its credential is dead and benched for another hour,
 *                   which is the shape the operator's own instance was in on
 *                   2026-09-11 (a 500 from the OAuth proxy, then a 401).
 */
export async function seedSharedProviderResult(
  username: string,
  outcome: { result: "ok"; okMinutesAgo: number } | { result: "auth_failed" },
): Promise<void> {
  const pool = connect();
  try {
    const id = await userId(pool, username);
    await pool.query(
      `DELETE FROM provider_health
        WHERE provider_type IN ('admin-openai', 'admin-codex')`,
    );
    if (outcome.result === "ok") {
      await pool.query(
        `INSERT INTO provider_health
           (id, user_id, provider_type, last_result, consecutive_failures,
            last_ok_at, updated_at)
         VALUES ($1, $2, 'admin-openai', 'ok', 0,
                 NOW() - ($3 || ' minutes')::interval, NOW())`,
        [`e2e-ph-${id}`, id, String(outcome.okMinutesAgo)],
      );
    } else {
      await pool.query(
        `INSERT INTO provider_health
           (id, user_id, provider_type, last_result, last_status,
            consecutive_failures, last_failure_at, next_retry_at, updated_at)
         VALUES ($1, $2, 'admin-openai', 'auth_failed', 401, 1,
                 NOW(), NOW() + interval '1 hour', NOW())`,
        [`e2e-ph-${id}`, id],
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * The ledger holds nothing for either shared tag, with the operator's key
 * still in place: a brand-new instance before its first AI call, which is
 * what every deployment looks like until somebody makes one.
 */
export async function clearSharedProviderResult(): Promise<void> {
  const pool = connect();
  try {
    await pool.query(
      `DELETE FROM provider_health
        WHERE provider_type IN ('admin-openai', 'admin-codex')`,
    );
  } finally {
    await pool.end();
  }
}

/** No receipt on file — the state a fresh account reaches the screen in. */
export async function clearAiConsent(username: string): Promise<void> {
  const pool = connect();
  try {
    const id = await userId(pool, username);
    await pool.query(`DELETE FROM consent_receipts WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM rate_limits WHERE key = 'consent:' || $1`, [
      id,
    ]);
  } finally {
    await pool.end();
  }
}
