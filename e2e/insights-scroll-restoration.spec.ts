import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.28 R3a FB-D3 — `/insights` scroll restoration + tab-strip
 * gesture handling.
 *
 * Two regressions the maintainer hit walking through v1.4.27:
 *
 *   (a) Returning from a sub-page to `/insights` landed the viewport
 *       partway down the page because the mother page had no scroll
 *       reset on mount and the sub-page's `SubPageShell` had already
 *       reset it for the sub-page only.
 *
 *   (b) Vertical swipes that started on the sticky `<InsightsTabStrip>`
 *       were eaten by the strip's `overflow-x-auto` scroll container,
 *       so the page "felt stuck" until the gesture lifted.
 *
 * Both fixes land in the same commit. This spec is the regression
 * lock — failure here means a future refactor re-introduced one of
 * the two roots.
 */
test.describe("v1.4.28 — insights scroll restoration", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("returning to /insights from a sub-page lands at the top", async ({
    page,
  }) => {
    await page.goto("/insights", { waitUntil: "domcontentloaded" });

    // A visible server-rendered link is not yet an interactive React link.
    // Wait for this client component's hydration boundary before scrolling or
    // clicking so the pointer gesture cannot race React replacing the anchor.
    const tabStrip = page.locator("[data-slot='insights-tab-strip']");
    await expect(tabStrip).toHaveAttribute("data-hydrated", "true");

    // v1.25.1 — the app-wide scroll-to-top resets the `#main-content`
    // scroll container on every route change (auth-shell), with a
    // `window.scrollTo(0,0)` fallback for the body-scrolled shells. The
    // authenticated insights surface scrolls `#main-content`, so the
    // regression lock reads that container, not `window`.
    const readScrollTop = () =>
      page.evaluate(() => {
        const el = document.getElementById("main-content");
        return el && el.scrollHeight > el.clientHeight
          ? el.scrollTop
          : window.scrollY;
      });

    // Force the mother page tall enough that scrolling has somewhere
    // to go even on a sparse seed; the rendered Insights overview
    // already runs ~1500 px tall on the demo seed.
    await page.evaluate(() => {
      const el = document.getElementById("main-content");
      if (el && el.scrollHeight > el.clientHeight) {
        el.scrollTop = 600;
      } else {
        window.scrollTo({ top: 600, behavior: "auto" });
      }
    });
    await expect.poll(readScrollTop).toBeGreaterThan(100);

    // Recovery is always present and remains a direct link across responsive
    // pill grouping. Target its route contract instead of a mutable list index.
    const subPagePill = tabStrip.locator(
      "[data-slot='insights-tab-strip-pill'][href='/insights/recovery']",
    );
    await expect(subPagePill).toBeVisible();
    await subPagePill.click();
    await expect(page).toHaveURL(/\/insights\/recovery\/?$/);

    // Back to the mother page through the overview pill.
    const overviewPill = tabStrip.locator(
      "[data-slot='insights-tab-strip-pill'][href='/insights']",
    );
    await expect(overviewPill).toBeVisible();
    await overviewPill.click();
    await expect(page).toHaveURL(/\/insights\/?$/);

    // The shell's route-change effect resets the scroll on the next tick;
    // `useScrollResetOnRoute` defers to `requestAnimationFrame`. Wait for it
    // to settle, then assert the container is back at the top.
    await expect.poll(readScrollTop, { timeout: 2000 }).toBeLessThan(50);
  });

  test("the sticky tab strip declares touch-action pan-y so vertical swipes pass through", async ({
    page,
  }) => {
    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    const nav = page.locator("[data-slot='insights-tab-strip']");
    await expect(nav).toBeVisible();
    const touchAction = await nav.evaluate(
      (el) =>
        (el as HTMLElement).style.touchAction ||
        getComputedStyle(el).touchAction,
    );
    expect(touchAction).toContain("pan-y");
  });

  test("the tab strip's horizontal scroll lives on an inner row, not on the outer nav", async ({
    page,
  }) => {
    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    const nav = page.locator("[data-slot='insights-tab-strip']");
    const innerScroller = nav.locator(
      "[data-slot='insights-tab-strip-scroller']",
    );
    await expect(nav).toHaveAttribute("data-hydrated", "true");
    await expect(innerScroller).toBeVisible();

    const navOverflowX = await nav.evaluate(
      (el) => getComputedStyle(el).overflowX,
    );
    // The outer `<nav>` no longer scrolls horizontally — the inner row
    // owns that responsibility now so vertical swipes outside the row
    // reach the document.
    expect(navOverflowX).not.toBe("auto");
    expect(navOverflowX).not.toBe("scroll");

    const innerOverflowX = await innerScroller.evaluate(
      (el) => getComputedStyle(el).overflowX,
    );
    expect(innerOverflowX).toMatch(/auto|scroll/);
  });
});
