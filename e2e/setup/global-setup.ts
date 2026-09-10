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

/**
 * v1.36.0 — the SECOND account, so account sharing has two sides to test.
 *
 * Sharing is the one feature in the product that cannot be exercised by one
 * person: somebody has to own a record and somebody else has to be given it.
 * This account owns the record; `E2E_USER` is the delegate throughout the
 * sharing spec.
 */
export const E2E_OWNER = {
  email: "e2e-owner@healthlog.test",
  username: "e2e-owner",
  password: "Qv7bR2n!Ks9wLd4T",
  role: "USER",
} as const;

/**
 * v1.37.2 — the owner carries a full name, so the switcher journey can assert
 * that a delegate sees it. Generic on purpose: fixtures hold no real name.
 */
export const E2E_OWNER_FULL_NAME = "Test Full Name";

/**
 * The backup/restore journey's own account.
 *
 * Its own account, and an administrative one, because the restore path is
 * admin-only by construction (`requireAdmin()` is cookie-only) and because the
 * journey is destructive on purpose: it deletes rows, restores an earlier
 * snapshot over them, and asserts what came back. Pointing that at an account
 * any other spec reads would make every one of them depend on where this
 * journey happens to be.
 */
export const E2E_BACKUP_ADMIN = {
  email: "e2e-backup-admin@healthlog.test",
  username: "e2e-backup-admin",
  password: "Hw3!Tq7vZm2xRb8L",
  role: "ADMIN",
} as const;

/**
 * The read-level delegate on that account's record.
 *
 * The refusing half of the journey needs somebody who is inside the record and
 * still has no business taking or replaying a copy of it. A separate account
 * rather than one of the existing delegates: this one is granted READ over the
 * whole record above, and reusing a delegate would change what the scoped
 * journeys see.
 */
export const E2E_BACKUP_DELEGATE = {
  email: "e2e-backup-delegate@healthlog.test",
  username: "e2e-backup-delegate",
  password: "Ld6!Yn4kW9pJc3Vt",
  role: "USER",
} as const;

/**
 * v1.37.0 — the account that creates and administers managed profiles.
 *
 * Its own account, and not one of the others, for one reason: every route in
 * the managed-profile family resolves `requireFreshMfa`, which refuses an
 * account with NO second factor enrolled (`auth.stepup.mfa_not_enrolled`). So
 * this account carries a confirmed TOTP secret, and an account with a confirmed
 * secret cannot be logged in by the password-only capture below. The setup
 * therefore logs it in FIRST and stamps the factor afterwards — see the
 * enrolment step at the end of `globalSetup`.
 *
 * Enrolling the factor on a shared account would have changed behaviour for
 * every spec that touches a step-up-gated surface, starting with the MANAGE
 * invitation on the sharing panel.
 */
export const E2E_GUARDIAN = {
  email: "e2e-guardian@healthlog.test",
  username: "e2e-guardian",
  password: "Rt5!Nm8xQ3wZ6bJp",
  role: "USER",
} as const;

/**
 * The medication-adherence journey's own account.
 *
 * The batched compliance read is capped at thirty calls a minute per ACTOR,
 * and the journey spends that allowance twice over: it writes doses and then
 * reads the resulting rates back off the same cabinet. On the shared account
 * the allowance is also being spent by whichever sibling happens to be
 * mounting `/medications` in the other worker, and the cabinet itself is
 * shared with them — so the journey's `beforeEach` clear would take rows
 * somebody else seeded with it. One account of its own makes the rate-limit
 * bucket, the cabinet and the dashboard tile's denominator private at once.
 */
export const E2E_MEDICATION = {
  email: "e2e-medication@healthlog.test",
  username: "e2e-medication",
  password: "Hj6!Tw2pV9sQ4nDx",
  role: "USER",
} as const;

/**
 * The notification-dispatch journey's own account.
 *
 * It has one, rather than borrowing the shared fixture, because the journey's
 * verdicts are counts over ONE account's `push_attempts` ledger — "one email
 * attempt, no ntfy attempt, the APNs arm skipped and for which reason".
 *
 * The direction that matters is the one that is easy to state backwards. The
 * exposure is not mainly that another spec writes into this account's window;
 * it is that this journey's own trigger — the admin reminder sweep — dispatches
 * for whatever accounts it is pointed at, and pointed at the instance it
 * reaches all of them. A dedicated account gives the sweep something to name,
 * so the run stays a writer for exactly one ledger and a reader of exactly the
 * same one.
 *
 * ADMIN because the two surfaces the journey reads the dispatch decision
 * through — the reminder trigger and the notification diagnostic — are
 * `requireAdmin()`, which is cookie-only by construction.
 */
export const E2E_NOTIFY = {
  email: "e2e-notify@healthlog.test",
  username: "e2e-notify",
  password: "Xd6!Ct3pW9qBz5Fh",
  role: "ADMIN",
} as const;

export const NOTIFY_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateNotify.json",
);

/** A separate delegate session for the eight scoped-record browser journeys. */
export const E2E_SCOPE_DELEGATE = {
  email: "e2e-scope-delegate@healthlog.test",
  username: "e2e-scope-delegate",
  password: "Qz8!Vp4rL2nX7mKs",
  role: "USER",
} as const;

/**
 * The doctor-report journey's own account.
 *
 * Generating a report WRITES: the route remembers the scope and the practice
 * name on the account row, and the panel a later visit opens is therefore the
 * "repeat run" state with the picker collapsed. `settings-export.spec.ts`
 * asserts the opposite — an expanded picker, an empty summary, a disabled
 * button — against the shared account, so a journey that generated there would
 * turn nine of its assertions red the moment the two files happened to run in
 * the wrong order, and keep them red on every later run against the same
 * database.
 *
 * Its own account also keeps the seeded readings, the emergency profile and
 * the hourly export bucket off the account sixty other specs read.
 *
 * `date_format` is pinned rather than left on AUTO: the spec reads the period
 * line out of the rendered PDF and has to know which field is the month.
 */
export const E2E_REPORT_OWNER = {
  email: "e2e-report-owner@healthlog.test",
  username: "e2e-report-owner",
  password: "Hd6!Tw3pV9nQ2xLb",
  role: "USER",
} as const;

/** One non-personal target record per closed sharing domain. */
export const E2E_SCOPE_RECORDS = [
  {
    domain: "measurements",
    username: "e2e-scope-measurements",
    href: "/measurements",
  },
  {
    domain: "medications",
    username: "e2e-scope-medications",
    href: "/medications",
  },
  { domain: "labs", username: "e2e-scope-labs", href: "/labs" },
  { domain: "profile", username: "e2e-scope-profile", href: "/profile" },
  { domain: "illness", username: "e2e-scope-illness", href: "/illness" },
  { domain: "mind", username: "e2e-scope-mind", href: "/mood" },
  { domain: "cycle", username: "e2e-scope-cycle", href: "/cycle" },
  { domain: "documents", username: "e2e-scope-documents", href: "/documents" },
] as const;

/**
 * Whole-record grants used to prove the three adult access levels and the
 * separate managed-profile boundary in a real browser session.
 */
export const E2E_LEVEL_RECORDS = [
  {
    username: "e2e-level-read",
    access: "READ",
    recordKind: "shared",
  },
  {
    username: "e2e-level-write",
    access: "WRITE",
    recordKind: "shared",
  },
  {
    username: "e2e-level-manage",
    access: "MANAGE",
    recordKind: "shared",
  },
  {
    username: "e2e-level-managed",
    access: "MANAGE",
    recordKind: "managed",
  },
] as const;

/**
 * Weights seeded one per account, chosen so neither can be mistaken for the
 * other in rendered markup and neither collides with a value any other spec
 * writes.
 *
 * The delegate's number is the whole point of the stale-paint check: after
 * switching into the owner's record it must appear NOWHERE, at no moment. A
 * spec that only waited for the owner's data to arrive would prove nothing
 * about what was on screen in between.
 */
export const E2E_DELEGATE_MARKER_KG = 77.7;
export const E2E_OWNER_MARKER_KG = 63.3;

export const OWNER_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateOwner.json",
);

/**
 * A SECOND cookie jar for the same delegate account, and the reason it exists
 * is the one property that makes account switching work at all: the switch is
 * stamped on the session row, not held in the tab. Every session opened from
 * `STORAGE_STATE_PATH` is therefore the same session — so a spec that switches
 * that jar into somebody else's record switches it for every spec that
 * authenticates with it, whichever of them happens to be mid-navigation on the
 * other worker.
 *
 * The symptom is a wandering one: `/settings/ai` painting "Not part of shared
 * access", an axe scan reading a banner nobody asked for, a `waitForResponse`
 * on a request the refused surface never sends. Nothing in the failing spec is
 * wrong and nothing in its file explains it.
 *
 * So the journey that switches gets its own login, and the shared jar is never
 * pointed anywhere. Same account, different session row, no overlap.
 */
export const DELEGATE_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateDelegate.json",
);

export const SCOPE_DELEGATE_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateScopeDelegate.json",
);

export const SCOPE_A11Y_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateScopeA11y.json",
);

/**
 * v1.38.12 — the managed-record capabilities journey's own jar. Same scope
 * delegate, its own session row, for the reason every switching spec has
 * one: it moves the record selector, and two specs driving one row from two
 * workers would test their interference rather than the controls.
 */
export const SCOPE_CAPABILITIES_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateScopeCapabilities.json",
);

/** The adherence journey's jar — see `E2E_MEDICATION` for why it is its own. */
export const MEDICATION_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateMedication.json",
);

/**
 * v1.37.0 — one jar per SWITCHING spec, for the reason spelled out at
 * `DELEGATE_STORAGE_STATE_PATH` above and now applied to the scope delegate as
 * well.
 *
 * The record-session fence made the cost visible. Four specs moved the same
 * session row's record selector — the two fence specs, the cross-tab journey
 * and the scoped-sharing journey — and the fence's whole subject is that row's
 * context and its monotonic epoch. On one worker they never overlapped; on two
 * they moved the epoch under each other, and the failure was the harness racing
 * itself. Passing only at `--workers=1` is not a passing suite: CI runs two.
 *
 * A separate LOGIN, not a separate account: the selector lives on the session
 * row, so two jars for one account are two independent contexts. The grants,
 * the fixtures and the assertions all stay exactly as they were.
 */
export const FENCE_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateFence.json",
);

export const FENCE_OFFLINE_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateFenceOffline.json",
);

/**
 * The managed-profile journey's own jar. Its own session row, like every other
 * switching spec, so a run at CI's worker count cannot have two specs moving
 * the same session's record selector.
 */
export const GUARDIAN_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateGuardian.json",
);

export const CROSS_TAB_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateCrossTab.json",
);

/** The backup/restore journey's jar, for the account it owns outright. */
export const BACKUP_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateBackup.json",
);

/**
 * The read-level delegate's jar for that journey. Its own session row, like
 * every other switching spec's — the refusal control switches into the
 * journey's record, and the switch is stamped on the row rather than held in
 * the tab.
 */
export const BACKUP_DELEGATE_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateBackupDelegate.json",
);

/**
 * The doctor-report delegate journey's jar. Its own session row, for the reason
 * every switching spec has one: it opens somebody else's record to prove the
 * report refuses a READ-level grant, and two specs driving one row from two
 * workers would test their interference rather than the refusal.
 */
export const REPORT_DELEGATE_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateReportDelegate.json",
);

/**
 * The doctor-report journey's jar. Its own account, so what generating a report
 * stamps on the account row cannot reach the shared one — see `E2E_REPORT_OWNER`.
 */
export const REPORT_OWNER_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateReportOwner.json",
);

/**
 * The banner-geometry spec's jar, and the reason it exists is a release-shaped
 * one rather than a load-shaped one.
 *
 * `chrome-header-seam-banners.spec.ts` needs a session that is INSIDE somebody
 * else's record, because one of the strips it stacks only paints there. It used
 * to produce that state by capturing `/api/auth/me` and serving it back with
 * the sharing block filled — cheaper than a switch, and self-contained, which is
 * exactly why it was written that way.
 *
 * v1.37.0 ended that. The record context is now proved across three places at
 * once — the payload's own validator (fail-closed, no partial credit), the fence
 * store's scope, and the transition machine that has to agree with both — so a
 * payload claiming a shared record while the session row still says `self` is a
 * state the shell refuses on purpose. A single route mock can no longer make it,
 * and the honest fix is to stop faking it: switch for real, and take a jar of
 * its own so moving one session row cannot move anybody else's.
 */
export const SEAM_BANNERS_STORAGE_STATE_PATH = resolve(
  process.cwd(),
  "e2e/setup/storageStateSeamBanners.json",
);

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
    // enables it so the nutrients/hydration display specs render the card.
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
         module_preferences_json = EXCLUDED.module_preferences_json,
         report_selection_json = NULL,
         last_report_practice_name = NULL`,
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

    // v1.37.0 — the managed-profile guardian. Seeded exactly like the other
    // fixture accounts; its second factor is stamped AFTER the login capture,
    // because the password-only capture cannot complete a TOTP login.
    await pool.query(
      `INSERT INTO users
        (id, username, email, password_hash, role, created_at, updated_at,
         onboarding_completed_at, onboarding_tour_completed)
       VALUES ($1, $2, $3, $4, 'USER', $5, $5, $5, true)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         updated_at = EXCLUDED.updated_at,
         onboarding_completed_at = EXCLUDED.onboarding_completed_at,
         onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
         totp_confirmed_at = NULL`,
      [
        cuid(),
        E2E_GUARDIAN.username,
        E2E_GUARDIAN.email,
        await hashPassword(E2E_GUARDIAN.password),
        now,
      ],
    );

    // Whatever a previous run created. A managed profile is a real account row,
    // so a suite that left one behind would find the guardian looking after two
    // records on the next run and the roster assertions would read the wrong
    // one. Deleting the profile takes its grants with it.
    await pool.query(
      `DELETE FROM users
       WHERE managed_profile_at IS NOT NULL
         AND id IN (
           SELECT g.grantor_id FROM account_grants g
           JOIN users u ON u.id = g.grantee_id
           WHERE u.username = $1
         )`,
      [E2E_GUARDIAN.username],
    );

    // The adherence journey's account. Modules are pinned rather than left to
    // the defaults: the dashboard's medication tile is one of the surfaces the
    // journey reads, and it only paints while the module is on.
    await pool.query(
      `INSERT INTO users
        (id, username, email, password_hash, role, created_at, updated_at,
         onboarding_completed_at, onboarding_tour_completed,
         module_preferences_json)
       VALUES ($1, $2, $3, $4, 'USER', $5, $5, $5, true, $6::jsonb)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         updated_at = EXCLUDED.updated_at,
         onboarding_completed_at = EXCLUDED.onboarding_completed_at,
         onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
         module_preferences_json = EXCLUDED.module_preferences_json`,
      [
        cuid(),
        E2E_MEDICATION.username,
        E2E_MEDICATION.email,
        await hashPassword(E2E_MEDICATION.password),
        now,
        JSON.stringify({ medications: true }),
      ],
    );

    // The notification-dispatch journey's account. Seeded like the others;
    // its channels, devices, ledger rows and preferences are reset by
    // `e2e/setup/notification-fixture.ts` before every test, because the
    // journey has to be re-runnable and `--repeat-each` is exactly the case a
    // once-per-suite reset does not cover.
    await pool.query(
      `INSERT INTO users
        (id, username, email, password_hash, role, created_at, updated_at,
         onboarding_completed_at, onboarding_tour_completed)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, true)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at,
         onboarding_completed_at = EXCLUDED.onboarding_completed_at,
         onboarding_tour_completed = EXCLUDED.onboarding_tour_completed`,
      [
        cuid(),
        E2E_NOTIFY.username,
        E2E_NOTIFY.email,
        await hashPassword(E2E_NOTIFY.password),
        E2E_NOTIFY.role,
        now,
      ],
    );

    // The doctor-report journey's account. Seeded like the shared one — a
    // record with a height, a date of birth and a gender, so the report has a
    // patient header to print — and with the two report columns cleared, which
    // is what puts the panel back into its first-run state on every run.
    await pool.query(
      `INSERT INTO users
        (id, username, email, password_hash, role, created_at, updated_at,
         height_cm, date_of_birth, gender, date_format,
         onboarding_completed_at, onboarding_tour_completed)
       VALUES ($1, $2, $3, $4, 'USER', $5, $5,
               180, $6, 'MALE', 'MDY',
               $5, true)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         updated_at = EXCLUDED.updated_at,
         height_cm = EXCLUDED.height_cm,
         date_of_birth = EXCLUDED.date_of_birth,
         gender = EXCLUDED.gender,
         date_format = EXCLUDED.date_format,
         onboarding_completed_at = EXCLUDED.onboarding_completed_at,
         onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
         report_selection_json = NULL,
         last_report_practice_name = NULL`,
      [
        cuid(),
        E2E_REPORT_OWNER.username,
        E2E_REPORT_OWNER.email,
        await hashPassword(E2E_REPORT_OWNER.password),
        now,
        dob,
      ],
    );

    // The scoped-record journey uses a dedicated delegate so its preseeded
    // grants cannot affect the invitation lifecycle exercised by the sharing
    // journey above. Its own module preferences are explicitly off: a target
    // record's resolved scope, rather than the actor's preferences, must keep
    // each granted doorway visible.
    await pool.query(
      `INSERT INTO users
        (id, username, email, password_hash, role, created_at, updated_at,
         onboarding_completed_at, onboarding_tour_completed,
         module_preferences_json)
       VALUES ($1, $2, $3, $4, 'USER', $5, $5, $5, true, $6::jsonb)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         updated_at = EXCLUDED.updated_at,
         onboarding_completed_at = EXCLUDED.onboarding_completed_at,
         onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
         module_preferences_json = EXCLUDED.module_preferences_json`,
      [
        cuid(),
        E2E_SCOPE_DELEGATE.username,
        E2E_SCOPE_DELEGATE.email,
        await hashPassword(E2E_SCOPE_DELEGATE.password),
        now,
        JSON.stringify({
          medications: false,
          labs: false,
          illness: false,
          mood: false,
          mentalHealth: false,
          inboundDocuments: false,
        }),
      ],
    );

    await pool.query(
      `DELETE FROM account_grants
       WHERE grantee_id = (SELECT id FROM users WHERE username = $1)`,
      [E2E_SCOPE_DELEGATE.username],
    );
    await pool.query(
      `UPDATE sessions SET acting_as_user_id = NULL
       WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
      [E2E_SCOPE_DELEGATE.username],
    );

    for (const record of E2E_SCOPE_RECORDS) {
      await pool.query(
        `INSERT INTO users
          (id, username, email, password_hash, role, created_at, updated_at,
           onboarding_completed_at, onboarding_tour_completed,
           module_preferences_json)
         VALUES ($1, $2, $3, NULL, 'USER', $4, $4, $4, true, $5::jsonb)
         ON CONFLICT (username) DO UPDATE SET
           email = EXCLUDED.email,
           updated_at = EXCLUDED.updated_at,
           onboarding_completed_at = EXCLUDED.onboarding_completed_at,
           onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
           module_preferences_json = EXCLUDED.module_preferences_json`,
        [
          cuid(),
          record.username,
          `${record.username}@healthlog.test`,
          now,
          JSON.stringify({
            medications: true,
            labs: true,
            illness: true,
            mood: true,
            mentalHealth: true,
            inboundDocuments: true,
          }),
        ],
      );

      await pool.query(
        `INSERT INTO account_grants
          (id, grantor_id, grantee_id, access, scope_json, invited_at,
           accepted_at, created_at)
         SELECT $1, owner.id, delegate.id, 'READ', $2::jsonb, $3, $3, $3
         FROM users owner, users delegate
         WHERE owner.username = $4 AND delegate.username = $5`,
        [
          cuid(),
          JSON.stringify([record.domain]),
          now,
          record.username,
          E2E_SCOPE_DELEGATE.username,
        ],
      );
    }

    // Whole-record fixtures intentionally sit beside the narrow records
    // above. They make the browser prove the presentation and mutation
    // boundaries of READ, WRITE, MANAGE, and a guardian-managed record
    // without changing the invitation lifecycle fixture below.
    for (const record of E2E_LEVEL_RECORDS) {
      await pool.query(
        `INSERT INTO users
          (id, username, email, password_hash, role, created_at, updated_at,
           managed_profile_at, onboarding_completed_at,
           onboarding_tour_completed, module_preferences_json)
         VALUES ($1, $2, $3, NULL, 'USER', $4, $4, $5, $4, true, $6::jsonb)
         ON CONFLICT (username) DO UPDATE SET
           email = EXCLUDED.email,
           password_hash = NULL,
           updated_at = EXCLUDED.updated_at,
           managed_profile_at = EXCLUDED.managed_profile_at,
           onboarding_completed_at = EXCLUDED.onboarding_completed_at,
           onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
           module_preferences_json = EXCLUDED.module_preferences_json,
           report_selection_json = NULL,
           last_report_practice_name = NULL`,
        [
          cuid(),
          record.username,
          `${record.username}@healthlog.test`,
          now,
          record.recordKind === "managed" ? now : null,
          JSON.stringify({
            medications: true,
            labs: true,
            illness: true,
            mood: true,
            mentalHealth: true,
            inboundDocuments: true,
          }),
        ],
      );

      await pool.query(
        `INSERT INTO account_grants
          (id, grantor_id, grantee_id, access, scope_json, invited_at,
           accepted_at, created_at)
         SELECT $1, owner.id, delegate.id, $2, NULL, $3, $3, $3
         FROM users owner, users delegate
         WHERE owner.username = $4 AND delegate.username = $5`,
        [
          cuid(),
          record.access,
          now,
          record.username,
          E2E_SCOPE_DELEGATE.username,
        ],
      );
    }

    // Cycle is delegated to its profile gate rather than module preferences.
    await pool.query(
      `INSERT INTO cycle_profiles
        (id, user_id, cycle_tracking_enabled, created_at, updated_at)
       SELECT $1, u.id, true, $2, $2
       FROM users u WHERE u.username = $3
       ON CONFLICT (user_id) DO UPDATE SET
         cycle_tracking_enabled = true,
         updated_at = EXCLUDED.updated_at`,
      [cuid(), now, "e2e-scope-cycle"],
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

    // The export bucket, for the same reason and with the same shape. Every
    // export route shares one 10-per-hour bucket keyed on the ACTOR, the
    // counter outlives a run by a full hour, and the doctor-report journey
    // spends two of it per pass — so a fourth run inside the hour would meet a
    // 429 and report a missing artefact rather than a spent quota. Only the two
    // accounts that generate a report are cleared.
    await pool.query(
      `DELETE FROM rate_limits
       WHERE key IN (
         SELECT 'export:' || id::text FROM users WHERE username = ANY($1)
       )`,
      [[E2E_REPORT_OWNER.username, E2E_SCOPE_DELEGATE.username]],
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

    // ── v1.36.0 — the sharing fixture ────────────────────────────────────
    //
    // A second account, one distinctive weight in each record, and a clean
    // grant table. The reset matters as much as the seed: grants and switch
    // stamps outlive a run, and a second run starting with the delegate
    // already inside the owner's record would skip the invitation half of
    // the journey while still going green.
    await pool.query(
      `INSERT INTO users
        (id, username, email, password_hash, role,
         created_at, updated_at,
         onboarding_completed_at, onboarding_tour_completed, full_name)
       VALUES ($1, $2, $3, $4, 'USER', $5, $5, $5, true, $6)
       ON CONFLICT (username) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         updated_at = EXCLUDED.updated_at,
         onboarding_completed_at = EXCLUDED.onboarding_completed_at,
         onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
         full_name = EXCLUDED.full_name`,
      [
        cuid(),
        E2E_OWNER.username,
        E2E_OWNER.email,
        await hashPassword(E2E_OWNER.password),
        now,
        E2E_OWNER_FULL_NAME,
      ],
    );

    // Every grant between the pair, and any switch stamp either of them is
    // carrying. Deleted rather than revoked: this is fixture hygiene, not a
    // lifecycle transition, and a revoked row would still show in the panel.
    await pool.query(
      `DELETE FROM account_grants
       WHERE grantor_id IN (SELECT id FROM users WHERE username = ANY($1))
          OR grantee_id IN (SELECT id FROM users WHERE username = ANY($1))`,
      [[E2E_USER.username, E2E_OWNER.username]],
    );
    await pool.query(
      `UPDATE sessions SET acting_as_user_id = NULL
       WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1))`,
      [[E2E_USER.username, E2E_OWNER.username]],
    );
    await pool.query(
      `DELETE FROM rate_limits
       WHERE key LIKE 'sharing:%'`,
    );

    // The login bucket, for the same reason. This setup signs in SEVENTEEN times now
    // (the shared jar, the owner, and one jar apiece for every spec that moves
    // a session's record selector), and the ceiling is five attempts per IP per
    // quarter-hour — so two local runs in a row would otherwise end with a 429
    // from the fixture rather than a failure from the product. Only the auth
    // surfaces' own buckets are cleared; nothing else in the table is touched.
    await pool.query(`DELETE FROM rate_limits WHERE key LIKE 'auth:%'`);

    // One marker weight per record. Re-seeded by delete-then-insert so a
    // re-run cannot accumulate duplicates and so an edited constant takes
    // effect rather than sitting beside the old value.
    for (const [username, kg] of [
      [E2E_USER.username, E2E_DELEGATE_MARKER_KG],
      [E2E_OWNER.username, E2E_OWNER_MARKER_KG],
    ] as const) {
      await pool.query(
        `DELETE FROM measurements
         WHERE user_id = (SELECT id FROM users WHERE username = $1)
           AND external_id = 'e2e-sharing-marker'`,
        [username],
      );
      await pool.query(
        `INSERT INTO measurements
          (id, user_id, type, value, unit, source, measured_at,
           external_id, created_at, updated_at)
         SELECT $1, u.id, 'WEIGHT', $2, 'kg', 'MANUAL', $3,
                'e2e-sharing-marker', $3, $3
         FROM users u WHERE u.username = $4`,
        // `measured_at` is `timestamp without time zone` and the driver
        // serialises a `Date` in the HOST's zone, so a developer machine east
        // of UTC seeded this row hours into the FUTURE — where every fold
        // whose window ends "now" skips it, and the type stays uncovered.
        // Send the instant as UTC, the same shape the app's own writes take.
        [cuid(), kg, now.toISOString(), username],
      );
    }

    // v1.37.0 — clear what the browser suite WRITES, so the suite can be run
    // twice.
    //
    // The adult-WRITE journey saves a blood-pressure reading through the real
    // form, and the form stamps a minute-rounded `measuredAt`. Two runs inside
    // the same minute therefore collide on the natural key
    // (user, type, measured_at, source) — the second save is a duplicate, and
    // the journey asserts its POST succeeded. It has always been that way; it
    // used to surface as a 500 and now surfaces as the 409 the route learned to
    // give, which is what made it legible. A suite that cannot be re-run is a
    // suite whose green is a statement about the clock.
    //
    // Only rows the journey itself creates: MANUAL, and carrying no
    // `external_id`, which is what distinguishes them from the seeded markers
    // above.
    await pool.query(
      `DELETE FROM measurements
        WHERE user_id = (SELECT id FROM users WHERE username = $1)
          AND source = 'MANUAL'
          AND external_id IS NULL`,
      ["e2e-level-write"],
    );

    // ── the backup/restore journey's pair ────────────────────────────────
    //
    // The account the journey owns, with the three modules its readings need
    // switched on, and the delegate that holds READ over the whole record.
    // Both are re-seeded here rather than in the spec so the journey never
    // spends a login on a surface the setup already owns.
    for (const account of [E2E_BACKUP_ADMIN, E2E_BACKUP_DELEGATE] as const) {
      await pool.query(
        `INSERT INTO users
          (id, username, email, password_hash, role, created_at, updated_at,
           onboarding_completed_at, onboarding_tour_completed,
           module_preferences_json)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $6, true, $7::jsonb)
         ON CONFLICT (username) DO UPDATE SET
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           updated_at = EXCLUDED.updated_at,
           onboarding_completed_at = EXCLUDED.onboarding_completed_at,
           onboarding_tour_completed = EXCLUDED.onboarding_tour_completed,
           module_preferences_json = EXCLUDED.module_preferences_json,
           totp_confirmed_at = NULL`,
        [
          cuid(),
          account.username,
          account.email,
          await hashPassword(account.password),
          account.role,
          now,
          JSON.stringify({
            medications: true,
            mood: true,
            inboundDocuments: true,
          }),
        ],
      );
    }

    // Grant hygiene before the grant, for the reason the sharing fixture
    // states above: a grant and a switch stamp both outlive a run.
    await pool.query(
      `DELETE FROM account_grants
       WHERE grantor_id IN (SELECT id FROM users WHERE username = ANY($1))
          OR grantee_id IN (SELECT id FROM users WHERE username = ANY($1))`,
      [[E2E_BACKUP_ADMIN.username, E2E_BACKUP_DELEGATE.username]],
    );
    await pool.query(
      `UPDATE sessions SET acting_as_user_id = NULL
       WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1))`,
      [[E2E_BACKUP_ADMIN.username, E2E_BACKUP_DELEGATE.username]],
    );
    // Whole-record READ: `scope_json` NULL is the un-narrowed grant, which is
    // the strongest read a delegate can hold and therefore the honest subject
    // for "and still cannot take or replay a copy".
    await pool.query(
      `INSERT INTO account_grants
        (id, grantor_id, grantee_id, access, scope_json, invited_at,
         accepted_at, created_at)
       SELECT $1, owner.id, delegate.id, 'READ', NULL, $2, $2, $2
       FROM users owner, users delegate
       WHERE owner.username = $3 AND delegate.username = $4`,
      [cuid(), now, E2E_BACKUP_ADMIN.username, E2E_BACKUP_DELEGATE.username],
    );

    // Console (instead of structured logging) is intentional here —
    // global-setup runs outside the app's logging context, and the
    // line is useful when debugging a CI failure where the seed didn't
    // commit.
    console.log(
      `[e2e/global-setup] seeded user ${E2E_USER.username} (${E2E_USER.email})`,
    );
    // Log the fixture accounts in here and persist their cookie jars so specs
    // can reuse them via `test.use({ storageState })`. This is the documented
    // Playwright pattern (`docs/auth.md`) and the only way to avoid the
    // per-spec login + rate-limit dance.
    const baseURL =
      config.projects[0]?.use.baseURL ??
      process.env.E2E_BASE_URL ??
      "http://localhost:3000";

    /**
     * Log one account in, clearing the login bucket first.
     *
     * The ceiling is FIVE attempts per IP per quarter-hour and this setup now
     * signs in seventeen times, so clearing once before the batch is no longer
     * enough — the sixth would be answered by the fixture's own 429 rather
     * than by the product. Only the auth surfaces' buckets are touched, and
     * only between logins this setup is itself performing.
     */
    const capture = async (
      account: { username: string; password: string },
      path: string,
    ): Promise<void> => {
      await pool.query(`DELETE FROM rate_limits WHERE key LIKE 'auth:%'`);
      await captureAuthState(baseURL, account, path);
    };

    // The shared jar every authenticated spec reads.
    await capture(E2E_USER, STORAGE_STATE_PATH);

    // v1.36.0 — the owner's jar. The sharing journey needs both sides of a
    // grant signed in at once, and the login endpoint is IP-rate-limited, so
    // the owner is logged in here rather than inside the spec.
    await capture(E2E_OWNER, OWNER_STORAGE_STATE_PATH);

    // The delegate's own jar for that journey. Same account as the shared one,
    // deliberately a different session row — see DELEGATE_STORAGE_STATE_PATH
    // for what happens when the journey switches the shared row instead.
    await capture(E2E_USER, DELEGATE_STORAGE_STATE_PATH);

    // The adherence journey's jar. Its own account, so nothing it writes and
    // nothing it clears is visible to the shared one.
    await capture(E2E_MEDICATION, MEDICATION_STORAGE_STATE_PATH);

    // The notification-dispatch journey's jar. Its own account, so its own
    // login — see `E2E_NOTIFY` for why the ledger counts need one.
    await capture(E2E_NOTIFY, NOTIFY_STORAGE_STATE_PATH);

    await capture(E2E_SCOPE_DELEGATE, SCOPE_DELEGATE_STORAGE_STATE_PATH);
    await capture(E2E_SCOPE_DELEGATE, SCOPE_A11Y_STORAGE_STATE_PATH);
    await capture(E2E_SCOPE_DELEGATE, SCOPE_CAPABILITIES_STORAGE_STATE_PATH);

    // v1.37.0 — one jar per switching spec. See the block comment on
    // FENCE_STORAGE_STATE_PATH: these three used to share the scope delegate's
    // row with the scoped-sharing journey, which is why the suite only passed
    // on a single worker.
    await capture(E2E_SCOPE_DELEGATE, FENCE_STORAGE_STATE_PATH);
    await capture(E2E_SCOPE_DELEGATE, FENCE_OFFLINE_STORAGE_STATE_PATH);
    await capture(E2E_SCOPE_DELEGATE, CROSS_TAB_STORAGE_STATE_PATH);
    await capture(E2E_SCOPE_DELEGATE, SEAM_BANNERS_STORAGE_STATE_PATH);
    await capture(E2E_SCOPE_DELEGATE, REPORT_DELEGATE_STORAGE_STATE_PATH);

    // The doctor-report journey's own account, for the reason written on
    // E2E_REPORT_OWNER: generating a report writes to the account row.
    await capture(E2E_REPORT_OWNER, REPORT_OWNER_STORAGE_STATE_PATH);

    // The backup/restore journey's pair.
    await capture(E2E_BACKUP_ADMIN, BACKUP_STORAGE_STATE_PATH);
    await capture(E2E_BACKUP_DELEGATE, BACKUP_DELEGATE_STORAGE_STATE_PATH);

    // v1.37.0 — the guardian's jar, and only then its second factor.
    //
    // Order is the whole of it. `requireFreshMfa` refuses an account with no
    // factor enrolled, so the managed-profile routes are unreachable without
    // this; and `captureAuthState` posts a password to `/api/auth/login`, which
    // for a TOTP account answers with a challenge rather than a session. Log in
    // first, enrol second. The freshness stamp on the session is refreshed by
    // the spec immediately before it acts — the window is five minutes and a
    // full suite run is longer than that.
    await capture(E2E_GUARDIAN, GUARDIAN_STORAGE_STATE_PATH);
    await pool.query(
      `UPDATE users SET totp_confirmed_at = $2 WHERE username = $1`,
      [E2E_GUARDIAN.username, now],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Log one account in and write its cookie jar to `path`.
 *
 * Each call mints a fresh session row, so two jars for the same account are
 * two independent browser sessions — which is the whole point of the delegate
 * jar above.
 *
 * Only the cookies the auth shell needs survive the filter. v1.4.22 C4 added
 * `hl_onboarding`: the login route sets it to "pending" for a new account and
 * DELETES it for an already-onboarded one, so for these pre-seeded accounts it
 * is absent and the proxy passes the dashboard through.
 *
 * v1.27.11 — the locale cookie is pinned to English rather than inherited. The
 * server honours `User.locale` when the cookie is absent (the ITP fix), and
 * the locale-switch spec mirrors its German pick into the SHARED account's
 * profile — without this cookie every spec running after it would render
 * German and the English-string assertions would fail. The cookie sits at the
 * top of the resolution ladder, so each spec context stays deterministically
 * English; locale-switch overrides it inside its own context only.
 */
async function captureAuthState(
  baseURL: string,
  account: { username: string; password: string },
  path: string,
): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL });
  try {
    const res = await ctx.post("/api/auth/login", {
      data: { email: account.username, password: account.password },
    });
    if (res.status() !== 200) {
      const body = await res.text();
      throw new Error(
        `[e2e/global-setup] login failed for ${account.username}: HTTP ${res.status()} — ${body.slice(0, 200)}`,
      );
    }
    const state = await ctx.storageState();
    state.cookies = state.cookies.filter((c) =>
      ["healthlog_session", "hl_onboarding"].includes(c.name),
    );
    state.cookies.push({
      name: "healthlog-locale",
      value: "en",
      domain: new URL(baseURL).hostname,
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    });
    await writeFile(path, JSON.stringify(state, null, 2));
    console.log(`[e2e/global-setup] auth state captured to ${path}`);
  } finally {
    await ctx.dispose();
  }
}
