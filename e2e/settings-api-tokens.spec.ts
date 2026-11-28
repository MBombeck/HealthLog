import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Settings → API & tokens: one table, one "New token" flow, the address once.
 *
 * The token list and the mint are mocked, so the table shows every kind of
 * token and the flow never writes a real credential. Runs in the desktop
 * project and sizes the page itself.
 */
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) =>
  new Date(Date.now() - hours * HOUR).toISOString();

const TOKENS = [
  {
    id: "t1",
    name: "Home Assistant",
    permissions: ["measurements:write"],
    lastUsedAt: ago(0.1),
    expiresAt: null,
    createdAt: ago(24 * 40),
    revoked: false,
    mirrorToAppleHealth: false,
  },
  {
    id: "t2",
    name: "Paperless-ngx",
    permissions: ["documents:write"],
    lastUsedAt: ago(20),
    expiresAt: null,
    createdAt: ago(24 * 90),
    revoked: false,
    mirrorToAppleHealth: false,
  },
  {
    id: "t3",
    name: "Ramipril",
    permissions: ["medication:ingest"],
    lastUsedAt: null,
    expiresAt: null,
    createdAt: ago(24 * 3),
    revoked: false,
    mirrorToAppleHealth: false,
  },
  {
    id: "t4",
    name: "Old script",
    permissions: ["workouts:write"],
    lastUsedAt: ago(24 * 100),
    expiresAt: null,
    createdAt: ago(24 * 200),
    revoked: true,
    mirrorToAppleHealth: false,
  },
];

const MINTED = "e2e-token-value-shown-once";

async function mockTokens(page: Page): Promise<string[]> {
  const minted: string[] = [];
  await page.route("**/api/tokens", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: TOKENS, error: null }),
    }),
  );
  await page.route("**/api/tokens/measurements", (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { unattributedReadings: 0 },
          error: null,
        }),
      });
    }
    minted.push(route.request().postData() ?? "");
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: { token: MINTED, name: "Scale", expiresAt: null },
        error: null,
      }),
    });
  });
  return minted;
}

test.describe("Settings → API & tokens", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "sizes the viewport itself",
    );
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "390 px", width: 390, height: 844 },
  ] as const) {
    test(`one table of active tokens at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockTokens(page);
      await page.goto("/settings/api");

      const rows = page.locator('[data-testid="settings-api-token-row"]');
      await expect(rows).toHaveCount(3, { timeout: 15_000 });
      await expect(page.locator("table")).toHaveCount(1);
      // One chip per row, no raw scope.
      await expect(rows.locator('[data-slot="tag-chip"]')).toHaveCount(3);
      await expect(page.locator("main")).not.toContainText(
        "measurements:write",
      );
      // The address once.
      await expect(page.getByTestId("api-address")).toHaveCount(1);

      // Revoked tokens wait behind one line.
      await page.getByTestId("settings-api-tokens-show-revoked").click();
      await expect(rows).toHaveCount(4);

      const dims = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(dims.scrollWidth).toBeLessThanOrEqual(dims.innerWidth + 1);
    });
  }

  test("New token: name, access, expiry, then the token once", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const minted = await mockTokens(page);
    await page.goto("/settings/api");

    await page.locator('[data-testid="api-new-token"]:visible').click();
    const form = page.locator('[data-slot="api-new-token-form"]');
    await expect(form).toBeVisible();
    await form.getByRole("textbox").fill("Scale");
    await expect(page.getByTestId("api-new-token-scope")).toHaveValue(
      "measurements",
    );
    await form.locator("select").nth(1).selectOption("90");
    await page.getByTestId("api-new-token-create").click();

    await expect(page.getByTestId("api-new-token-value")).toHaveText(MINTED);
    expect(JSON.parse(minted[0])).toMatchObject({
      name: "Scale",
      expiresInDays: 90,
      mirrorToAppleHealth: false,
    });
    await page.getByTestId("api-new-token-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      MINTED,
    );
    await page.getByRole("button", { name: /done|fertig/i }).click();
    await expect(page.getByTestId("api-new-token-value")).toHaveCount(0);
    await expect(page).not.toHaveURL(/new-token=/);
  });

  test("a row's menu revokes only after asking", async ({ page }) => {
    await mockTokens(page);
    await page.goto("/settings/api");
    const menu = page.getByTestId("settings-api-token-menu").first();
    await expect(menu).toBeVisible({ timeout: 15_000 });
    await menu.focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("settings-api-token-revoke").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`table and flow read accessibly in the ${theme} theme`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((explicit: string) => {
        window.localStorage.setItem("healthlog-theme", explicit);
      }, theme);
      await mockTokens(page);
      await page.goto("/settings/api");
      await expect(
        page.locator('[data-testid="settings-api-token-row"]'),
      ).toHaveCount(3, { timeout: 15_000 });

      const scan = async (selector: string) =>
        (
          await new AxeBuilder({ page })
            .include(selector)
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze()
        ).violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map(
            (v) =>
              `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          );
      expect(await scan("main")).toEqual([]);

      await page.locator('[data-testid="api-new-token"]:visible').click();
      await expect(
        page.locator('[data-slot="api-new-token-form"]'),
      ).toBeVisible();
      expect(await scan('[role="dialog"]')).toEqual([]);
    });
  }
});
