import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * What the installed app shows without a connection, with the service worker
 * actually running.
 *
 * Runs in the `chromium-service-worker` project, the one that lets the worker
 * register (every other project blocks it; see `playwright.config.ts`), and
 * like the other spec there it uses no route mocks: the claim is about what
 * the worker itself serves.
 *
 *   1. A page that is open when the connection drops stays the app and says
 *      so (the offline strip).
 *   2. Opening a page without a connection gets the worker's offline page:
 *      the word "Offline" and a working retry control, never the browser's
 *      error. (Signed-in pages are never cached, by design: the proxy pins
 *      `private, no-store` on them because some carry the record in the
 *      HTML. So this is what an offline launch of the installed app shows.)
 *   3. When the connection returns, that page reloads into the app by
 *      itself.
 *
 * The account is the populated mobile-sweep account; nothing here writes.
 */
test.describe("offline, with the service worker", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test("an open page says it is offline, a new one opens the offline page, and both recover", async ({
    page,
    context,
  }) => {
    await page.goto("/medications");
    await page.waitForFunction(
      () => navigator.serviceWorker?.controller !== null,
      undefined,
      { timeout: 20_000 },
    );
    await expect(page.locator("#main-content")).toBeVisible();
    await page.waitForLoadState("networkidle");

    try {
      await context.setOffline(true);
      await expect(page.locator('[data-slot="offline-banner"]')).toBeVisible();

      const response = await page.goto("/timeline");
      expect(response?.status()).toBe(503);
      await expect(page.getByText("Offline", { exact: true })).toBeVisible();
      const retry = page.getByRole("link", { name: "Reload" });
      await expect(retry).toBeVisible();
      const box = (await retry.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);

      // Back online: the offline page reloads itself into the app.
      const reloaded = page.waitForEvent("load");
      await context.setOffline(false);
      await reloaded;
      await expect(page.locator("#main-content")).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/timeline");
    } finally {
      await context.setOffline(false);
    }
  });
});
