import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  expectNoHorizontalOverflow,
  settleForOverflowMeasurement,
} from "./utils/horizontal-overflow";

/**
 * The labs list under its categories.
 *
 * The account is the one `globalSetup` seeds for the mobile route sweep: one
 * marker under its own panel and one qualitative reading without a panel, so
 * the server answers two categories and `grouped: true`. The grouping choice
 * is served to this page only (the layout read is answered in the browser
 * with the account's own layout plus `groupBy: "category"`), so the shared
 * account's stored preferences stay as other specs expect them.
 */

const LAYOUT = "**/api/settings/module-list-layout";
const GROUP = '[data-slot="lab-list-group"]';

async function serveGrouped(page: Page, groupsOpen = "expanded") {
  await page.route(LAYOUT, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as {
      data: { lists: { labs: Record<string, unknown> } };
    };
    body.data.lists.labs = {
      ...body.data.lists.labs,
      groupBy: "category",
      groupsOpen,
      saved: true,
    };
    await route.fulfill({ response, json: body });
  });
}

test.describe("the lab list under its categories", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test.beforeEach(async ({ context }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "de", url: baseURL },
    ]);
  });

  test("shows one disclosure per category and folds a category away", async ({
    page,
  }) => {
    await serveGrouped(page);
    await page.goto("/labs", { waitUntil: "domcontentloaded" });
    const headers = page.locator(GROUP);
    await expect(headers).toHaveCount(2);
    await expect(headers.first()).toHaveAttribute("aria-expanded", "true");

    const names = page.locator('[data-slot="lab-list-analyte"]');
    const before = await names.count();
    expect(before).toBeGreaterThan(1);

    await headers.first().click();
    await expect(headers.first()).toHaveAttribute("aria-expanded", "false");
    await expect(names).toHaveCount(before - 1);

    // The choice holds across a reload in this browser.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(GROUP).first()).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("starts with every category closed when the person chose so", async ({
    page,
  }) => {
    await serveGrouped(page, "collapsed");
    await page.goto("/labs", { waitUntil: "domcontentloaded" });
    const headers = page.locator(GROUP);
    await expect(headers).toHaveCount(2);
    for (const header of await headers.all()) {
      await expect(header).toHaveAttribute("aria-expanded", "false");
    }
    await expect(page.locator('[data-slot="lab-list-analyte"]')).toHaveCount(0);
  });

  test("fits a phone and passes axe", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveGrouped(page);
    await page.goto("/labs", { waitUntil: "domcontentloaded" });
    await expect(page.locator(GROUP)).toHaveCount(2);
    await settleForOverflowMeasurement(page);
    await expectNoHorizontalOverflow(page, "/labs grouped at 390 px");

    const results = await new AxeBuilder({ page })
      .include('[data-slot="lab-list"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
