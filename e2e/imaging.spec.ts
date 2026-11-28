/**
 * Imaging exams (#1672), end to end, through stable `data-slot` attributes.
 *
 *   1. Record — the sheet saves an exam and its row reads back on the page.
 *   2. Edit and delete — the row opens its sheet; delete behind "⋯" removes it.
 *   3. Module off — the nav entry goes and a direct visit shows the notice.
 *   4. a11y — axe over the list and the open sheet, serious/critical only.
 *
 * Single-account and serial, like the vaccinations spec: the reset would race
 * a sibling worker.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";
import { ensureImagingModuleOn, resetImaging } from "./setup/imaging-fixture";

test.beforeEach(async () => {
  await resetImaging();
  await ensureImagingModuleOn();
});

test.describe.configure({ mode: "serial" });

async function seedExam(page: Page): Promise<string> {
  // Written from the page so the browser's own connection carries the POST.
  const id = await page.evaluate(async () => {
    const res = await fetch("/api/imaging", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modality: "MRI",
        performedAt: "2026-05-14T00:00:00.000Z",
        side: "LEFT",
        bodyPart: "Knee",
        facility: "Radiology",
        conclusion: "Small meniscus tear",
      }),
    });
    return res.status === 201
      ? ((await res.json()) as { data: { id: string } }).data.id
      : null;
  });
  expect(id, "the exam was written").toBeTruthy();
  return id!;
}

async function expectNoSeriousAxe(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(blocking.map((v) => v.id)).toEqual([]);
}

test.describe("imaging exams", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("an exam recorded in the sheet reads back as a row", async ({
    page,
  }) => {
    await page.goto("/imaging");
    const add = page.locator(
      '[data-slot="list-group-add"] [data-slot="list-item-action"]',
    );
    await expect(add).toBeVisible({ timeout: 15_000 });
    await add.click();

    await page.locator('[data-slot="imaging-modality"]').click();
    await page.getByRole("option").nth(1).click();
    await page.locator("#imaging-body-part").fill("Lumbar spine");
    await page.locator("#imaging-conclusion").fill("No disc herniation");
    const save = page.locator('[data-slot="imaging-save"]');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeHidden({ timeout: 15_000 });

    await expect(page.locator('[data-slot="imaging-row"]')).toHaveCount(1, {
      timeout: 15_000,
    });
  });

  test("a row opens its sheet and delete removes the exam", async ({
    page,
  }) => {
    await page.goto("/imaging");
    const id = await seedExam(page);
    await page.reload();
    const row = page.locator(`[data-exam-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('[data-slot="list-item-action"]').click();
    await expect(page.locator("#imaging-conclusion")).toHaveValue(
      "Small meniscus tear",
    );
    await page.locator('[data-slot="imaging-more"]').click();
    await page.getByRole("menuitem").first().click();
    await page.locator('[data-slot="imaging-delete-confirm"]').click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-slot="list-group-add"]')).toBeVisible();
  });

  test("turning the module off drops the nav entry and the direct visit shows the notice", async ({
    page,
  }) => {
    await page.goto("/settings/modules");
    const toggle = page.locator("#module-toggle-imaging");
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('[data-tour-id="nav-imaging"]')).toHaveCount(0);

    await page.goto("/imaging");
    await expect(
      page.locator('[data-slot="module-off-open-settings"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-slot="imaging-page"]')).toHaveCount(0);
  });

  test("the list and the sheet carry no serious accessibility violations", async ({
    page,
  }) => {
    await page.goto("/imaging");
    await seedExam(page);
    await page.reload();
    await expect(page.locator('[data-slot="imaging-row"]')).toHaveCount(1, {
      timeout: 15_000,
    });
    await expectNoSeriousAxe(page);
    await page
      .locator('[data-slot="imaging-row"] [data-slot="list-item-action"]')
      .click();
    await expect(page.locator('[data-slot="imaging-form"]')).toBeVisible();
    await expectNoSeriousAxe(page);
  });
});
