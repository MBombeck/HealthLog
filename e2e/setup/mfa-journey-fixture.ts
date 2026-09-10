/**
 * The second-factor journey's account, and nothing else.
 *
 * ## Why a throwaway account
 *
 * Enrolling TOTP changes how an account logs in for every spec that shares it:
 * `/api/auth/login` stops minting a session and answers with a challenge
 * instead. `global-setup.ts` already learned that once — it has to log the
 * guardian in BEFORE stamping its factor, because the password-only capture
 * cannot complete a TOTP login. So this journey, which enrols a factor from a
 * clean slate and then signs in through it four times, owns an account nobody
 * else touches and re-seeds it from scratch on every run.
 *
 * The username carries the Playwright PROJECT name. Both browser projects run
 * this file, `fullyParallel` is on, and the journey moves one account's factor
 * state, its `totpLastStep` replay floor, and its recovery codes. Two projects
 * driving one account would be testing which browser got there first. A second
 * account costs one INSERT and removes the question.
 *
 * ## Why Postgres rather than the product
 *
 * Two of the things this journey needs have no endpoint, by design:
 *
 *   - an EXPIRED step-up. `requireFreshMfa` reads `Session.mfaVerifiedAt` and
 *     compares it against a five-minute window. Nothing clears that stamp on
 *     request, and waiting five minutes inside a 30-second test is not a test.
 *     Ageing the stamp is not a bypass and does not weaken the route: the route
 *     still runs its gate, and what the fixture simulates is time passing.
 *   - the anonymous auth buckets. `/api/auth/login` allows five attempts per IP
 *     per fifteen minutes and `/api/auth/mfa/verify` ten; this journey spends
 *     four and five of them, and every other spec on the machine shares the
 *     same localhost bucket. `global-setup.ts` clears the same keys between its
 *     own logins for the same reason.
 *
 * Seeded through `pg`, the transport `global-setup.ts`, `vault-fixture.ts` and
 * `managed-profile-fixture.ts` all use.
 */
import { hash } from "@node-rs/argon2";
import pg from "pg";

export interface MfaJourneyAccount {
  username: string;
  email: string;
  password: string;
}

/** One account per Playwright project — see the file header. */
export function mfaJourneyAccount(projectName: string): MfaJourneyAccount {
  const slug = projectName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return {
    username: `e2e-mfa-${slug}`,
    email: `e2e-mfa-${slug}@healthlog.test`,
    // 16 chars, same shape as the fixture passwords in `global-setup.ts`.
    password: "Hw6!Tq2pB9nZ4vLd",
  };
}

function connect(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[mfa-journey-fixture] DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString: url });
}

/** Prisma's `cuid()` shape, close enough for a hand-written row. */
function cuid(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "c";
  for (let i = 0; i < 24; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Argon2id at the app's own parameters (`src/lib/auth/argon2-params.mjs`). */
async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
}

/**
 * Drop whatever a previous run left and insert the account fresh.
 *
 * DELETE rather than upsert: the journey's whole subject is the transition from
 * no second factor to one, and an account carrying a confirmed secret, a
 * `totpLastStep` replay floor, or a half-spent recovery batch from an earlier
 * run would start it in the middle. The row cascades to its sessions, its
 * recovery codes and its MFA challenges, so one statement clears all of it.
 *
 * `onboarding_completed_at` and `onboarding_tour_completed` are stamped for the
 * reason `global-setup.ts` documents: without them the proxy bounces the new
 * session to `/onboarding` and the tour overlay swallows every click.
 */
export async function seedMfaAccount(
  account: MfaJourneyAccount,
): Promise<void> {
  const pool = connect();
  try {
    await pool.query("DELETE FROM users WHERE username = $1", [
      account.username,
    ]);
    await pool.query(
      `INSERT INTO users
        (id, username, email, password_hash, role,
         created_at, updated_at,
         onboarding_completed_at, onboarding_tour_completed)
       VALUES ($1, $2, $3, $4, 'USER', $5, $5, $5, true)`,
      [
        cuid(),
        account.username,
        account.email,
        await hashPassword(account.password),
        new Date(),
      ],
    );
  } finally {
    await pool.end();
  }
}

/** Remove the account and everything that cascades off it. */
export async function dropMfaAccount(
  account: MfaJourneyAccount,
): Promise<void> {
  const pool = connect();
  try {
    await pool.query("DELETE FROM users WHERE username = $1", [
      account.username,
    ]);
  } finally {
    await pool.end();
  }
}

/**
 * Empty the anonymous auth buckets.
 *
 * Both keys are per-IP and every spec on the machine is the same IP, so this is
 * the same unconditional clear `global-setup.ts` runs between its own logins.
 * Call it before each sign-in this journey performs; the product's 429 is a
 * real answer, but it is not the answer any of these tests is about.
 */
export async function clearAuthRateLimits(): Promise<void> {
  const pool = connect();
  try {
    await pool.query(`DELETE FROM rate_limits WHERE key LIKE 'auth:%'`);
  } finally {
    await pool.end();
  }
}

/**
 * The attempt counter on the account's most recent login challenge.
 *
 * `/api/auth/mfa/verify` answers a wrong factor with the same generic 401 it
 * gives an unknown ticket, so the throttle it applies is invisible from the
 * wire. The counter is the only place the refusal is recorded, and a refusal
 * the server does not count is a refusal an attacker can repeat for free — so
 * the journey reads it rather than taking the 401 as proof on its own.
 */
export async function latestChallengeAttempts(
  account: MfaJourneyAccount,
): Promise<number> {
  const pool = connect();
  try {
    const res = await pool.query<{ attempts: number }>(
      `SELECT attempts FROM mfa_challenges
        WHERE user_id = (SELECT id FROM users WHERE username = $1)
        ORDER BY created_at DESC
        LIMIT 1`,
      [account.username],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error(
        `[mfa-journey-fixture] no login challenge for ${account.username}`,
      );
    }
    return row.attempts;
  } finally {
    await pool.end();
  }
}

/**
 * The server's own verdict on the account's most recent refused factor.
 *
 * `/api/auth/mfa/verify` answers every refusal with the same 401, so the wire
 * cannot tell a replayed code from a wrong one — and that distinction is the
 * whole subject of the replay control. The route does record it: it writes
 * `auth.mfa.failed` with `details.replay` and AWAITS that write before
 * responding, so the row is on disk by the time the response lands.
 *
 * Read it rather than inferring it. A replayed code that has drifted out of its
 * ±1-step window is refused as out-of-window — same 401, `replay: false` — and
 * a control that only reads the status code cannot tell the two apart, which
 * means it would stay green with the replay floor deleted.
 */
export async function latestMfaFailure(
  account: MfaJourneyAccount,
): Promise<{ replay: boolean }> {
  const pool = connect();
  try {
    const res = await pool.query<{ details: string | null }>(
      `SELECT details FROM audit_logs
        WHERE user_id = (SELECT id FROM users WHERE username = $1)
          AND action = 'auth.mfa.failed'
        ORDER BY created_at DESC
        LIMIT 1`,
      [account.username],
    );
    const row = res.rows[0];
    if (!row?.details) {
      throw new Error(
        `[mfa-journey-fixture] no refused factor recorded for ${account.username}`,
      );
    }
    const details = JSON.parse(row.details) as { replay?: unknown };
    if (typeof details.replay !== "boolean") {
      throw new Error(
        `[mfa-journey-fixture] refusal for ${account.username} carries no replay verdict`,
      );
    }
    return { replay: details.replay };
  } finally {
    await pool.end();
  }
}

/**
 * Age the session's step-up stamp past the five-minute window.
 *
 * A zero-row update means the jar the journey is driving points at no session
 * at all, and the refusal that follows would have nothing to do with freshness.
 * Fail loudly here instead, the way `managed-profile-fixture.ts` does.
 */
export async function expireStepUp(account: MfaJourneyAccount): Promise<void> {
  const pool = connect();
  try {
    const aged = await pool.query(
      `UPDATE sessions SET mfa_verified_at = NOW() - INTERVAL '10 minutes'
       WHERE user_id = (SELECT id FROM users WHERE username = $1)
         AND mfa_verified_at IS NOT NULL`,
      [account.username],
    );
    if ((aged.rowCount ?? 0) === 0) {
      throw new Error(
        `[mfa-journey-fixture] no step-up-stamped session for ${account.username}`,
      );
    }
  } finally {
    await pool.end();
  }
}
