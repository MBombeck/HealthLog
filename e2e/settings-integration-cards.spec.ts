import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  INTEGRATION_CARD_STATES,
  INTEGRATION_ROW_STATUS,
  mockIntegrationCards,
} from "./setup/integration-cards-fixture";

/**
 * Settings → Integrations: the list, the sheet each row opens, and "Add".
 *
 * The overview and the status envelope are mocked (see the fixture) so every
 * status shows on one page. The page is checked at desktop width and at
 * 390 px. Assertions read data attributes only: a row's `data-status`, the
 * chip's `data-tone`, the sheet card's `data-state`, the one primary button's
 * `data-action`. The wording is pinned by the component tests.
 *
 * Runs in the desktop project and sizes the page itself, so one run covers
 * both widths without a second project driving the same account.
 */
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "390 px", width: 390, height: 844 },
] as const;

function noHorizontalScroll() {
  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
}

test.describe("Settings → Integrations: list, sheet, add", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "sizes the viewport itself",
    );
  });

  for (const viewport of VIEWPORTS) {
    test(`lists what is set up with one chip per row at ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockIntegrationCards(page);
      await page.goto("/settings/integrations");

      const rows = page.locator('[data-slot="integration-row"]');
      await expect(rows).toHaveCount(
        Object.keys(INTEGRATION_ROW_STATUS).length,
        { timeout: 15_000 },
      );
      for (const [key, status] of Object.entries(INTEGRATION_ROW_STATUS)) {
        const row = page.locator(`[data-testid="integration-row-${key}"]`);
        await expect(row, key).toHaveAttribute("data-status", status);
        const chip = row.locator('[data-slot="status-chip"]');
        await expect(chip, key).toHaveCount(1);
        await expect(chip, key).toHaveAttribute("data-tone", status);
        await expect(chip, key).not.toHaveText("");
        if (viewport.width < 640) {
          const box = await row.boundingBox();
          expect(box?.height ?? 0, `${key} row`).toBeGreaterThanOrEqual(44);
        }
      }
      // Not set up: not on the page.
      await expect(
        page.locator('[data-testid="integration-row-nightscout"]'),
      ).toHaveCount(0);

      const dims = await page.evaluate(noHorizontalScroll);
      expect(dims.scrollWidth).toBeLessThanOrEqual(dims.innerWidth + 1);
    });

    test(`a row opens its sheet with the action its state names at ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockIntegrationCards(page);
      await page.goto("/settings/integrations");

      for (const [provider, expected] of Object.entries(
        INTEGRATION_CARD_STATES,
      )) {
        if (expected.state === "not_connected") continue;
        await page
          .locator(`[data-testid="integration-row-${provider}"]`)
          .click();
        const sheet = page.locator(
          `[data-slot="integration-sheet"][data-integration="${provider}"]`,
        );
        await expect(sheet, provider).toBeVisible({ timeout: 15_000 });
        await expect(
          sheet.locator(
            '[data-slot="integration-facts"] [data-slot="status-chip"]',
          ),
          provider,
        ).toHaveCount(1);
        const card = sheet.locator('[data-slot="integration-card"]');
        await expect(card, provider).toHaveAttribute(
          "data-state",
          expected.state,
        );
        // The old badge does not come back inside the sheet.
        await expect(
          sheet.locator('[data-slot="integration-health-badge"]'),
        ).toHaveCount(0);

        if (provider !== "apple-health") {
          const primary = sheet.locator(
            '[data-slot="integration-primary-action"]',
          );
          await expect(primary, provider).toHaveCount(1);
          await expect(primary, provider).toHaveAttribute(
            "data-action",
            expected.primary ?? "reconnect",
          );
          await expect(
            sheet.locator('[data-slot="integration-sync-action"]'),
            provider,
          ).toHaveCount(1);
          if (viewport.width < 640) {
            const box = await primary.boundingBox();
            expect(
              box?.height ?? 0,
              `${provider} tap target`,
            ).toBeGreaterThanOrEqual(44);
          }
        }
        await page.keyboard.press("Escape");
        await expect(sheet).toHaveCount(0);
      }
      await expect(page).not.toHaveURL(/integration=/);
    });
  }

  test("the ⋯ menu works from the keyboard and Disconnect asks first", async ({
    page,
  }) => {
    await mockIntegrationCards(page);
    await page.goto("/settings/integrations?integration=withings");

    const sheet = page.locator('[data-slot="integration-sheet"]');
    const trigger = page.locator('[data-slot="integration-menu-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.locator('[data-slot="integration-menu"]');
    await expect(menu).toBeVisible();
    // Sync now moved into the action pair; the rest stays in the menu.
    await expect(menu.locator('[data-action="sync"]')).toHaveCount(0);
    await expect(menu.locator('[data-action="disconnect"]')).toHaveCount(1);

    await menu.locator('[data-action="disconnect"]').focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      sheet.locator('[data-slot="integration-card"]'),
    ).toHaveAttribute("data-state", "limited");
  });

  test("details open on request and Copy puts exactly the shown text on the clipboard", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockIntegrationCards(page);
    await page.goto("/settings/integrations#polar");

    const sheet = page.locator(
      '[data-slot="integration-sheet"][data-integration="polar"]',
    );
    const toggle = sheet.locator('[data-slot="integration-details-toggle"]');
    const panel = sheet.locator('[data-slot="integration-details"]');
    await expect(toggle).toHaveAttribute("aria-expanded", "false", {
      timeout: 15_000,
    });
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(panel).toBeVisible();

    const shown = await panel
      .locator('[data-slot="integration-diagnostics"]')
      .innerText();
    expect(shown).toContain("degraded / provider_errors");
    await panel.locator('[data-slot="integration-diagnostics-copy"]').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.trim()).toBe(shown.trim());
  });

  test("Add lists what is offered and opens its setup", async ({ page }) => {
    await mockIntegrationCards(page);
    await page.goto("/settings/integrations");

    await page.locator('[data-testid="integrations-add"]:visible').click();
    const add = page.locator('[data-slot="integration-add-sheet"]');
    await expect(add).toBeVisible({ timeout: 15_000 });
    await expect(add.locator('[data-testid^="integration-add-"]')).toHaveCount(
      5,
    );
    // The operator offers no mail transport and no document sources.
    await expect(add.getByTestId("integration-add-email")).toHaveCount(0);
    await expect(add.getByTestId("integration-add-dawarich")).toHaveCount(0);

    await add.getByTestId("integration-add-nightscout").click();
    const sheet = page.locator(
      '[data-slot="integration-sheet"][data-integration="nightscout"]',
    );
    await expect(sheet).toBeVisible();
    await expect(
      sheet.locator('[data-slot="integration-card"]'),
    ).toHaveAttribute("data-state", "not_connected");
    await expect(
      sheet.locator('[data-slot="integration-primary-action"]'),
    ).toHaveAttribute("data-action", "connect");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`list and sheet read accessibly in the ${theme} theme`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((explicit: string) => {
        window.localStorage.setItem("healthlog-theme", explicit);
      }, theme);
      await mockIntegrationCards(page);
      await page.goto("/settings/integrations");
      await expect(page.locator('[data-slot="integration-row"]')).toHaveCount(
        Object.keys(INTEGRATION_ROW_STATUS).length,
        { timeout: 15_000 },
      );

      const scan = async (selector: string) => {
        const results = await new AxeBuilder({ page })
          .include(selector)
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        return results.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map(
            (v) =>
              `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          );
      };
      expect(await scan("main")).toEqual([]);

      await page.locator('[data-testid="integration-row-polar"]').click();
      const sheet = page.locator('[data-slot="integration-sheet"]');
      await expect(sheet).toBeVisible();
      await sheet.locator('[data-slot="integration-details-toggle"]').click();
      expect(await scan('[role="dialog"]')).toEqual([]);
    });
  }
});
