import { expect, test } from "./setup/test";

import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";
import heights from "./mobile-height-budgets.json";
import known from "./no-repeated-text-known.json";
import { readPageText } from "./utils/page-text";
import { findRepeats } from "./utils/repeated-text";

/**
 * Nothing twice on a page.
 *
 * On every route of the height budgets, on the same seeded record: no visible
 * text block of three words or more stands twice in `<main>`, and no section
 * heading or card title is the page title again. Data rows are exempt (two
 * readings may look alike); the rest of the page is not.
 *
 * `no-repeated-text-known.json` lists the repeats that remain, per route,
 * each waiting for the change that removes it. It only shrinks: a listed
 * repeat that is gone fails the run until its line is deleted, and a new one
 * fails because it is not listed.
 *
 * It cannot pass empty: a route that yields fewer than two text blocks fails
 * (a renamed hook or a page that rendered nothing), and the collector's
 * detection is pinned by `src/__tests__/repeated-text-guard.test.ts`.
 */
const ROUTES = Object.keys(heights.pages);
const KNOWN = known.routes as Record<string, string[]>;

test.describe("nothing repeated on a page", () => {
  test.use({
    storageState: MOBILE_ROUTES_STORAGE_STATE_PATH,
    openFolds: false,
  });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("covers the height-budget routes, and lists no stranger", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(30);
    for (const route of Object.keys(KNOWN)) {
      expect(ROUTES, `${route} in the known list is not measured`).toContain(
        route,
      );
    }
  });

  for (const route of ROUTES) {
    test(`${route} says each thing once`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, {
        timeout: 30_000,
      });
      expect(new URL(page.url()).pathname, "redirected").not.toMatch(
        /^\/auth\//,
      );

      const { h1, blocks, headings } = await readPageText(page);
      const report = findRepeats(blocks, h1, headings);
      expect(report.tooFew, `${route}: only ${blocks.length} text blocks`).toBe(
        false,
      );

      const allowed = new Set(
        (KNOWN[route] ?? []).map((s) => s.toLocaleLowerCase()),
      );
      const found = [
        ...report.repeats.map((r) => r.text),
        ...report.titleEchoes,
      ];
      const fresh = found.filter((f) => !allowed.has(f.toLocaleLowerCase()));
      expect(fresh, `${route}: repeated on the page`).toEqual([]);
      const gone = [...allowed].filter(
        (a) => !found.some((f) => f.toLocaleLowerCase() === a),
      );
      expect(
        gone,
        `${route}: no longer repeated, remove from the known list`,
      ).toEqual([]);
    });
  }
});
