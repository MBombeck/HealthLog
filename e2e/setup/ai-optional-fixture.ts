/**
 * Fixture for the AI-optional journeys that need server state
 * (`e2e/ai-optional-consent.spec.ts`, `e2e/ai-optional-coach-memory.spec.ts`).
 *
 * Both run on their own account (`E2E_AI_OPTIONAL`). What they need has no
 * product endpoint that can write it without a working model:
 *
 *   - a provider the account can "have" without any egress: a local model on
 *     an address nothing listens on. Presence is what the capability reads;
 *     nothing on these journeys calls it.
 *   - a briefing a model wrote earlier, stored as the cache the read path
 *     serves. The journey proves it is deleted when the consent goes.
 *   - an AI consent receipt to withdraw.
 *   - a Coach conversation, which only a chat with a model would create.
 *
 * Every read and every change the journeys ASSERT goes through the app; this
 * file only prepares the starting state, through `pg` like the other fixtures.
 */
import pg from "pg";

import { E2E_AI_OPTIONAL } from "./global-setup";

function connect(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[ai-optional-fixture] DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url });
}

async function withAccount<T>(
  run: (pool: pg.Pool, userId: string) => Promise<T>,
): Promise<T> {
  const pool = connect();
  try {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [E2E_AI_OPTIONAL.username],
    );
    const userId = rows[0]?.id;
    if (!userId) {
      throw new Error(
        "[ai-optional-fixture] account not seeded — global-setup must run first",
      );
    }
    return await run(pool, userId);
  } finally {
    await pool.end();
  }
}

/** Back to a plain account: no provider, no stored AI text, no consent. */
export async function resetAiOptionalAccount(): Promise<void> {
  await withAccount(async (pool, userId) => {
    await pool.query(
      `UPDATE users SET
         ai_provider = NULL,
         ai_base_url = NULL,
         insights_cached_text = NULL,
         insights_cached_at = NULL,
         insights_cached_locale = NULL,
         disable_coach = false
       WHERE id = $1`,
      [userId],
    );
    await pool.query("DELETE FROM consent_receipts WHERE user_id = $1", [
      userId,
    ]);
    await pool.query("DELETE FROM coach_conversations WHERE user_id = $1", [
      userId,
    ]);
  });
}

/**
 * A local provider, a stored daily briefing whose paragraph is `marker`, and
 * an active AI consent.
 */
export async function seedStoredBriefing(marker: string): Promise<void> {
  const insights = {
    dailyBriefing: { paragraph: marker, keyFindings: [] },
    // Generated now: only text written today is served as today's read.
    briefingGeneratedAt: new Date().toISOString(),
  };
  await withAccount(async (pool, userId) => {
    await pool.query(
      `UPDATE users SET
         ai_provider = 'LOCAL',
         ai_base_url = 'http://127.0.0.1:9/v1',
         insights_cached_text = $2,
         insights_cached_at = now(),
         insights_cached_locale = 'en'
       WHERE id = $1`,
      [userId, JSON.stringify(insights)],
    );
    await pool.query(
      `INSERT INTO consent_receipts (id, user_id, kind, artefact, signed_at)
       VALUES ($1, $2, 'ai_full', $3, now())`,
      [
        `e2e-consent-${Date.now()}`,
        userId,
        JSON.stringify({ source: "e2e", kind: "ai_full" }),
      ],
    );
  });
}

/** Hide the Coach and give it one stored conversation titled `title`. */
export async function seedHiddenCoachWithConversation(
  title: string,
): Promise<void> {
  await withAccount(async (pool, userId) => {
    await pool.query("UPDATE users SET disable_coach = true WHERE id = $1", [
      userId,
    ]);
    await pool.query(
      `INSERT INTO coach_conversations (id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())`,
      [`e2e-conv-${Date.now()}`, userId, title],
    );
  });
}

/** How many Coach conversations the account still stores. */
export async function coachConversationCount(): Promise<number> {
  return withAccount(async (pool, userId) => {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM coach_conversations WHERE user_id = $1",
      [userId],
    );
    return Number(rows[0]?.n ?? 0);
  });
}
