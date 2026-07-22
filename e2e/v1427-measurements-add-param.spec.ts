import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.27 MB6 — `/measurements?add=<TYPE>` consumer.
 *
 * Insight metric actions link here with `?add=<TYPE>` and an optional,
 * allowlisted `returnTo`. The page opens the responsive capture primitive,
 * pre-selects the matching type, and strips the query without losing the
 * one-shot return context.
 *
 * The browser contract covers the populated-page action, legacy preselection,
 * failure retention, success return, and rejection of an external destination.
 * Playwright runs every case in both the desktop Chromium and Pixel 5 projects.
 */
test.describe("v1.4.27 — /measurements?add= consumer", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // v1.4.39.3 — regex form matches the slim slice the v1.4.39.2
    // dashboard split fires alongside the thick request.
    await page.route(/\/api\/analytics(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { summaries: {}, bpInTargetPct: null, glucoseByContext: {} },
          error: null,
        }),
      }),
    );
    await page.route("**/api/measurements*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { measurements: [], meta: { total: 0 } },
          error: null,
        }),
      }),
    );
  });

  test("a populated metric action opens the matching preselected capture", async ({
    page,
  }) => {
    await page.route(/\/api\/analytics(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summaries: {
              WEIGHT: {
                latest: 78.4,
                count: 4,
                min: 77.9,
                max: 78.8,
                mean: 78.3,
                median: 78.25,
              },
            },
            bpInTargetPct: null,
            glucoseByContext: {},
          },
          error: null,
        }),
      }),
    );

    await page.goto("/insights/weight", { waitUntil: "domcontentloaded" });
    // The action is server-rendered before React can handle client navigation.
    // Pin the click to the Insights surface's existing hydration contract so
    // it cannot race hydration and get replayed as a no-op.
    await expect(
      page.locator('[data-slot="insights-tab-strip"]'),
    ).toHaveAttribute("data-hydrated", "true");

    const capture = page.locator('[data-slot="metric-add-reading"]');
    await expect(capture).toBeVisible();
    await expect(capture).toHaveAttribute(
      "href",
      "/measurements?add=WEIGHT&returnTo=%2Finsights%2Fweight",
    );
    await capture.click();
    await expect(page).toHaveURL(/\/measurements(?:\?|$)/);

    const content = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(content).toBeVisible();
    await expect(content.getByRole("combobox").first()).toContainText(
      /weight|gewicht/i,
    );
  });

  for (const { param, label } of [
    { param: "WEIGHT", label: /weight|gewicht/i },
    { param: "BLOOD_PRESSURE", label: /blood pressure|blutdruck/i },
    { param: "PULSE", label: /pulse|puls|herzfrequenz/i },
  ]) {
    test(`?add=${param} opens the form pre-selected to ${param}`, async ({
      page,
    }) => {
      await page.goto(`/measurements?add=${param}`, {
        waitUntil: "domcontentloaded",
      });

      // Primitive opens on first paint — pin on the shared data-slot.
      const content = page.locator('[data-slot="responsive-sheet-content"]');
      await expect(content).toBeVisible({ timeout: 10_000 });

      // The type combobox label reflects the requested type.
      const combobox = content.getByRole("combobox").first();
      await expect(combobox).toBeVisible();
      await expect(combobox).toContainText(label);

      // URL settles on `/measurements` — the query was replaced away
      // so the back button leaves the user on the list.
      await expect.poll(() => new URL(page.url()).search).toBe("");
    });
  }

  test("keeps the one-shot sheet and entered values when the write fails", async ({
    page,
  }) => {
    await page.route("**/api/measurements*", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ data: null, error: "Write failed" }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto("/measurements?add=WEIGHT&returnTo=%2Finsights%2Fweight", {
      waitUntil: "domcontentloaded",
    });

    const content = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(content).toBeVisible();
    await expect(content.getByRole("combobox").first()).toContainText(
      /weight|gewicht/i,
    );
    await content.locator("#value").fill("78.4");
    await content.locator("#notes").fill("Keep this note");
    await page
      .getByRole("button", { name: /save|speichern/i })
      .last()
      .click();

    await expect(content.getByRole("alert")).toBeVisible();
    await expect(content.locator("#value")).toHaveValue("78.4");
    await expect(content.locator("#notes")).toHaveValue("Keep this note");
    await expect(content).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/measurements");
  });

  test("returns to the validated metric route only after a successful write", async ({
    page,
  }) => {
    await page.route("**/api/measurements*", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { id: "contextual-e2e", success: true },
            error: null,
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto("/measurements?add=WEIGHT&returnTo=%2Finsights%2Fweight", {
      waitUntil: "domcontentloaded",
    });

    const content = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(content.getByRole("combobox").first()).toContainText(
      /weight|gewicht/i,
    );
    await content.locator("#value").fill("78.4");
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/insights/weight"),
      page
        .getByRole("button", { name: /save|speichern/i })
        .last()
        .click(),
    ]);
  });

  test("rejects an external return target after a successful write", async ({
    page,
  }) => {
    await page.route("**/api/measurements*", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { id: "contextual-e2e", success: true },
            error: null,
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(
      "/measurements?add=WEIGHT&returnTo=https%3A%2F%2Fevil.example%2Fsteal",
      { waitUntil: "domcontentloaded" },
    );
    const appOrigin = new URL(page.url()).origin;

    const content = page.locator('[data-slot="responsive-sheet-content"]');
    await content.locator("#value").fill("78.4");
    await page
      .getByRole("button", { name: /save|speichern/i })
      .last()
      .click();

    await expect(content).toHaveCount(0);
    const settled = new URL(page.url());
    expect(settled.origin).toBe(appOrigin);
    expect(settled.pathname).toBe("/measurements");
  });

  test("unknown ?add value is dropped silently and the page renders empty", async ({
    page,
  }) => {
    await page.goto("/measurements?add=NOT_A_TYPE", {
      waitUntil: "domcontentloaded",
    });

    // Primitive must NOT open — unknown types are dropped silently.
    const content = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(content).toHaveCount(0, { timeout: 5_000 });

    // URL still settles on the bare list.
    await expect.poll(() => new URL(page.url()).search).toBe("");
  });
});
