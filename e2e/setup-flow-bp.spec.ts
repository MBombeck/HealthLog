/**
 * 1.50 — the person setup for one's own record, walked in a browser.
 *
 * Who (with the disclaimer), the areas, the basics, the sources, the
 * reminders and, while the server offers the Coach, the AI question; then
 * the dashboard with its setup card. "Finish later" ends the redirect and the
 * card's first row leads back to where the flow stopped. Everything
 * addresses stable `data-*` attributes, never viewport text.
 */
import {
  E2E_SETUP_BP,
  SETUP_BP_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  acknowledge,
  choose,
  expectScreen,
  next,
  readMe,
  readSetup,
  skip,
  SHELL,
} from "./setup-flow-helpers";

test.describe.configure({ mode: "serial" });

test.describe("setup flow — one's own record", () => {
  test.use({ storageState: SETUP_BP_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await resetSetupFlow(E2E_SETUP_BP.username);
  });

  test("walks every screen to the dashboard and its setup card", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto("/");
    await expectScreen(page, "who");
    // Nothing is chosen up front, and Continue waits for the disclaimer too.
    await expect(page.locator('[data-slot="onboarding-next"]')).toBeDisabled();
    await choose(page, "who", ["me"]);
    await expect(page.locator('[data-slot="onboarding-next"]')).toBeDisabled();
    await acknowledge(page);
    await next(page);

    await expectScreen(page, "areas");
    // The stepper's count is pinned from here on.
    const count = await page
      .locator('[data-slot="stepper"]')
      .getAttribute("data-count");
    await choose(page, "areas", ["blood-pressure", "weight-body"]);
    await next(page);

    await expectScreen(page, "units");
    await expect(page.locator('[data-slot="stepper"]')).toHaveAttribute(
      "data-count",
      count ?? "",
    );
    await page.locator("#onboarding-display-name").fill("Setup BP");
    await next(page);

    await expectScreen(page, "sources");
    await skip(page);

    await expectScreen(page, "reminders");
    await skip(page);

    // The Coach is offered only with a provider that can serve it; without
    // one the flow ends on the reminders.
    await page.waitForURL(/\/onboarding\/ai$|\/$/, { timeout: 15_000 });
    if (page.url().endsWith("/onboarding/ai")) {
      await page.locator('[data-slot="onboarding-ai-no"]').click();
    }

    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.locator(SHELL)).toHaveCount(0);

    const me = await readMe(page);
    expect(me.onboarding.completedAt).not.toBeNull();
    expect(me.modules["blood-pressure"] ?? true).toBe(true);

    const setup = await readSetup(page);
    expect(setup.person.status).toBe("done");
    expect(setup.person.planned).toBe(true);
    expect(setup.person.cardShown).toBe(true);
    await expect(page.locator('[data-slot="setup-card"]')).toBeVisible();

    // "Hide this card" holds on the server.
    await page.locator('[data-slot="setup-card-hide"]').click();
    await expect(page.locator('[data-slot="setup-card"]')).toHaveCount(0);
    expect((await readSetup(page)).person.cardDismissed).toBe(true);
  });

  test("finishes later and resumes where it stopped", async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto("/onboarding");
    await expectScreen(page, "who");
    await choose(page, "who", ["me"]);
    await acknowledge(page);
    await next(page);
    await expectScreen(page, "areas");
    await choose(page, "areas", ["sleep"]);
    await next(page);
    await expectScreen(page, "units");

    await page.locator('[data-slot="onboarding-finish-later"]').click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

    const setup = await readSetup(page);
    expect(setup.person.status).toBe("pending");
    expect(setup.person.currentStep).toBe("units");
    await expect(
      page.locator('[data-slot="setup-task"][data-task="resume"]'),
    ).toBeVisible();

    // A reload or a second device lands on the same screen.
    await page.goto("/onboarding");
    await expectScreen(page, "units");
    // A deep link past it bounces back.
    await page.goto("/onboarding/reminders");
    await expectScreen(page, "units");
  });
});
