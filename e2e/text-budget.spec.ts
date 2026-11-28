import { expect, test } from "./setup/test";

import {
  MOBILE_ROUTES_STORAGE_STATE_PATH,
  STORAGE_STATE_PATH,
} from "./setup/global-setup";
import heights from "./mobile-height-budgets.json";
import budgets from "./text-budgets.json";
import { readPageText } from "./utils/page-text";

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

/**
 * Explainers per route: how many pieces of explanatory
 * text a reader meets, against `explainers` in `text-budgets.json`.
 *
 * An explainer is a visible `[data-slot="hint"]` (the (i) beside a title or
 * a card, the rare inline `Hint` for safety, consent or an operation) or a
 * free paragraph, a muted sentence written by hand. Every route of the
 * height budgets is measured, on the same seeded record; a route not named
 * in the map has a budget of 0.
 *
 * The number is exact, like a ratchet: a route above its budget grew an
 * explanation; a route below it got quieter and writes the lower number
 * down. Raise one only in a reviewed change that names the reason.
 */
const EXPLAINER_ROUTES = Object.keys(heights.pages);
const EXPLAINERS = budgets.explainers as Record<string, number>;

test.describe("explainers per route on a phone", () => {
  test.use({
    storageState: MOBILE_ROUTES_STORAGE_STATE_PATH,
    openFolds: false,
  });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("budgets only routes it measures", () => {
    expect(EXPLAINER_ROUTES.length).toBeGreaterThanOrEqual(30);
    for (const route of Object.keys(EXPLAINERS)) {
      expect(EXPLAINER_ROUTES, `${route} is not measured`).toContain(route);
    }
  });

  for (const route of EXPLAINER_ROUTES) {
    const budget = EXPLAINERS[route] ?? 0;
    test(`${route} has ${budget} explainers`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, {
        timeout: 30_000,
      });
      expect(new URL(page.url()).pathname, "redirected").not.toMatch(
        /^\/auth\//,
      );
      const { hints, freeParagraphs, blocks } = await readPageText(page);
      // A page that rendered nothing would meet any budget.
      expect(blocks.length, `${route} rendered no text`).toBeGreaterThan(1);
      const count = hints + freeParagraphs.length;
      const detail = `${hints} hints, free paragraphs: ${JSON.stringify(freeParagraphs)}`;
      expect(
        count,
        `${route}: ${count} explainers, budget ${budget} (${detail})`,
      ).toBeLessThanOrEqual(budget);
      expect(
        count,
        `${route}: ${count} explainers, under its budget of ${budget}; lower it (${detail})`,
      ).toBe(budget);
    });
  }
});
