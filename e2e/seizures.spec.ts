/**
 * The seizure diary (#1368), proven end to end.
 *
 * Every assertion is addressed to a stable `data-slot` / `data-*` attribute,
 * never to viewport text: the copy is i18n-driven.
 *
 *   1. Quick log: start, stop, and the seizure is in the list and the count.
 *   2. The timer survives a reload: it stores its start, not a tick.
 *   3. Module off: the direct visit meets the module notice, not the diary.
 *   4. a11y: axe over the diary and the details sheet, serious/critical only.
 *
 * The flows mutate the one seeded account, so this file runs in a single
 * project (see `playwright.config.ts`) and serially, and clears its own rows
 * before each test.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { resetSeizures, setSeizuresModule } from "./setup/seizure-fixture";
import { expect, test } from "./setup/test";

test.beforeEach(async ({ page }) => {
  await resetSeizures();
  await setSeizuresModule(true);
  // The timer lives in the browser; a previous test's start must not carry.
  // An init script runs on every load, the reload under test included, so it
  // clears once per tab: the marker survives a reload, a new test's tab
  // starts without it.
  await page.addInitScript(() => {
    try {
      if (window.sessionStorage.getItem("e2e:seizure-timer-cleared")) return;
      window.sessionStorage.setItem("e2e:seizure-timer-cleared", "1");
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("healthlog:seizure-timer:")) {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      // storage unavailable: nothing to clear
    }
  });
});

// The fixture owns the seeded e2e user's seizures, so the browser signs in
// as that same user.
test.use({ storageState: STORAGE_STATE_PATH });

test.describe.configure({ mode: "serial" });

test.describe("seizure diary", () => {
  test("a timed seizure lands in the list and the count", async ({ page }) => {
    await page.goto("/seizures");
    await page.locator('[data-slot="seizure-start"]').click();
    await expect(page.locator('[data-slot="seizure-stop"]')).toBeVisible();
    await page.locator('[data-slot="seizure-stop"]').click();

    await expect(page.locator('[data-slot="seizure-add-details"]')).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(page.locator("[data-seizure-id]")).toHaveCount(1);
    await expect(page.locator('[data-figure="recorded"] dd')).toHaveText("1");
  });

  test("the running timer survives a reload", async ({ page }) => {
    await page.goto("/seizures");
    await page.locator('[data-slot="seizure-start"]').click();
    await expect(page.locator('[data-slot="seizure-stop"]')).toBeVisible();

    await page.waitForTimeout(1_200);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="seizure-stop"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-slot="seizure-elapsed"]')).not.toHaveText(
      "0:00",
    );
  });

  test("the module switched off closes the page", async ({ page }) => {
    await setSeizuresModule(false);
    await page.goto("/seizures");
    // The shared module gate answers the direct visit with its notice, the
    // way every opt-in module does, and the diary never mounts.
    await expect(
      page.locator(
        '[data-slot="module-disabled-notice"][data-module="seizures"]',
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-slot="seizure-quick-log"]')).toHaveCount(
      0,
    );
  });

  test("the diary and the details sheet carry no serious accessibility violations", async ({
    page,
  }) => {
    await page.goto("/seizures");
    await expect(page.locator('[data-slot="seizure-quick-log"]')).toBeVisible({
      timeout: 15_000,
    });
    await expectNoSeriousAxe(page);

    await page.getByRole("button", { name: /record a seizure/i }).click();
    await expect(
      page.locator('[data-slot="seizure-sheet-save"]'),
    ).toBeVisible();
    await expectNoSeriousAxe(page);
  });
});

async function waitForAnimationsSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => undefined)),
    );
  });
}

/** Fail only on serious/critical WCAG violations, the suite's a11y floor. */
async function expectNoSeriousAxe(page: Page): Promise<void> {
  await waitForAnimationsSettled(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => v.id),
    "serious/critical accessibility violations",
  ).toEqual([]);
}
