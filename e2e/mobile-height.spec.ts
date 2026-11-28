import { expect, test } from "./setup/test";

import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";
import budgets from "./mobile-height-budgets.json";

/**
 * Page heights on a phone, against the ceilings in
 * `mobile-height-budgets.json`.
 *
 * Nothing may be too long on a phone: a list of cards where rows would do, a
 * paragraph under every heading, a form opened above the content. Each grows
 * a page a few hundred pixels at a time, and no single review notices. The
 * ceiling notices: a page taller than its budget fails the run.
 *
 * Measured the way a phone scrolls the page: the app shell scrolls inside
 * `<main>`, so the height is the larger of `main.scrollHeight` and
 * `document.scrollingElement.scrollHeight` (a page outside the shell), at
 * phone width, closed disclosures left closed, the seeded e2e record.
 * A ceiling moves one way. Lower it when a page gets shorter (the
 * check below fails once a page sits far under its budget, so a shorter page
 * has to be written down); raise one only in a reviewed change that says why.
 * `target` is where the page is meant to arrive (the 1.50 sub-page audit).
 *
 * Mobile only, like the text budgets.
 */
type Budget = { budget: number; target: number };
const PAGES = Object.entries(budgets.pages) as Array<[string, Budget]>;
/** A page this far under its budget has shrunk; write the lower number down. */
const SLACK = 0.15;

test.describe("page heights on a phone", () => {
  // The account `mobile-route-overflow.spec.ts` measures: one or two of
  // everything a route can render, so no list is measured empty.
  test.use({
    storageState: MOBILE_ROUTES_STORAGE_STATE_PATH,
    openFolds: false,
  });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("covers the pages it was written for", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(30);
    for (const [path, { budget, target }] of PAGES) {
      expect(target, `${path}: target above budget`).toBeLessThanOrEqual(
        budget,
      );
    }
  });

  for (const [path, { budget }] of PAGES) {
    test(`${path} stays within ${budget} px`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, {
        timeout: 30_000,
      });
      await page.evaluate(() => document.fonts.ready);
      const height = await page.evaluate(() =>
        Math.max(
          document.scrollingElement?.scrollHeight ?? 0,
          document.querySelector("main")?.scrollHeight ?? 0,
        ),
      );
      // A redirect to the sign-in page would pass any ceiling.
      expect(new URL(page.url()).pathname, "redirected").not.toMatch(
        /^\/auth\//,
      );
      expect(
        height,
        `${path}: ${height} px, budget ${budget}`,
      ).toBeLessThanOrEqual(budget);
      expect(
        height,
        `${path}: ${height} px is far under its budget of ${budget}; lower the budget`,
      ).toBeGreaterThanOrEqual(Math.floor(budget * (1 - SLACK)));
    });
  }
});
