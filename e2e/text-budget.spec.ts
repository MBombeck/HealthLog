import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import budgets from "./text-budgets.json";

/**
 * Text budgets: the visible words per page on a phone, against the ceilings
 * in `text-budgets.json`.
 *
 * The rule for a surface is a heading plus at most one sentence; setup steps,
 * forms and long explanations sit behind the card's own "Set up", "Import" or
 * "Learn more" disclosure. A page that grew past its budget grew text a person
 * has to read before they reach what they came for, so the ceiling fails the
 * run. Raise a number only in a reviewed change that says why the words are
 * needed; lower it when a page gets shorter.
 *
 * Counted the way a reader meets the page: `innerText` of `<main>`, which
 * leaves out closed disclosures, with a native `<select>` counted as its
 * chosen option rather than every option it holds.
 *
 * Mobile only: 390-ish CSS px is where words cost the most.
 */
const PAGES = Object.entries(budgets.pages) as Array<[string, number]>;

test.describe("text budgets on a phone", () => {
  // Folds stay closed here: the count is the page as a reader first meets it.
  test.use({ storageState: STORAGE_STATE_PATH, openFolds: false });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("covers the pages it was written for", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(11);
  });

  for (const [path, budget] of PAGES) {
    test(`${path} stays within ${budget} words`, async ({ page }) => {
      await page.goto(path);
      const main = page.locator("main");
      await expect(main).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, {
        timeout: 30_000,
      });
      const words = await main.evaluate((root) => {
        const count = (text: string) =>
          text.trim() ? text.trim().split(/\s+/).length : 0;
        let selects = 0;
        for (const select of root.querySelectorAll("select")) {
          selects +=
            count(select.innerText) -
            count(select.selectedOptions[0]?.text ?? "");
        }
        return count((root as HTMLElement).innerText) - selects;
      });
      // A page that rendered nothing would pass any ceiling.
      expect(words, `${path} rendered no text`).toBeGreaterThan(10);
      expect(
        words,
        `${path}: ${words} words, budget ${budget}`,
      ).toBeLessThanOrEqual(budget);
    });
  }
});
