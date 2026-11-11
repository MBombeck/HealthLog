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
 *   2. A tap on a link to another page keeps the open page and repeats the
 *      hint, instead of trading the readable page for the offline one.
 *   3. Opening a page without a connection (a typed URL, a cold start) gets
 *      the worker's offline page: the word "Offline" and a working retry
 *      control, never the browser's error. Signed-in pages are never cached:
 *      the proxy pins `private, no-store` on them because some carry the
 *      record in the HTML.
 *   4. When the connection returns, that page reloads into the app by
 *      itself.
 *
 * The account is the populated mobile-sweep account; nothing here writes.
 */
test.describe("offline, with the service worker", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test("an open page stays readable offline, a new one opens the offline page, and both recover @critical", async ({
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

      // A tap on the dashboard link stays on the open page.
      await page.locator('a[href="/"]:visible').first().click();
      await expect(
        page
          .locator("[data-sonner-toast]")
          .filter({ hasText: "other pages open once you're back online" }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/medications");
      await expect(page.locator("#main-content")).toBeVisible();

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
