import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.27 R3d MB1 — `<ResponsiveSheet>` primitive branch coverage.
 *
 * The primitive renders as a bottom-anchored `<Sheet>` on `<md` (768
 * px) viewports and as a centred `<Dialog>` on `>=md`. Every primary
 * form (Measurement, Mood, Medication) now mounts through the
 * primitive — opening the Add-Measurement dialog from `/measurements`
 * exercises the path end-to-end.
 *
 * The spec scopes itself by project name (Pixel 5 mobile vs Desktop
 * Chrome) and asserts on the `data-variant` attribute that the
 * primitive stamps onto its content node (`sheet` on `<md`,
 * `dialog` on `>=md`). The sticky-footer pin only exists on the
 * Sheet branch — assert it carries the documented sticky class.
 */
test.describe("v1.4.27 — ResponsiveSheet branch", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Empty analytics + list keeps the page fast and deterministic.
    // v1.4.39.3 — regex form matches `/api/analytics` AND any sliced
    // variant (`?slice=summaries`) the v1.4.39.2 dashboard split fires.
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

  test("Pixel 5: Add-Measurement mounts as a bottom Sheet with sticky footer", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "Pixel 5 mobile-only branch",
    );

    await page.goto("/measurements?add=WEIGHT", {
      waitUntil: "domcontentloaded",
    });

    const content = page.locator(
      '[data-slot="responsive-sheet-content"]',
    );
    await expect(content).toBeVisible({ timeout: 10_000 });
    await expect(content).toHaveAttribute("data-variant", "sheet");

    // Sticky footer slot lives inside the Sheet branch. The primitive
    // pins it via `sticky bottom-0` — assert the class is present.
    const footer = page.locator('[data-slot="responsive-sheet-footer"]');
    await expect(footer).toBeAttached();
    const footerClass = (await footer.getAttribute("class")) ?? "";
    expect(footerClass).toMatch(/sticky/);
    expect(footerClass).toMatch(/bottom-0/);
  });

  test("Desktop Chrome: Add-Measurement mounts as a centred Dialog", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "desktop-only branch",
    );

    await page.goto("/measurements?add=WEIGHT", {
      waitUntil: "domcontentloaded",
    });

    const content = page.locator(
      '[data-slot="responsive-sheet-content"]',
    );
    await expect(content).toBeVisible({ timeout: 10_000 });
    await expect(content).toHaveAttribute("data-variant", "dialog");
  });
});
