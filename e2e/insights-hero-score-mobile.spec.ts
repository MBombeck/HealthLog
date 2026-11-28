import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { mockPopulatedInsights } from "./utils/mock-populated-insights";
import {
  expectNoHorizontalOverflow,
  settleForOverflowMeasurement,
} from "./utils/horizontal-overflow";

/**
 * The Health Score panel at 360 px, on its own page since 1.50, and its
 * ring at the head of the overview.
 *
 * The panel is the widest-content block on its page: a fixed label
 * column, a fill bar, a value column and a popover trigger on one line, plus
 * a coalesced failed-read line carrying an inline button, plus a disclosure
 * whose open state adds a bordered tile and three prose paragraphs. 360 px is
 * the narrowest common Android width and the one this overview has scrolled
 * sideways at before.
 *
 * Two ways a guard like this proves nothing, both of which have bitten this
 * repo: measuring only `document.scrollWidth` when `AuthShell` scrolls inside
 * `<main>`, and measuring an empty page. The shared helper closes the first;
 * the fixture and the fixture-honesty test below close the second by asserting
 * the panel is actually on screen with rows in it before any width is read.
 *
 * Assertions are on `data-slot` attributes, never on rendered text, so a
 * locale change or a copy edit cannot turn this red for the wrong reason.
 */

const PANEL = '[data-slot="health-score-card"]';

test.describe("the Health Score panel at phone width", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("is on screen with its rows before anything is measured", async ({
    page,
  }) => {
    await mockPopulatedInsights(page, { everyState: true });
    await page.setViewportSize({ width: 360, height: 851 });
    await page.goto("/insights/scores/health", {
      waitUntil: "domcontentloaded",
    });

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('[data-slot="health-score-card-number"]'),
    ).toBeVisible();
    // Four scored pillars in the fixture; a panel with no rows would fit any
    // width and prove nothing about the row geometry.
    await expect(panel.locator("li[data-status='ok']")).toHaveCount(4);
    // The failed read and its retry are visible without opening anything.
    await expect(
      panel.locator('[data-slot="health-score-pillar-error"]'),
    ).toBeVisible();
    await expect(
      panel.locator('[data-slot="health-score-pillar-retry"]'),
    ).toBeVisible();
    // The withheld pillar is one plain sentence with the way to support.
    const crisis = panel.locator('[data-slot="health-score-crisis"]');
    await expect(crisis).toBeVisible();
    await expect(
      crisis.locator('[data-slot="health-score-crisis-link"]'),
    ).toHaveAttribute("href", "/mental-wellbeing");
    await expect(
      panel.locator('[data-slot="health-score-not-scored-count"]'),
    ).toBeVisible();
  });

  test("does not scroll the page sideways, closed or open", async ({
    page,
  }) => {
    await mockPopulatedInsights(page, { everyState: true });
    await page.setViewportSize({ width: 360, height: 851 });
    await page.goto("/insights/scores/health", {
      waitUntil: "domcontentloaded",
    });

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await settleForOverflowMeasurement(page);
    await expectNoHorizontalOverflow(
      page,
      "/insights/scores/health panel @360px",
    );

    // Opened, the disclosure adds the bordered weight-goal tile and the method
    // paragraphs — the widest content the panel can hold.
    await panel.locator('[data-slot="health-score-anatomy-toggle"]').click();
    await expect(
      panel.locator('[data-slot="health-score-weight-goal"]'),
    ).toBeVisible();
    await settleForOverflowMeasurement(page);
    await expectNoHorizontalOverflow(
      page,
      "/insights/scores/health panel open @360px",
    );
  });

  test("keeps the panel inside the band, never wider than it", async ({
    page,
  }) => {
    await mockPopulatedInsights(page, { everyState: true });
    await page.setViewportSize({ width: 360, height: 851 });
    await page.goto("/insights/scores/health", {
      waitUntil: "domcontentloaded",
    });

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await panel.locator('[data-slot="health-score-anatomy-toggle"]').click();
    await expect(
      panel.locator('[data-slot="health-score-weight-goal"]'),
    ).toBeVisible();

    const measured = await panel.evaluate((el) => {
      const band = el.closest('[data-slot="health-score-page"]');
      // The widest descendant that is not contained by its own scroller.
      let widest = 0;
      for (const child of Array.from(el.querySelectorAll("*"))) {
        const r = child.getBoundingClientRect();
        if (r.width > widest) widest = r.width;
      }
      return {
        panelScroll: el.scrollWidth,
        panelClient: el.clientWidth,
        panelRight: Math.round(el.getBoundingClientRect().right),
        bandRight: band ? Math.round(band.getBoundingClientRect().right) : null,
        widestChild: Math.round(widest),
      };
    });

    expect(
      measured.panelScroll,
      `panel scrolls its own content: ${JSON.stringify(measured)}`,
    ).toBeLessThanOrEqual(measured.panelClient + 1);
    expect(measured.bandRight).not.toBeNull();
    expect(
      measured.panelRight,
      `panel extends past the band: ${JSON.stringify(measured)}`,
    ).toBeLessThanOrEqual(measured.bandRight! + 1);
    expect(
      measured.widestChild,
      `a child is wider than the panel: ${JSON.stringify(measured)}`,
    ).toBeLessThanOrEqual(measured.panelClient + 1);
  });

  test("leaves a withheld pillar off the overview's Health score ring", async ({
    page,
  }) => {
    await mockPopulatedInsights(page, { everyState: true });
    await page.setViewportSize({ width: 360, height: 851 });
    await page.goto("/insights", { waitUntil: "domcontentloaded" });

    const tile = page.locator(
      '[data-slot="score-ring-tile"][data-score="HEALTH_SCORE"]',
    );
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute("href", "/insights/scores/health");
    // The ring names the pillar that sets its band, never the withheld one.
    const note = tile.locator('[data-slot="score-ring-tile-line"]');
    await expect(note).toBeVisible();
    await expect(note).not.toContainText(/check-in|safety/i);
    await settleForOverflowMeasurement(page);
    await expectNoHorizontalOverflow(page, "/insights score rings @360px");
  });
});
