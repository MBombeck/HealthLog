/**
 * Account hygiene for the notification-dispatch journey.
 *
 * Every verdict in that journey is a COUNT over one account's delivery ledger
 * inside a window the test opens itself — one email attempt, no ntfy attempt,
 * one APNs skip carrying a named reason. A channel row, a paired device, a
 * medication or a preference blob left behind by an earlier run would put a
 * second dispatch decision inside that window, and the count would be reading
 * the previous run rather than this one. `--repeat-each` is the case that
 * makes it certain rather than likely.
 *
 * So the account is put back to "nothing configured" before every test:
 * no channels, no devices, no ledger, no medications, default preferences and
 * the default timezone. Deletes rather than disables — a disabled channel row
 * is itself one of the journey's subjects, so leaving one behind would seed
 * the answer to a question the test asks.
 *
 * Reaching for Postgres directly is the channel `global-setup.ts` already
 * uses to seed and to clear buckets, and every statement here is parameter
 * bound on the account's own id.
 */
import pg from "pg";

import { E2E_NOTIFY } from "./global-setup";

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[notification-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** The notification account's id, or a loud failure if the seed never ran. */
export async function notificationAccountId(): Promise<string> {
  return withPool(async (pool) => {
    const res = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [E2E_NOTIFY.username],
    );
    const id = res.rows[0]?.id;
    if (!id) {
      throw new Error(
        "[notification-fixture] e2e-notify is not seeded — global-setup must run first",
      );
    }
    return id;
  });
}

/**
 * Put the notification account back to a freshly-registered state.
 *
 * The rate-limit buckets go too. The card's own test control allows five
 * probes per five minutes and device registration twenty per quarter-hour —
 * production numbers, and both below what three repeats of this journey
 * spend. A run that ended on the fixture's 429 would say nothing about the
 * dispatcher.
 */
export async function resetNotificationFixture(): Promise<void> {
  await withPool(async (pool) => {
    const res = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [E2E_NOTIFY.username],
    );
    const userId = res.rows[0]?.id;
    if (!userId) {
      throw new Error(
        "[notification-fixture] e2e-notify is not seeded — global-setup must run first",
      );
    }

    await pool.query("DELETE FROM notification_channels WHERE user_id = $1", [
      userId,
    ]);
    await pool.query("DELETE FROM devices WHERE user_id = $1", [userId]);
    await pool.query(
      `DELETE FROM push_attempts
        WHERE user_id = $1 OR recipient_user_id = $1 OR record_user_id = $1`,
      [userId],
    );
    await pool.query("DELETE FROM medications WHERE user_id = $1", [userId]);
    await pool.query(
      `UPDATE users
          SET notification_prefs = NULL,
              timezone = DEFAULT
        WHERE id = $1`,
      [userId],
    );
    await pool.query("DELETE FROM rate_limits WHERE key = ANY($1)", [
      [
        `email-test:${userId}`,
        `ntfy-test:${userId}`,
        `devices:register:${userId}`,
        `notification-prefs:patch:${userId}`,
      ],
    ]);
  });
}
