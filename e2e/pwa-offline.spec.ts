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

  test("a public page opened signed in is no-store and never comes back offline @critical", async ({
    page,
    context,
  }) => {
    // `/about` is public, but rendered for a session it is the session's
    // document: `private, no-store`, no page-cache permit, and so nothing the
    // worker could replay after the session ends.
    await page.goto("/medications");
    await page.waitForFunction(
      () => navigator.serviceWorker?.controller !== null,
      undefined,
      { timeout: 20_000 },
    );
    const about = await page.goto("/about");
    expect(about?.status()).toBe(200);
    expect(about?.headers()["cache-control"]).toContain("no-store");
    expect(about?.headers()["x-healthlog-page-cache"]).toBeUndefined();
    // The page has rendered (and the worker has seen its response) before
    // the cache is read.
    await expect(page.getByRole("heading").first()).toBeVisible();
    await page.waitForLoadState("networkidle");

    const cachedAbout = await page.evaluate(async () => {
      const names = await caches.keys();
      for (const name of names.filter((n) =>
        n.startsWith("healthlog-pages-"),
      )) {
        const hit = await (await caches.open(name)).match("/about");
        if (hit) return true;
      }
      return false;
    });
    expect(cachedAbout).toBe(false);

    try {
      await context.setOffline(true);
      const offline = await page.goto("/about");
      expect(offline?.status()).toBe(503);
      await expect(page.getByText("Offline", { exact: true })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
