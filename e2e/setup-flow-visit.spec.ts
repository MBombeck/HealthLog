/**
 * v1.39 (C2) — the setup flow, path 3: a doctor's visit within a month, with
 * lab results.
 *
 * The visit answer is what switches the doctor report on and puts "prepare
 * the visit" on the checklist; the labs area has no inline form, so the
 * first-result screen points at the labs page and takes the person's word
 * that the first entry was made.
 */
import {
  E2E_SETUP_VISIT,
  SETUP_VISIT_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  acceptAndSetUp,
  choose,
  expectScreen,
  next,
  readMe,
} from "./setup-flow-helpers";

test.describe("setup flow — a visit within a month, with labs", () => {
  test.use({ storageState: SETUP_VISIT_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await resetSetupFlow(E2E_SETUP_VISIT.username);
  });

  test("switches the report on and puts the visit on the checklist", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await page.goto("/onboarding");
    await acceptAndSetUp(page);

    await choose(page, "who", ["me"]);
    await next(page);
    await expectScreen(page, "areas");
    await choose(page, "areas", ["labs"]);
    await next(page);
    await expectScreen(page, "medication");
    await choose(page, "medication", ["no"]);
    await next(page);
    await expectScreen(page, "sources");
    await choose(page, "sources", ["file"]);
    await next(page);
    await expectScreen(page, "visit");
    await choose(page, "visit", ["within-a-month"]);
    await next(page);

    await expectScreen(page, "confirm");
    await next(page);

    await expectScreen(page, "first-result");
    const screen = page.locator("section[data-task]");
    await expect(screen).toHaveAttribute("data-task", "log-reading");
    await expect(screen).toHaveAttribute("data-target", "labs");
    await expect(
      page.locator('[data-slot="onboarding-task-reading-link"]'),
    ).toBeVisible();
    await page.locator('[data-slot="onboarding-reading-done"]').click();
    await expect(
      page.locator('[data-slot="onboarding-first-result-done"]'),
    ).toBeVisible();
    await next(page);

    await expectScreen(page, "done");
    await page.locator('[data-slot="onboarding-open-dashboard"]').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");

    // The checklist opens with the visit row on it.
    const checklist = page.locator('[data-testid="onboarding-card"]');
    await expect(checklist).toBeVisible({ timeout: 15_000 });
    await expect(checklist.locator("#getting-started-body")).toBeVisible();
    await expect(checklist.locator('a[href="/checkups"]')).toBeVisible();

    const me = await readMe(page);
    expect(me.modules.labs).not.toBe(false);
    expect(me.modules.doctorReport).not.toBe(false);
    expect(me.modules.medications).toBe(false);
    expect(me.onboarding.firstResult?.task).toBe("log-reading");
    expect(me.onboarding.firstResult?.completedAt).not.toBeNull();
  });
});
