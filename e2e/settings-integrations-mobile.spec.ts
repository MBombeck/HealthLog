import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  INTEGRATION_ROW_STATUS,
  mockIntegrationCards,
} from "./setup/integration-cards-fixture";

/**
 * `/settings/integrations` on a Pixel-5 viewport (393 CSS px) must:
 *
 *   1. Not produce horizontal page overflow, with the list and with a sheet
 *      open. A row's name and meta line truncate; the chip and chevron keep
 *      their place at the right edge.
 *   2. Show exactly one status chip per row, painted and legible.
 *
 * Mobile-only spec; the desktop project skips it.
 */
test.describe("/settings/integrations Pixel-5 layout", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("Pixel-5 viewport: no horizontal page scroll, one chip per row", async ({
    page,
  }) => {
    await mockIntegrationCards(page);
    await page.goto("/settings/integrations", {
      waitUntil: "domcontentloaded",
    });

    const rows = page.locator('[data-slot="integration-row"]');
    await expect(rows).toHaveCount(Object.keys(INTEGRATION_ROW_STATUS).length, {
      timeout: 10_000,
    });
    const chips = page.locator(
      '[data-slot="integration-row"] [data-slot="status-chip"]',
    );
    await expect(chips).toHaveCount(Object.keys(INTEGRATION_ROW_STATUS).length);
    for (let i = 0; i < (await rows.count()); i++) {
      const row = await rows.nth(i).boundingBox();
      const chip = await chips.nth(i).boundingBox();
      expect(chip, `chip ${i} has no bounding box`).not.toBeNull();
      expect(chip!.width).toBeGreaterThan(0);
      // The chip stays inside its row, at the right.
      expect(chip!.x + chip!.width).toBeLessThanOrEqual(row!.x + row!.width);
      expect(chip!.x).toBeGreaterThan(row!.x + row!.width / 2);
    }

    const measure = () =>
      page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
    let dims = await measure();
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.innerWidth + 1);

    // A sheet opens from the bottom and fits the phone too.
    await page.locator('[data-testid="integration-row-whoop"]').click();
    const sheet = page.locator('[data-slot="integration-sheet"]');
    await expect(sheet).toBeVisible();
    await expect(
      page.locator('[data-slot="responsive-sheet-content"]'),
    ).toHaveAttribute("data-variant", "sheet");
    dims = await measure();
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.innerWidth + 1);
  });
});

test.describe("Apple Health guidance", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("opens on Integrations and reaches the one-shot import fallback", async ({
    page,
  }) => {
    await page.route("**/api/integrations/healthkit", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            entries: [],
            lastSyncedAt: null,
            // Nothing delivered yet: no health, so the card is not connected.
            health: null,
            metricFreshness: [],
            // #778 — nothing accepted yet, so the card must show no
            // progress section for this pending-first-sync account.
            syncProgress: { recordsAccepted: 0, oldestMeasuredAt: null },
          },
          error: null,
        }),
      }),
    );

    await page.goto("/settings/integrations?integration=apple-health");

    const card = page.getByTestId("apple-health-card");
    await expect(card).toBeVisible();
    // The product name is a proper noun and stays assertable; the sentence
    // around it is not. The description SLOT is the stable target — this spec
    // is about the card rendering its explainer, not about its wording, and
    // the wording is pinned by `apple-health-card.test.tsx` against the same
    // i18n bundle it renders from.
    await expect(card).toContainText("HealthLog iOS app");
    const description = card.locator('[data-slot="settings-card-description"]');
    await expect(description).toBeVisible();
    await expect(description).not.toHaveText("");
    // A raw key means the bundle lookup failed, which is the failure this
    // assertion can actually see from a browser.
    await expect(description).not.toContainText("settings.appleHealth");
    await expect(card).toHaveAttribute("data-state", "not_connected");
    await expect(
      card.locator('[data-slot="integration-health-badge"]'),
    ).toHaveCount(0);

    const importLink = page.getByTestId("apple-health-import-link");
    await expect(importLink).toHaveAttribute(
      "href",
      "/settings/export#settings-section-import-title",
    );
    await page.goto("/settings/export#settings-section-import-title");
    await expect(page).toHaveURL(
      /\/settings\/export#settings-section-import-title$/,
    );
    await expect(page.getByTestId("import-card-apple-health")).toBeVisible();
  });
});
