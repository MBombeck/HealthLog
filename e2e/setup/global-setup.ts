/**
 * Playwright globalSetup — seeds the deterministic test user used by the
 * authenticated specs AND logs that user in once, persisting the resulting
 * `healthlog_session` cookie to a `storageState.json` file. Runs ONCE per
 * `pnpm e2e` invocation, before any worker boots.
 *
 * Why login here instead of in each spec:
 *   - The login endpoint is rate-limited to 5 attempts per IP per 15min,
 *     and Playwright runs specs concurrently — even one spec re-logging-in
 *     per `beforeEach` would burn through the limit on the first 6
 *     authenticated tests, causing flake.
 *   - Per-spec login is also slow (argon2 verify ~300ms × N specs).
 *
 * The Next.js prod server that Playwright's `webServer` starts and the
 * seed below both read `process.env.DATABASE_URL`, so they share the
 * same Postgres instance. The seed is idempotent — re-runs against an
 * existing dev DB rotate the password hash and clear AI/Codex state.
 *
 * Implementation note: we talk to Postgres via `pg` (raw SQL), NOT the
 * Prisma client. Playwright's TS loader does not handle the generated
 * Prisma client's `import.meta.url` indirection, and we don't need
 * Prisma's type safety for a one-off upsert. The integration suite
 * (`tests/integration/`) keeps using Prisma because Vitest's loader
 * does support the generated client.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { hash } from "@node-rs/argon2";
import {
  request as playwrightRequest,
  type FullConfig,
} from "@playwright/test";
import pg from "pg";

// Resolve relative to the project root rather than __dirname/import.meta.url —
// Playwright's TS loader runs files as CJS without `"type":"module"`, and
// loading either dirname helper at module scope crashes the test runner.
// The repo layout puts this file at e2e/setup/global-setup.ts so we use
// process.cwd() (== project root for `pnpm e2e`).
export const STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageState.json",
);

export const E2E_USER = {
  email: "e2e@healthlog.test",
  username: "e2e-tester",
  password: "ZJ4hN8x!Pq3vMr2C", // 16 chars, passes zxcvbn min-score-3 gate
  role: "ADMIN",
} as const;

async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
}

function cuid(): string {
  // Match Prisma's default cuid format closely enough that downstream
  // queries that filter on `id LIKE 'c%'` (none currently) keep working.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "c";
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[e2e/global-setup] DATABASE_URL is not set — Playwright cannot seed the test user.",
    );
  }

  const pool = new pg.Pool({ connectionString: url });

  try {
    const passwordHash = await hashPassword(E2E_USER.password);
    const now = new Date();
    const dob = new Date("1985-06-15T00:00:00.000Z");

    // Postgres-native upsert keyed on the unique username column. The
    // SET clause clears any leftover Codex / insights state from a
    // previous run so the "Settings → AI" spec sees the disconnected
    // baseline; we also stamp `onboarding_completed_at` so the auth
    // shell does not bounce the user to /onboarding, AND set
    // `onboarding_tour_completed = true` so the spotlight tour does
    // NOT auto-launch on the dashboard. Without that flag the tour
    // mounts a full-viewport `role="dialog"` overlay with `z-index:200`
    // that intercepts every pointer event — every authenticated spec
    // that tries to click a header / sidebar / quick-add button times
    // out (50+ failed CI runs since v1.4.13). Specs that need the
    // tour can opt back in by mocking `/api/auth/me`.
    // Nutrients is intentionally opt-in in production. The shared fixture
    // enables it because the water-capture specs exercise that real gate.
    await pool.query(
      `INSERT INTO users
        (id, username, email, password_hash, role,
         created_at, updated_at,
         height_cm, date_of_birth, gender,
         codex_connection_status,
         insights_privacy_mode,
         onboarding_completed_at,
         onboarding_tour_completed,
         module_preferences_json)
       VALUES ($1, $2, $3, $4, $5,
               $6, $6,
               180, $7, 'MALE',
               'disconnected',
               'aggregated',
               $6,
               true,
               '{"nutrients":true}'::jsonb)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at,
         height_cm = EXCLUDED.height_cm,
         date_of_birth = EXCLUDED.date_of_birth,
         gender = EXCLUDED.gender,
         codex_access_token_encrypted = NULL,
         codex_refresh_token_encrypted = NULL,
         codex_token_expires_at = NULL,
         codex_connected_at = NULL,
         codex_connection_status = 'disconnected',
         insights_cached_at = NULL,
         insights_cached_text = NULL,
         onboarding_completed_at = EXCLUDED.onboarding_completed_at,
         onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
         module_preferences_json = EXCLUDED.module_preferences_json`,
      [
        cuid(),
        E2E_USER.username,
        E2E_USER.email,
        passwordHash,
        E2E_USER.role,
        now,
        dob,
      ],
    );

    // Repeated local E2E runs reuse the same seeded account and database.
    // Its owner-scoped share-link bucket lasts an hour, so otherwise the third
    // run can start above the 20-operation ceiling and fail before exercising
    // the share flow. Reset only this fixture user's bucket; never touch
    // unrelated rate-limit state in a developer database.
    await pool.query(
      `DELETE FROM rate_limits
       WHERE key = 'share-link:' || (
         SELECT id::text FROM users WHERE username = $1
       )`,
      [E2E_USER.username],
    );

    // Opt the seed account into cycle tracking. The user is seeded as
    // `MALE`, and v1.18.0 resolves the `cycle` module through
    // `isCycleEnabled(gender, CycleProfile)` — NULL `cycleTrackingEnabled`
    // derives from gender, so a male account with no profile reads as
    // cycle-OFF and `/cycle` redirects home. An explicit `true` opts the
    // account in regardless of gender, which is what the cycle spec needs.
    // Keyed by the username subquery so we never depend on the cuid above
    // (the user upsert may have hit the ON CONFLICT path on a re-run).
    await pool.query(
      `INSERT INTO cycle_profiles
        (id, user_id, cycle_tracking_enabled, created_at, updated_at)
       SELECT $1, u.id, true, $2, $2
       FROM users u
       WHERE u.username = $3
       ON CONFLICT (user_id) DO UPDATE SET
         cycle_tracking_enabled = true,
         updated_at = EXCLUDED.updated_at`,
      [cuid(), now, E2E_USER.username],
    );

    // Console (instead of structured logging) is intentional here —
    // global-setup runs outside the app's logging context, and the
    // line is useful when debugging a CI failure where the seed didn't
    // commit.
    console.log(
      `[e2e/global-setup] seeded user ${E2E_USER.username} (${E2E_USER.email})`,
    );
  } finally {
    await pool.end();
  }

  // Login once and persist the resulting cookie jar so every spec can
  // reuse it via `playwright.config.ts → use.storageState`. This is the
  // documented Playwright pattern (`docs/auth.md`) and the only way to
  // avoid the per-spec login + rate-limit dance.
  const baseURL =
    config.projects[0]?.use.baseURL ??
    process.env.E2E_BASE_URL ??
    "http://localhost:3000";

  const ctx = await playwrightRequest.newContext({ baseURL });
  const res = await ctx.post("/api/auth/login", {
    data: {
      email: E2E_USER.username,
      password: E2E_USER.password,
    },
  });
  if (res.status() !== 200) {
    const body = await res.text();
    throw new Error(
      `[e2e/global-setup] login failed: HTTP ${res.status()} — ${body.slice(0, 200)}`,
    );
  }
  const state = await ctx.storageState();
  // Strip any cookies we don't recognise so storageState only carries
  // what the auth shell needs. v1.4.22 C4 added `hl_onboarding` — the
  // login route sets it to "pending" for new users and DELETES it for
  // already-onboarded ones, so for our pre-seeded completed e2e user
  // the cookie is absent and the proxy passes the dashboard through.
  state.cookies = state.cookies.filter((c) =>
    ["healthlog_session", "healthlog-locale", "hl_onboarding"].includes(c.name),
  );
  // v1.27.11 — pin the shared auth state to English via an explicit locale
  // cookie. The server now honours `User.locale` when the cookie is absent
  // (the ITP fix), and the locale-switch spec mirrors its German pick into
  // the SHARED e2e user's profile — without this cookie every spec running
  // after it would render German and the English-string assertions fail.
  // The cookie sits at the top of the resolution ladder, so each spec
  // context stays deterministically English; locale-switch overrides it
  // inside its own context only.
  const base = new URL(baseURL);
  state.cookies = state.cookies.filter((c) => c.name !== "healthlog-locale");
  state.cookies.push({
    name: "healthlog-locale",
    value: "en",
    domain: base.hostname,
    path: "/",
    expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  });
  await writeFile(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
  await ctx.dispose();
  console.log(
    `[e2e/global-setup] auth state captured to ${STORAGE_STATE_PATH}`,
  );
}
