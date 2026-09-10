/**
 * v1.39 (C2) — the setup flow, path 1: blood pressure and weight, typed in.
 *
 * From the welcome screen to the dashboard on one account of its own: the
 * questions, leaving after Q3 and coming back to Q4, the units question that
 * only appears because weight was ticked, the confirm screen, one blood
 * pressure reading entered inline as the first result, and the dashboard
 * with the checklist open. Then the four things the design spec's definition
 * of done names, read off the API rather than the viewport: the module map,
 * the tile order, the checklist, and the resume.
 *
 * Runs in one project (see `playwright.config.ts`): it resets and mutates its
 * own account.
 */
import {
  E2E_SETUP_BP,
  SETUP_BP_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  acceptAndSetUp,
  choose,
  expectScreen,
  next,
  readMe,
  readTileOrder,
} from "./setup-flow-helpers";

test.describe("setup flow — blood pressure and weight, typed in", () => {
  test.use({ storageState: SETUP_BP_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await resetSetupFlow(E2E_SETUP_BP.username);
  });

  test("walks from the welcome screen to a first reading on the dashboard", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await page.goto("/onboarding");
    await acceptAndSetUp(page);

    await choose(page, "who", ["me"]);
    await next(page);
    await expectScreen(page, "areas");

    await choose(page, "areas", ["blood-pressure", "weight-body"]);
    await next(page);
    await expectScreen(page, "medication");

    await choose(page, "medication", ["no"]);
    await next(page);
    await expectScreen(page, "sources");

    // Leave after Q3 and come back: the first-run redirect lands on
    // /onboarding, and the front door sends the flow to the step it owes.
    await page.goto("/");
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe("/onboarding/sources");
    await expectScreen(page, "sources");

    await choose(page, "sources", ["manual"]);
    await next(page);
    await expectScreen(page, "visit");

    await choose(page, "visit", ["no"]);
    await next(page);

    // Q6 appears because weight was ticked and the account holds no unit.
    await expectScreen(page, "units");
    await expect(
      page.locator('[data-slot="onboarding-question-unit-preference"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="onboarding-question-glucose-unit"]'),
    ).toHaveCount(0);
    await choose(page, "unit-preference", ["metric"]);
    await next(page);

    await expectScreen(page, "confirm");
    await expect(
      page.locator('[data-slot="onboarding-confirm-modules"]'),
    ).toBeVisible();
    await next(page);

    // The first result: one blood-pressure reading, entered inline.
    await expectScreen(page, "first-result");
    const screen = page.locator("section[data-task]");
    await expect(screen).toHaveAttribute("data-task", "log-reading");
    await expect(screen).toHaveAttribute("data-target", "blood-pressure");
    await page.locator("#sys").fill("124");
    await page.locator("#dia").fill("78");
    await page.locator("#puls").fill("66");
    await page.getByRole("button", { name: /^save$/i }).click();
    const done = page.locator('[data-slot="onboarding-first-result-done"]');
    await expect(done).toBeVisible({ timeout: 15_000 });
    // The reading on its tile, not only a tick: the value that was typed.
    await expect(done).toContainText("124/78", { timeout: 15_000 });
    await next(page);

    await expectScreen(page, "done");
    await page.locator('[data-slot="onboarding-open-dashboard"]').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");

    // The dashboard, with the checklist open.
    const checklist = page.locator('[data-testid="onboarding-card"]');
    await expect(checklist).toBeVisible({ timeout: 15_000 });
    await expect(checklist.locator("#getting-started-body")).toBeVisible();

    // The module map: nothing the answers did not name is on; the always-on
    // trio is.
    const me = await readMe(page);
    for (const key of [
      "glucose",
      "sleep",
      "recovery",
      "mood",
      "mentalHealth",
      "labs",
      "illness",
      "workouts",
      "medications",
      "doctorReport",
      "vaccinations",
    ]) {
      expect(me.modules[key], `module ${key}`).toBe(false);
    }
    for (const key of ["insights", "achievements", "inboundDocuments"]) {
      expect(me.modules[key], `module ${key}`).not.toBe(false);
    }
    expect(me.onboarding.completedAt).not.toBeNull();
    expect(me.onboarding.firstResult?.task).toBe("log-reading");
    expect(me.onboarding.firstResult?.completedAt).not.toBeNull();
    expect(
      me.onboarding.steps.every((step) => step.status !== "pending"),
      "every step settled",
    ).toBe(true);

    // The tile order: the two areas' five tiles lead, in the default
    // layout's own relative order, and everything else sits behind them.
    const order = await readTileOrder(page);
    expect(new Set(order.slice(0, 5))).toEqual(
      new Set(["weight", "bp", "pulse", "bodyFat", "bpInTarget"]),
    );
    expect(order.indexOf("hrv")).toBeGreaterThan(4);
  });
});
