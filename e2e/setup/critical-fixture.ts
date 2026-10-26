/**
 * Accounts for the `@critical` journeys: one per journey AND per project.
 *
 * The `@critical` journeys run against the real server with no `/api` stubs
 * (`src/__tests__/e2e-critical-no-api-stub-guard.test.ts` holds that line), so
 * every verdict they read is a statement about a real record. Two things would
 * make those verdicts somebody else's:
 *
 *   - a sibling spec writing into the same account. The shared fixture account
 *     is read and written by sixty files, so "the dashboard tile shows the
 *     weight I just entered" is only true of an account nobody else writes;
 *   - the same journey running in the other project. Every other journey that
 *     owns its account answers that by running in ONE project (the long list in
 *     `playwright.config.ts`). These journeys are the release gate and are
 *     meant to hold at both widths, so instead of dropping a project each
 *     project gets its own account: `chromium-desktop` and `chromium-mobile`
 *     run the same file in parallel and never meet.
 *
 * The accounts are seeded and signed in by `global-setup.ts`, like every
 * other fixture account; this module only names them and resets what the
 * journeys write. It talks to Postgres through `pg` for the reason
 * `global-setup.ts` gives (Playwright's loader cannot load the generated
 * Prisma client).
 */
import { resolve } from "node:path";

import type { TestInfo } from "@playwright/test";
import pg from "pg";

/** The journeys that own an account pair. */
export const CRITICAL_JOURNEYS = [
  "auth",
  "measurement",
  "mood",
  "labs",
  "wellbeing",
  "settings",
  // The fresh account a full backup is imported into. The backup journey
  // runs in the desktop project only (`playwright.config.ts` says why), so
  // only the desktop account of this pair is ever written.
  "restore",
] as const;

export type CriticalJourney = (typeof CRITICAL_JOURNEYS)[number];

/**
 * Journeys that sign in through the form in every test and so get no jar.
 * The sign-in journey ends the sessions it opens; a jar captured once in
 * global setup would be dead for a retry, and a retry has to start from the
 * same place as the first attempt.
 */
export const FORM_SIGN_IN_JOURNEYS: ReadonlySet<CriticalJourney> = new Set([
  "auth",
]);

/** The projects the journeys run in; each gets its own account per journey. */
export const CRITICAL_PROJECTS = {
  "chromium-desktop": "d",
  "chromium-mobile": "m",
} as const;

type CriticalProject = keyof typeof CRITICAL_PROJECTS;

export interface CriticalAccount {
  username: string;
  email: string;
  password: string;
  storageStatePath: string;
}

function accountFor(
  journey: CriticalJourney,
  suffix: (typeof CRITICAL_PROJECTS)[CriticalProject],
): CriticalAccount {
  const username = `e2e-critical-${journey}-${suffix}`;
  return {
    username,
    email: `${username}@healthlog.test`,
    // Fixture credential for a throwaway test database, like every other
    // account in `global-setup.ts`. Long and mixed so it would also clear the
    // registration strength gate.
    password: `Cq7!${journey}-${suffix}-Wz4pLx`,
    storageStatePath: resolve(
      process.cwd(),
      `e2e/setup/storageStateCritical-${journey}-${suffix}.json`,
    ),
  };
}

/** Every critical account, for `global-setup.ts` to seed and sign in. */
export function allCriticalAccounts(): Array<
  CriticalAccount & { journey: CriticalJourney }
> {
  return CRITICAL_JOURNEYS.flatMap((journey) =>
    Object.values(CRITICAL_PROJECTS).map((suffix) => ({
      journey,
      ...accountFor(journey, suffix),
    })),
  );
}

/**
 * The account a journey uses in the project the test is running in. A project
 * outside the map has no account on purpose: a critical journey that grows a
 * third project has to say which account it reads.
 */
export function criticalAccount(
  journey: CriticalJourney,
  testInfo: TestInfo,
): CriticalAccount {
  const suffix = CRITICAL_PROJECTS[testInfo.project.name as CriticalProject];
  if (!suffix) {
    throw new Error(
      `[critical-fixture] no ${journey} account for project ${testInfo.project.name}`,
    );
  }
  return accountFor(journey, suffix);
}

/**
 * A `test.use({ storageState })` value that picks the jar of the running
 * project's account.
 */
export function criticalStorageState(journey: CriticalJourney) {
  return async (
    {}: object,
    use: (path: string) => Promise<void>,
    testInfo: TestInfo,
  ): Promise<void> => {
    await use(criticalAccount(journey, testInfo).storageStatePath);
  };
}

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[critical-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Run statements against one critical account, with `$1` bound to its id.
 * Fixture hygiene only: what a previous run or a retry left behind. Nothing a
 * journey asserts is written here.
 */
export async function resetCriticalAccount(
  account: CriticalAccount,
  statements: readonly string[],
): Promise<void> {
  await withPool(async (pool) => {
    const res = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [account.username],
    );
    const id = res.rows[0]?.id;
    if (!id) {
      throw new Error(
        `[critical-fixture] ${account.username} not seeded — global-setup must run first`,
      );
    }
    for (const sql of statements) await pool.query(sql, [id]);
  });
}

/**
 * Clear the login buckets. The ceiling is five attempts per IP per quarter
 * hour, the suite shares one IP, and global setup alone signs in more than
 * twenty times; a journey that signs in through the form would otherwise meet
 * the fixture's 429 rather than the product. Only the auth surfaces' buckets
 * are touched, exactly as global setup does between its own logins.
 */
export async function clearLoginBuckets(): Promise<void> {
  await withPool(async (pool) => {
    await pool.query(`DELETE FROM rate_limits WHERE key LIKE 'auth:%'`);
  });
}

/**
 * Delete a critical account and create it again, empty, under the same id,
 * username and password. The backup journey restores a person's file into
 * the account the way the runbook brings one back on a new host, where the
 * file names its owner by id; a browser cannot delete and recreate a row
 * under a chosen id, so this is the fixture's act, not the journey's.
 */
export async function recreateCriticalAccount(
  account: CriticalAccount,
): Promise<void> {
  await withPool(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{
        id: string;
        password_hash: string;
        module_preferences_json: unknown;
      }>(
        `SELECT id, password_hash, module_preferences_json
         FROM users WHERE username = $1`,
        [account.username],
      );
      const row = res.rows[0];
      if (!row) {
        throw new Error(`[critical-fixture] ${account.username} not seeded`);
      }
      await client.query("DELETE FROM users WHERE id = $1", [row.id]);
      await client.query(
        `INSERT INTO users
          (id, username, email, password_hash, role, created_at, updated_at,
           onboarding_completed_at, onboarding_tour_completed,
           module_preferences_json)
         VALUES ($1, $2, $3, $4, 'USER', NOW(), NOW(), NOW(), true, $5::jsonb)`,
        [
          row.id,
          account.username,
          account.email,
          row.password_hash,
          JSON.stringify(row.module_preferences_json),
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/** How many measurements and mood entries a critical account holds. */
export async function accountRowCounts(
  account: CriticalAccount,
): Promise<{ measurements: number; moodEntries: number }> {
  return withPool(async (pool) => {
    const res = await pool.query<{ measurements: string; mood: string }>(
      `SELECT
         (SELECT count(*) FROM measurements m
            JOIN users u ON u.id = m.user_id WHERE u.username = $1)
           AS measurements,
         (SELECT count(*) FROM mood_entries e
            JOIN users u ON u.id = e.user_id WHERE u.username = $1) AS mood`,
      [account.username],
    );
    return {
      measurements: Number(res.rows[0]?.measurements ?? 0),
      moodEntries: Number(res.rows[0]?.mood ?? 0),
    };
  });
}
