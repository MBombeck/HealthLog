import { expect, test } from "@playwright/test";

/**
 * The proxy at src/proxy.ts is the single gate enforcing auth on every
 * non-public path. A regression that accidentally adds a route to
 * PUBLIC_PATHS, or breaks the redirect, would expose unauthenticated
 * surfaces. Verify a few representative routes round-trip to /auth/login.
 */
test.describe("proxy auth gate", () => {
  for (const path of [
    "/",
    "/dashboard",
    "/medications",
    "/admin",
    "/insights",
  ]) {
    test(`${path} redirects to /auth/login when no session`, async ({
      page,
    }) => {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(response).not.toBeNull();
      // Either the proxy hands back a 307/308, or the navigation lands
      // at /auth/login after redirect; both are acceptable proof.
      expect(page.url()).toMatch(/\/auth\/login(\?|$)/);
    });
  }

  test("public paths are reachable without a session", async ({ page }) => {
    // /auth/login is in PUBLIC_PATHS — must be served, not bounced anywhere.
    await page.goto("/auth/login");
    expect(page.url()).toMatch(/\/auth\/login(\?|$)/);
    await expect(page.locator("body")).toBeVisible();
  });
});
