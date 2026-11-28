import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  INTEGRATION_CARD_STATES,
  mockIntegrationCards,
} from "./setup/integration-cards-fixture";

/**
 * Settings → Integrations: the shared integration card, one card per state.
 *
 * Every provider is mocked into a different `health` (see the fixture), and
 * the page is checked at desktop width and at 390 px. Assertions read data
 * attributes only: the card's `data-state`, the badge's `data-state`, the one
 * primary button's `data-action`. The wording is pinned by the component
 * tests against the bundle itself.
 *
 * Runs in the desktop project and sizes the page itself, so one run covers
 * both widths without a second project driving the same account.
 */
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "390 px", width: 390, height: 844 },
] as const;

test.describe("Settings → Integrations: one card per health state", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "sizes the viewport itself",
    );
  });

  for (const viewport of VIEWPORTS) {
    test(`renders each state from health alone at ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockIntegrationCards(page);
      await page.goto("/settings/integrations");

      for (const [provider, expected] of Object.entries(
        INTEGRATION_CARD_STATES,
      )) {
        const card = page.locator(
          `[data-slot="integration-card"][data-integration="${provider}"]`,
        );
        await expect(card, provider).toHaveAttribute(
          "data-state",
          expected.state,
          { timeout: 15_000 },
        );

        const badge = card.locator('[data-slot="integration-health-badge"]');
        if (expected.state === "not_connected") {
          await expect(badge, provider).toHaveCount(0);
        } else {
          await expect(badge, provider).toHaveAttribute(
            "data-state",
            expected.state,
          );
          // The word is the accessible name, not decoration.
          await expect(badge, provider).not.toHaveText("");
        }

        // At most one primary, and exactly the one the state names.
        const primary = card.locator(
          '[data-slot="integration-primary-action"]',
        );
        if (expected.primary === null) {
          await expect(primary, provider).toHaveCount(0);
        } else {
          await expect(primary, provider).toHaveCount(1);
          await expect(primary, provider).toHaveAttribute(
            "data-action",
            expected.primary,
          );
          if (viewport.width < 640) {
            const box = await primary.boundingBox();
            expect(
              box?.height ?? 0,
              `${provider} tap target`,
            ).toBeGreaterThanOrEqual(44);
          }
        }
      }

      // Nothing on the page states a status the old way.
      await expect(
        page.locator('[data-testid="integration-status-pill"]'),
      ).toHaveCount(0);

      const dims = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        dims.scrollWidth,
        `scrollWidth=${dims.scrollWidth}, innerWidth=${dims.innerWidth}`,
      ).toBeLessThanOrEqual(dims.innerWidth + 1);
    });
  }

  test("the menu works from the keyboard and keeps its confirmations", async ({
    page,
  }) => {
    await mockIntegrationCards(page);
    await page.goto("/settings/integrations");

    const card = page.locator(
      '[data-slot="integration-card"][data-integration="withings"]',
    );
    const trigger = card.locator('[data-slot="integration-menu-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.locator('[data-slot="integration-menu"]');
    await expect(menu).toBeVisible();
    await expect(
      menu.locator('[data-slot="integration-menu-item"]'),
    ).toHaveCount(7);

    // Disconnect asks first; dismissing the dialog does nothing.
    await menu.locator('[data-action="disconnect"]').focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveAttribute("data-state", "limited");

    // Escape closes the menu and returns focus to its trigger.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("details open on request and Copy puts exactly the shown text on the clipboard", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockIntegrationCards(page);
    await page.goto("/settings/integrations");

    const card = page.locator(
      '[data-slot="integration-card"][data-integration="polar"]',
    );
    const toggle = card.locator('[data-slot="integration-details-toggle"]');
    const panel = card.locator('[data-slot="integration-details"]');
    await expect(toggle).toHaveAttribute("aria-expanded", "false", {
      timeout: 15_000,
    });
    await expect(panel).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();

    const shown = await panel
      .locator('[data-slot="integration-diagnostics"]')
      .innerText();
    expect(shown).toContain("degraded / provider_errors");
    expect(shown).toContain("503");

    await panel.locator('[data-slot="integration-diagnostics-copy"]').click();
    const status = panel.locator(
      '[data-slot="integration-diagnostics-copy-status"]',
    );
    await expect(status).toHaveAttribute("data-state", "copied");
    await expect(status).toHaveAttribute("role", "status");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.trim()).toBe(shown.trim());
  });

  for (const theme of ["light", "dark"] as const) {
    test(`every state reads accessibly in the ${theme} theme`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((explicit: string) => {
        window.localStorage.setItem("healthlog-theme", explicit);
      }, theme);
      await mockIntegrationCards(page);
      await page.goto("/settings/integrations");
      const panel = page.locator('[data-slot="connections-panel"]');
      await expect(
        panel.locator(
          '[data-slot="integration-card"][data-integration="whoop"]',
        ),
      ).toHaveAttribute("data-state", "action_required", { timeout: 15_000 });
      // Scan with one details panel open, so the diagnostics block and its
      // copy button are part of what is checked.
      await panel
        .locator(
          '[data-integration="polar"] [data-slot="integration-details-toggle"]',
        )
        .click();

      const results = await new AxeBuilder({ page })
        .include('[data-slot="connections-panel"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const serious = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map(
          (v) =>
            `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        );
      expect(serious).toEqual([]);
    });
  }
});

test.describe("Settings → Integrations: connect an Android device", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "sizes the viewport itself",
    );
  });

  for (const viewport of VIEWPORTS) {
    test(`the row opens the pairing sheet with a QR code at ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      // The mint sits behind the recent-proof gate; answered here so the
      // sheet's own states are what is checked.
      await page.route("**/api/health-connect/pairing", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              code: "hcp_0123456789abcdef0123456789abcdef",
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              link: "healthlog-sync://pair?server=http%3A%2F%2Flocalhost&code=hcp_0123456789abcdef0123456789abcdef",
            },
            error: null,
          }),
        }),
      );
      await page.goto("/settings/integrations#health-connect-app");
      const group = page.getByTestId("health-connect-app");
      await expect(group).toBeVisible({ timeout: 15_000 });
      await group.getByTestId("health-connect-app-connect").click();
      const sheet = page.getByTestId("health-connect-app-sheet");
      await expect(sheet.getByTestId("health-connect-app-qr")).toBeVisible();
      await expect(sheet.getByTestId("health-connect-app-qr")).toHaveAttribute(
        "src",
        /^data:image\/svg\+xml/,
      );
    });
  }
});
