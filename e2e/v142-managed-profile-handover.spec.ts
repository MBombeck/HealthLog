/**
 * v1.42 (#959) — a managed profile handed over to the person it describes,
 * end to end in a browser: the Guardian mints the link, the person opens it in
 * a browser that has never signed in, chooses a sign-in, lands on the decision
 * about their former Guardian, and decides.
 *
 * The link is never mailed (by design: it is shown once and handed over in
 * person or scanned). This journey "mails" it by reading it off the panel's
 * `data-handover-url` and opening it in a second, cookie-less browser context,
 * which is exactly the hop a person makes with a phone.
 *
 * Its own Guardian account, per project, seeded here: the shared
 * `e2e-guardian` belongs to the managed-profile journey, which clears every
 * profile that account looks after, and the two would delete each other's
 * records mid-run. Every assertion addresses a stable `data-*` attribute or
 * the database, never rendered copy.
 */
import AxeBuilder from "@axe-core/playwright";
import { hash } from "@node-rs/argon2";
import type { Page } from "@playwright/test";
import pg from "pg";

import { expect, test } from "./setup/test";

const PASSWORD = "Handover!Journey-2042";

function connect(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[handover-e2e] DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url });
}

/** WCAG 2.1 AA on the screen as it stands. */
async function expectNoAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

function names(project: string) {
  const slug = project
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 12);
  return {
    guardian: `e2e-hg-${slug}`,
    claimant: `e2e-hc-${slug}`,
  };
}

/**
 * A Guardian with a password, signed in through the real login route, then
 * given a second factor and a session that has just proved it — the state
 * `requireFreshMfa` needs and the only state in which a handover can be made.
 */
async function seedGuardian(
  pool: pg.Pool,
  username: string,
  claimant: string,
): Promise<void> {
  // Whatever a previous run left: the claimed account (no longer a managed
  // profile, so it does not cascade with the guardian) and the guardian.
  await pool.query(`DELETE FROM users WHERE username = $1 OR email = $2`, [
    claimant,
    `${claimant}@healthlog.test`,
  ]);
  await pool.query(
    `DELETE FROM users WHERE managed_profile_at IS NOT NULL AND id IN (
       SELECT g.grantor_id FROM account_grants g JOIN users u ON u.id = g.grantee_id
       WHERE u.username = $1)`,
    [username],
  );
  await pool.query(`DELETE FROM users WHERE username = $1`, [username]);
  const passwordHash = await hash(PASSWORD, {
    memoryCost: 19456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
  await pool.query(
    `INSERT INTO users
       (id, username, email, password_hash, role, created_at, updated_at,
        onboarding_completed_at, onboarding_tour_completed,
        disclaimer_acknowledged_at, disclaimer_acknowledged_version)
     VALUES ($1, $2, $3, $4, 'USER', NOW(), NOW(), NOW(), true, NOW(), '1')`,
    [
      `c${Date.now().toString(36)}${username}`,
      username,
      `${username}@healthlog.test`,
      passwordHash,
    ],
  );
  // The claim and login buckets for this address, so a local re-run inside the
  // window meets the product rather than its rate limit.
  await pool.query(
    `DELETE FROM rate_limits WHERE key LIKE 'auth:claim%' OR key LIKE 'managed-profile:%'`,
  );
}

async function stampSecondFactor(pool: pg.Pool, username: string) {
  await pool.query(
    `UPDATE users SET totp_confirmed_at = NOW() WHERE username = $1`,
    [username],
  );
  await pool.query(
    `UPDATE sessions SET mfa_verified_at = NOW()
     WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
    [username],
  );
}

test.describe("managed profile handover", () => {
  test("guardian hands over, the person claims and decides", async ({
    page,
    browser,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const { guardian, claimant } = names(testInfo.project.name);
    const pool = connect();
    try {
      await seedGuardian(pool, guardian, claimant);

      // ── The Guardian ─────────────────────────────────────────────────
      const login = await page.request.post("/api/auth/login", {
        data: { email: guardian, password: PASSWORD },
      });
      expect(login.status()).toBe(200);
      await stampSecondFactor(pool, guardian);

      const created = await page.request.post("/api/managed-profiles", {
        data: {
          displayName: "Robin",
          dateOfBirth: "2012-03-04",
          locale: "en",
          timezone: "Europe/Berlin",
          gender: null,
        },
      });
      expect(created.status()).toBe(201);
      const profileId = ((await created.json()) as { data: { id: string } })
        .data.id;

      await page.goto("/settings/access");
      const row = page.locator(
        `[data-slot="managed-profile-row"][data-managed-profile-id="${profileId}"]`,
      );
      await expect(row).toBeVisible();
      await row
        .locator('[data-slot="managed-profile-handover-toggle"]')
        .click();

      const form = row.locator('[data-slot="managed-profile-handover-form"]');
      await expect(form).toBeVisible();
      // Born 2012: the minor hint is shown, the choice stays the Guardian's.
      await expect(
        row.locator('[data-slot="managed-profile-handover-minor"]'),
      ).toBeVisible();
      // The Guardian proposes to keep managing.
      await form
        .locator('[data-slot="managed-profile-handover-proposal"]')
        .first()
        .selectOption("manage");
      await form
        .locator('[data-slot="managed-profile-handover-create"]')
        .click();

      const linkPanel = row.locator(
        '[data-slot="managed-profile-handover-link"]',
      );
      await expect(linkPanel).toBeVisible();
      await expect(
        row.locator('[data-slot="managed-profile-handover-qr"]'),
      ).toBeVisible();
      const url = await linkPanel.getAttribute("data-handover-url");
      expect(url).toMatch(/\/claim\/hlp_[0-9a-f]{64}$/);
      await expectNoAxeViolations(page);

      // ── The person, on a browser that never signed in ────────────────
      const person = await browser.newContext({ baseURL });
      try {
        const claimPage = await person.newPage();
        const path = new URL(url as string).pathname;
        await claimPage.goto(path);
        await expect(claimPage).toHaveURL(/\/auth\/claim\?token=hlp_/);
        await expect(
          claimPage.locator('[data-testid="claim-form-card"]'),
        ).toBeVisible();
        await expect(
          claimPage.locator(
            '[data-slot="claim-guardian"][data-proposal="manage"]',
          ),
        ).toHaveCount(1);

        await expectNoAxeViolations(claimPage);
        await claimPage.locator("#claim-username").fill(claimant);
        await claimPage
          .locator("#claim-email")
          .fill(`${claimant}@healthlog.test`);
        await claimPage.locator("#claim-password").fill(PASSWORD);
        await claimPage.locator('[data-slot="claim-submit"]').click();

        await expect(claimPage).toHaveURL(/\/onboarding\/handover$/, {
          timeout: 30_000,
        });
        const decision = claimPage.locator(
          '[data-slot="handover-decision-guardian"][data-decidable="true"]',
        );
        await expect(decision).toHaveCount(1);
        await expect(
          claimPage.locator('[data-slot="handover-notification-hint"]'),
        ).toBeVisible();
        await expectNoAxeViolations(claimPage);
        // The person decides: view only, not managing.
        await decision
          .locator('[data-slot="handover-decision-choice"]')
          .selectOption("read");
        await claimPage
          .locator('[data-slot="handover-decision-submit"]')
          .click();
        await expect(claimPage).toHaveURL(/\/onboarding(\?|$)/, {
          timeout: 30_000,
        });

        // The used link is dead for anyone after.
        const reused = await person.request.post("/api/auth/claim/preview", {
          data: { token: (url as string).split("/claim/")[1] },
        });
        // A signed-in browser is refused before the token is read; a fresh one
        // would get the uniform 404. Either way, nothing is handed over twice.
        expect([404, 409]).toContain(reused.status());
      } finally {
        await person.close();
      }

      // ── What the database says ───────────────────────────────────────
      const account = await pool.query(
        `SELECT managed_profile_at, username, email, password_hash IS NOT NULL AS has_password
         FROM users WHERE id = $1`,
        [profileId],
      );
      expect(account.rows[0]).toMatchObject({
        managed_profile_at: null,
        username: claimant,
        has_password: true,
      });
      const live = await pool.query(
        `SELECT g.access FROM account_grants g JOIN users u ON u.id = g.grantee_id
         WHERE g.grantor_id = $1 AND u.username = $2 AND g.revoked_at IS NULL`,
        [profileId, guardian],
      );
      expect(live.rows).toEqual([{ access: "READ" }]);
    } finally {
      await pool.end();
    }
  });
});
