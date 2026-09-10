/**
 * v1.39 (C2) — the setup flow, path 2: a daily medication with a reminder.
 *
 * Q3 "yes" is the one answer that makes the first medication the task the
 * flow ends on, ahead of a reading; every other question is passed, which is
 * the spec's own claim that only Q1 is required. The medication wizard runs
 * inline on the first-result screen, and the result stays on that screen
 * rather than landing on the medication's page.
 */
import {
  E2E_SETUP_MEDICATION,
  SETUP_MEDICATION_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  clickNext,
  clickSave,
  expectStep,
  fillStep1Name,
  fillStep3Dose,
  pickCadenceRow,
  pickTreatmentRow,
} from "./medications-wizard-helpers";
import {
  acceptAndSetUp,
  choose,
  expectScreen,
  next,
  readMe,
  readTileOrder,
  skip,
} from "./setup-flow-helpers";

test.describe("setup flow — a daily medication with a reminder", () => {
  test.use({ storageState: SETUP_MEDICATION_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await resetSetupFlow(E2E_SETUP_MEDICATION.username);
  });

  test("ends on the first medication, added inline", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/onboarding");
    await acceptAndSetUp(page);

    await choose(page, "who", ["me"]);
    await next(page);
    await expectScreen(page, "areas");
    await skip(page);

    await expectScreen(page, "medication");
    await choose(page, "medication", ["yes"]);
    await next(page);

    await expectScreen(page, "sources");
    await skip(page);
    await expectScreen(page, "visit");
    await skip(page);

    // No unit-bearing area was ticked, so Q6 is not in this flow.
    await expectScreen(page, "confirm");
    await next(page);

    await expectScreen(page, "first-result");
    await expect(page.locator("section[data-task]")).toHaveAttribute(
      "data-task",
      "add-medication",
    );
    await page.locator('[data-slot="onboarding-add-medication"]').click();
    await expect(
      page.locator('[data-slot="medication-wizard-dialog"]'),
    ).toBeVisible({ timeout: 10_000 });

    await fillStep1Name(page, { name: "Setup journey tablet" });
    await clickNext(page);
    await expectStep(page, 2);
    await pickTreatmentRow(page, "other");
    await clickNext(page);
    await expectStep(page, 3);
    await fillStep3Dose(page, { amount: "500" });
    await clickNext(page);
    await expectStep(page, 4);
    await clickNext(page);
    await expectStep(page, 5, 8);
    await pickCadenceRow(page, "daily");
    await expectStep(page, 5, 7);
    await clickNext(page);
    // Times of day arrive with 08:00 already on the plan — one dose a day.
    await expectStep(page, 6, 7);
    await clickNext(page);
    await expectStep(page, 7, 7);
    await clickSave(page);

    // The result stays here: the wizard does not navigate away.
    await expect(
      page.locator('[data-slot="onboarding-first-result-done"]'),
    ).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/onboarding/first-result");
    await next(page);

    await expectScreen(page, "done");
    await page.locator('[data-slot="onboarding-open-dashboard"]').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
    await expect(page.locator('[data-testid="onboarding-card"]')).toBeVisible({
      timeout: 15_000,
    });

    const me = await readMe(page);
    expect(me.modules.medications).not.toBe(false);
    expect(me.modules.glucose).toBe(false);
    expect(me.onboarding.firstResult?.task).toBe("add-medication");
    expect(me.onboarding.firstResult?.completedAt).not.toBeNull();

    // The medication tile leads the dashboard.
    const order = await readTileOrder(page);
    expect(order[0]).toBe("medications");

    const meds = await page.request.get("/api/medications");
    const { data } = (await meds.json()) as { data: Array<{ name: string }> };
    expect(data.map((m) => m.name)).toContain("Setup journey tablet");
  });
});
