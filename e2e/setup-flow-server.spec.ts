/**
 * 1.49 — the first-admin server setup, and the person flow's new steps.
 *
 * Everything addresses stable `data-*` attributes, never viewport text.
 *
 *  1. An admin walks the five server setup steps, skipping some and
 *     continuing others; the last one shows the setup check and finishing
 *     stamps the setup. The state is put back afterwards, so the notice and
 *     the line keep showing for the other journeys.
 *  2. A person with a medication schedule meets "Region & units" with the
 *     registry and no unit question, the reminders follow-up, and the Coach
 *     step; "No" switches the Coach off, and Back still reaches the step.
 */
import pg from "pg";

import {
  E2E_SETUP_FOLLOWUPS,
  SETUP_FOLLOWUPS_STORAGE_STATE_PATH,
  STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  acceptAndSetUp,
  choose,
  expectScreen,
  next,
  readMe,
  skip,
  SHELL,
} from "./setup-flow-helpers";

async function resetServerSetup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `UPDATE app_settings
          SET server_setup_completed_at = NULL,
              server_setup_steps_json = NULL
        WHERE id = 'singleton'`,
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

  test("walks the five steps and finishes on the setup check", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // The admin start page offers it.
    await page.goto("/admin");
    await page.locator('[data-slot="server-setup-notice-open"]').click();

    for (const [step, action] of [
      ["accounts", "next"],
      ["notifications", "skip"],
      ["ai", "skip"],
      ["privacy", "next"],
    ] as const) {
      await expect(page.locator(SHELL)).toHaveAttribute("data-flow", "server");
      await expectScreen(page, step);
      await expect(
        page.locator(`[data-slot="server-setup-step"][data-step="${step}"]`),
      ).toBeVisible();
      if (action === "next") await next(page);
      else await skip(page);
    }

    await expectScreen(page, "health");
    const card = page.locator('[data-testid="setup-health-card"]');
    await expect(card).toBeVisible();
    await expect(
      card.locator('[data-testid="setup-health-encryption_keys"]'),
    ).toHaveAttribute("data-state", "ok");
    await expect(
      page.locator('[data-testid="setup-health-state"]'),
    ).toHaveAttribute("data-state", /ok|attention|failing/);
    await next(page);
    await expect
      .poll(() => new URL(page.url()).pathname)
      .not.toContain("/onboarding/server");

    const state = await page.evaluate(async () => {
      const res = await fetch("/api/admin/server-setup");
      return (await res.json()).data as {
        completedAt: string | null;
        steps: Array<{ id: string; status: string }>;
      };
    });
    expect(state.completedAt).not.toBeNull();
    expect(
      Object.fromEntries(state.steps.map((s) => [s.id, s.status])),
    ).toEqual({
      accounts: "done",
      notifications: "skipped",
      ai: "skipped",
      privacy: "done",
      health: "done",
    });

    // Finished, the notice is gone and the setup check stays on System status.
    await page.goto("/admin");
    await expect(page.locator('[data-slot="server-setup-notice"]')).toHaveCount(
      0,
    );
    await page.goto("/admin/system-status");
    await expect(
      page.locator('[data-testid="setup-health-card"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="setup-health-open-setup"]'),
    ).toBeVisible();
  });
});

test.describe("setup flow — Region & units, reminders and the Coach", () => {
  test.use({ storageState: SETUP_FOLLOWUPS_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await resetSetupFlow(E2E_SETUP_FOLLOWUPS.username);
  });

  test("asks only what concerns a schedule, and No keeps its place", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/onboarding");
    await acceptAndSetUp(page);

    await choose(page, "who", ["me"]);
    await next(page);
    await expectScreen(page, "areas");
    await choose(page, "areas", ["sleep"]);
    await next(page);
    await expectScreen(page, "medication");
    await choose(page, "medication", ["yes"]);
    await next(page);
    await expectScreen(page, "sources");
    await skip(page);
    await expectScreen(page, "visit");
    await skip(page);

    await expectScreen(page, "units");
    await expect(
      page.locator('[data-slot="onboarding-question-timezone"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="onboarding-question-medicine-registry"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="onboarding-question-unit-preference"]'),
    ).toHaveCount(0);
    await page.locator("#onboarding-medicine-registry").selectOption("PL");
    await next(page);

    await expectScreen(page, "confirm");
    await next(page);

    await expectScreen(page, "reminders");
    await expect(
      page.locator('[data-slot="notification-channels-panel"]'),
    ).toBeVisible();
    await next(page);

    await expectScreen(page, "ai");
    await page
      .locator('[data-slot="onboarding-question-ai"] [data-value="no"]')
      .click();

    await expectScreen(page, "first-result");
    // Back reaches the answered Coach step although the offer is off now.
    await page.locator('[data-slot="onboarding-back"]').click();
    await expectScreen(page, "ai");

    const me = await readMe(page);
    const steps = Object.fromEntries(
      me.onboarding.steps.map((s) => [s.id, s.status]),
    );
    expect(steps.units).toBe("done");
    expect(steps.reminders).toBe("done");
    expect(steps.ai).toBe("done");
    const account = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me");
      return (await res.json()).data as {
        medicineRegistry: string;
        modules: Record<string, boolean>;
      };
    });
    expect(account.medicineRegistry).toBe("PL");
    expect(account.modules.coach).toBe(false);
  });
});
