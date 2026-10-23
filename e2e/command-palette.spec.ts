import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";

/**
 * v1.42 — the command palette.
 *
 *   - Cmd/Ctrl+K, "sleep", Enter lands on the sleep page;
 *   - a settings card is a link with its anchor, and the page scrolls to it;
 *   - a module's entry is a switch: Enter sends the module write and the
 *     palette stays open (the write is answered by a route mock, so the
 *     shared account's modules never move);
 *   - the top bar carries a magnifier at every width, named "Search",
 *     with a tooltip that gives the shortcut; on a phone it opens a
 *     full-height sheet with the field focused;
 *   - the open palette passes axe;
 *   - a hit from the record search ("In your records", answered by a route
 *     mock so the shared account's records never move) lists after the local
 *     results, Enter on it opens its page, and a visit lands on the visits
 *     tab; on a phone the hit fits the width.
 *
 * Stable hooks only: `command-palette` (+ `data-variant`),
 * `command-palette-input`, `command-palette-trigger`,
 * `command-palette-tooltip`,
 * options by `data-entry`.
 */

test.use({ storageState: STORAGE_STATE_PATH });

const palette = (page: Page) => page.locator('[data-slot="command-palette"]');

/** Answer `POST /api/search` with one visit hit, and count the requests. */
async function mockRecordSearch(page: Page): Promise<string[]> {
  const queries: string[] = [];
  await page.route("**/api/search", async (route) => {
    // The query rides the JSON body, never the URL.
    expect(route.request().method()).toBe("POST");
    expect(route.request().url()).not.toContain("?");
    const body = route.request().postDataJSON() as { q?: string } | null;
    queries.push(body?.q ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          groups: [
            {
              kind: "visit",
              more: false,
              hits: [
                {
                  id: "visit:e2e-visit",
                  kind: "visit",
                  title: { text: "Arthroscopy", marks: [] },
                  context: [
                    { text: "Shoulder (left)", marks: [[0, 8]] },
                    { text: "A practitioner with a long name", marks: [] },
                  ],
                  snippet: {
                    text: "Follow-up for the shoulder after the operation, physiotherapy twice a week",
                    marks: [[18, 26]],
                  },
                  day: "2026-03-02",
                  path: "/checkups?visit=e2e-visit",
                  source: null,
                },
              ],
            },
          ],
          truncated: false,
        },
        error: null,
      }),
    });
  });
  return queries;
}
const input = (page: Page) =>
  page.locator('[data-slot="command-palette-input"]');

async function shellReady(page: Page): Promise<void> {
  await expect(page.locator("#main-content")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-slot="top-bar"]')).toBeVisible();
}

/**
 * Scan the open palette once it has finished opening. The dialog fades in,
 * and a scan that lands mid-fade reads every colour blended with the page
 * behind it: on a loaded machine the selected option's text measured 4.47:1
 * against a 4.5:1 floor it clears once the fade ends. Finite animations are
 * awaited, bounded, so a stuck one costs the wait and not the test.
 */
async function scanPalette(page: Page) {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity);
    await Promise.race([
      Promise.allSettled(finite.map((a) => a.finished)),
      new Promise((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
  });
  return new AxeBuilder({ page })
    .include('[data-slot="command-palette"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
}

test.describe("command palette", () => {
  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "palette journeys run on the desktop project (the phone case resizes)",
    );
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "en", url: baseURL },
    ]);
  });

  test("Cmd/Ctrl+K, sleep, Enter opens the sleep page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await shellReady(page);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette(page)).toHaveAttribute("data-variant", "dialog");
    await expect(input(page)).toBeFocused();
    await input(page).fill("sleep");
    // The best hit is the highlighted option.
    const active = await input(page).getAttribute("aria-activedescendant");
    await expect(page.locator(`[id="${active}"]`)).toHaveAttribute(
      "data-entry",
      "insights:sleep",
    );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/insights\/sleep$/);
    await expect(palette(page)).toHaveCount(0);
  });

  test("a settings card opens at its anchor", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await shellReady(page);
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("passkeys");
    await page.locator('[data-entry="settings:security#passkeys"]').click();
    await expect(page).toHaveURL(/\/settings\/security#passkeys$/);
    await expect(page.locator("#passkeys")).toBeInViewport({ timeout: 10_000 });
  });

  test("a module is a switch; Enter flips it and the palette stays", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const writes: unknown[] = [];
    await page.route("**/api/auth/me/modules", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      writes.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            modules: { timeline: true },
            updatedAt: new Date().toISOString(),
          },
          error: null,
        }),
      });
    });
    await page.goto("/");
    await shellReady(page);
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("timeline");
    const option = page.locator('[data-entry="module:timeline"]');
    await expect(option).toHaveAttribute("aria-checked", "false");
    await option.hover();
    await page.keyboard.press("Enter");
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ timeline: true });
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toHaveValue("timeline");
  });

  test("a hit from the record opens its page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const queries = await mockRecordSearch(page);
    // Start on the page the hit opens, on another tab: the link has to move
    // the open page, not only a fresh one.
    await page.goto("/checkups");
    await shellReady(page);
    await expect(
      page.locator('[data-testid="checkups-tab-visits"]'),
    ).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("shoulder");
    const hit = page.locator('[data-entry="record:visit:e2e-visit"]');
    await expect(hit).toBeVisible();
    // Asked once the typing paused, not once per letter.
    expect(queries).toEqual(["shoulder"]);
    await expect(
      page.locator('[data-group="records"] mark').first(),
    ).toHaveText("Shoulder");

    const axe = await scanPalette(page);
    expect(axe.violations).toEqual([]);

    // The arrows reach it after the local options, and Enter opens it.
    for (let i = 0; i < 40; i++) {
      const active = await input(page).getAttribute("aria-activedescendant");
      if (active && (await hit.getAttribute("id")) === active) break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(hit).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/checkups\?visit=e2e-visit$/);
    await expect(palette(page)).toHaveCount(0);
    await expect(
      page.locator('[data-testid="checkups-tab-visits"]'),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("the top bar: a magnifier on a wide desktop, with the shortcut in its tooltip", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await shellReady(page);
    const magnifier = page.locator('[data-slot="command-palette-trigger"]');
    await expect(magnifier).toHaveCount(1);
    await expect(magnifier).toBeVisible();
    await expect(magnifier).toHaveAttribute("aria-label", "Search");
    await expect(magnifier).toHaveAttribute(
      "aria-keyshortcuts",
      /^(Meta|Control)\+K$/,
    );
    // An icon, not a field: no visible words in the button.
    expect((await magnifier.innerText()).trim()).toBe("");
    await magnifier.hover();
    await expect(
      page.locator('[data-slot="command-palette-tooltip"]').first(),
    ).toHaveText(/^Search \((⌘K|Ctrl K)\)$/);
    await magnifier.click();
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toBeFocused();

    const axe = await scanPalette(page);
    expect(axe.violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
  });

  test("on a phone: the magnifier opens a full-height sheet", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await shellReady(page);
    const magnifier = page.locator('[data-slot="command-palette-trigger"]');
    await expect(magnifier).toBeVisible();
    await expect(magnifier).toHaveAttribute("aria-label", "Search");
    await magnifier.click();
    await expect(palette(page)).toHaveAttribute("data-variant", "sheet");
    await expect(input(page)).toBeFocused();
    const box = await palette(page).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(844 - 1);
    await input(page).fill("weight");
    await expect(page.locator('[data-entry="insights:weight"]')).toBeVisible();
  });

  test("on a phone: a hit from the record fits the width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockRecordSearch(page);
    await page.goto("/");
    await shellReady(page);
    await page.locator('[data-slot="command-palette-trigger"]').click();
    await input(page).fill("shoulder");
    const hit = page.locator('[data-entry="record:visit:e2e-visit"]');
    await expect(hit).toBeVisible();
    const box = await hit.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    const overflow = await page
      .locator('[data-slot="command-palette-results"]')
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await hit.click();
    await expect(page).toHaveURL(/\/checkups\?visit=e2e-visit$/);
  });
});
