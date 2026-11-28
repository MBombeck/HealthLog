/**
 * 1.50 — the first-admin server setup, walked by an admin of the shared e2e
 * instance: the second factor, sign-ups, the push relay, AI and the
 * recovery kit, each one decision on a focus page. Later and Not now write
 * nothing but the step; the setup is stamped once every step is settled,
 * and Admin › Setup shows each row's value.
 *
 * The admin's settings are put back afterwards, so the other journeys keep
 * the instance they expect. Everything addresses stable `data-*`
 * attributes, never viewport text.
 */
import pg from "pg";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";
import { expectScreen, readSetup, SHELL } from "./setup-flow-helpers";

async function resetServerSetup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `UPDATE app_settings
          SET server_setup_completed_at = NULL,
              server_setup_steps_json = NULL,
              registration_enabled = true
        WHERE id = 'singleton'`,
    );
    await pool.query(
      `UPDATE users
          SET admin_notices_dismissed =
                array_remove(admin_notices_dismissed, 'server_setup_available')`,
    );
  } finally {
    await pool.end();
  }
}

test.describe("server setup — the first admin", () => {
  test.use({ storageState: STORAGE_STATE_PATH });
  test.describe.configure({ mode: "serial" });

  test.beforeEach(resetServerSetup);
  test.afterEach(resetServerSetup);

  test("walks the five steps and stamps the setup", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/onboarding/server");
    await expectScreen(page, "account-mfa");
    await expect(page.locator('[data-slot="stepper"]')).toHaveAttribute(
      "data-count",
      "5",
    );
    // Later is an answer; nothing is enrolled.
    await page.locator('[data-slot="onboarding-skip"]').click();

    await expectScreen(page, "signups");
    await page
      .locator('[data-slot="onboarding-choice"][data-value="invited"] label')
      .click();
    await page.locator('[data-slot="onboarding-next"]').click();

    // The relay step passes itself on a server whose relay cannot be used.
    await page.waitForURL(/\/onboarding\/server\/(relay|ai)$/, {
      timeout: 15_000,
    });
    if (page.url().endsWith("/relay")) {
      await expectScreen(page, "relay");
      await expect(
        page.locator('[data-slot="onboarding-next"]'),
      ).toBeDisabled();
      await page
        .locator('[data-slot="onboarding-choice"][data-value="yes"] label')
        .click();
      // Yes opens the relay's own confirmations inside the row.
      await expect(
        page.locator('[data-slot="onboarding-choice-body"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="onboarding-next"]'),
      ).toBeDisabled();
      await page.locator('[data-slot="onboarding-skip"]').click();
    }

    await expectScreen(page, "ai");
    await page.locator('[data-slot="onboarding-skip"]').click();

    await expectScreen(page, "recovery");
    await expect(page.locator('[data-slot="onboarding-next"]')).toBeDisabled();
    await page.locator('[data-slot="onboarding-skip"]').click();

    // Every step settled: the setup is stamped and the owner goes on.
    await expect(page).not.toHaveURL(/\/onboarding\/server/, {
      timeout: 15_000,
    });
    const state = await page.evaluate(async () => {
      const res = await fetch("/api/admin/server-setup");
      return (await res.json()).data as {
        completedAt: string | null;
        steps: Array<{ id: string; status: string; at?: string }>;
      };
    });
    expect(state.completedAt).not.toBeNull();
    const byId = Object.fromEntries(state.steps.map((s) => [s.id, s]));
    expect(byId["account-mfa"].status).toBe("skipped");
    expect(byId["account-mfa"].at).toBeTruthy();
    expect(byId.signups.status).toBe("done");
    expect(byId.recovery.status).toBe("skipped");

    // Admin › Setup shows each decision's value; sign-ups reads invited.
    const setup = await readSetup(page);
    expect(setup.instance).not.toBeNull();
    expect(
      setup.instance?.tasks.find((task) => task.id === "signups")?.value,
    ).toBe("invited");
    await page.goto("/admin/setup");
    await expect(page.locator('[data-slot="admin-setup"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="setup-task"][data-task="signups"]'),
    ).toHaveAttribute("data-status", "done");
  });

  test("finish later sets the setup aside and keeps it resumable", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto("/onboarding/server/signups");
    await expectScreen(page, "signups");
    await page.locator('[data-slot="onboarding-finish-later"]').click();
    await expect(page).not.toHaveURL(/\/onboarding\/server/, {
      timeout: 15_000,
    });
    // Set aside, not finished: Admin › Setup still offers the rest.
    const setup = await readSetup(page);
    expect(setup.instance?.status).toBe("pending");
    await page.goto("/admin/setup");
    await page.locator('a[href="/onboarding/server"]').click();
    await expect(page.locator(SHELL)).toHaveAttribute("data-flow", "server", {
      timeout: 15_000,
    });
  });
});
