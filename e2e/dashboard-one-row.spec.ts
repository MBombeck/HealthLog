import { expect, test } from "./setup/test";

import { orderStripWidgets } from "@/lib/dashboard/tile-priority";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  POPULATED_SUMMARIES,
  buildMockSnapshot,
} from "./utils/mock-dashboard-snapshot";

/**
 * The tile strip shows one row: as many tiles as fit the width, the ones
 * with something to say first, and the rest under "All values", which
 * opens in place and is stored in the layout.
 */
test.describe("dashboard tile strip, one row", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  const flat = POPULATED_SUMMARIES.WEIGHT;
  const summaries = {
    ...POPULATED_SUMMARIES,
    BODY_FAT: { ...flat, latest: 18, avg7: 18, avg30: 18 },
    SLEEP_DURATION: { ...flat, latest: 420, avg7: 430, avg30: 425 },
    ACTIVITY_STEPS: { ...flat, latest: 8000, avg7: 7900, avg30: 7800 },
    OXYGEN_SATURATION: { ...flat, latest: 97, avg7: 97, avg30: 97 },
    RESPIRATORY_RATE: { ...flat, latest: 15, avg7: 15, avg30: 15 },
  };

  test.beforeEach(async ({ page }) => {
    const snapshot = buildMockSnapshot({ summaries });
    // Steps has something to say: the server puts it at the front.
    snapshot.tiles.attention = { steps: "change" };
    snapshot.tiles.order = orderStripWidgets(snapshot.layout, {
      steps: "change",
    });
    await page.route(/\/api\/dashboard\/snapshot(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: snapshot, error: null }),
      }),
    );
  });

  test("a phone shows two tiles and opens the rest in place", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const saved: unknown[] = [];
    await page.route(/\/api\/dashboard\/widgets$/, async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      saved.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { version: 1 }, error: null }),
      });
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const strip = page.locator('[data-slot="dashboard-tile-strip"]');
    await expect(strip).toHaveAttribute("data-expanded", "false", {
      timeout: 15_000,
    });
    const tiles = strip.locator("[data-tile-id]");
    await expect(tiles.first()).toHaveAttribute("data-tile-id", "steps");
    // Blood pressure is one tile, systolic over diastolic.
    await expect(strip.locator('[data-tile-id="bp"]')).toHaveCount(1);
    await expect(strip.locator('[data-tile-id^="bp-"]')).toHaveCount(0);

    // One row: the front of the list, never a second row.
    const visible = strip.locator("[data-tile-id]:visible");
    // A phone shows two compact tiles side by side, never a single one.
    await expect(visible).toHaveCount(2);
    const tops = await visible.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)),
    );
    expect(new Set(tops).size).toBe(1);

    const toggle = page.locator('[data-slot="dashboard-tiles-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(strip).toHaveAttribute("data-expanded", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(visible).toHaveCount(await tiles.count());
    await expect
      .poll(() => saved)
      .toEqual([{ version: 1, tilesExpanded: true }]);
  });

  test("a wide screen has no switch when every tile fits", async ({ page }) => {
    await page.unroute(/\/api\/dashboard\/snapshot(\?|$)/);
    const snapshot = buildMockSnapshot();
    await page.route(/\/api\/dashboard\/snapshot(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: snapshot, error: null }),
      }),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const strip = page.locator('[data-slot="dashboard-tile-strip"]');
    await expect(strip).toBeVisible({ timeout: 15_000 });
    // Weight, blood pressure, pulse: one row with room to spare.
    await expect(strip.locator("[data-tile-id]:visible")).toHaveCount(3);
    await expect(
      page.locator('[data-slot="dashboard-tiles-toggle"]'),
    ).toBeHidden();
  });
});
