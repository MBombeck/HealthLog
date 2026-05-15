import { expect, test } from "@playwright/test";

/**
 * v1.4.27 MB6 — public surfaces.
 *
 * Three contracts under test, all reachable without a session:
 *
 *   1. `/about` — added to `PUBLIC_PATHS` in `src/proxy.ts` for the
 *      GeoLite2 CC BY-SA 4.0 attribution. A logged-out visitor must
 *      load the page (HTTP 200) and see the attribution copy.
 *   2. `/this-route-does-not-exist` — Next.js renders
 *      `src/app/not-found.tsx`, a branded 404 page with the logo, a
 *      headline, and a "Back to dashboard" link. The proxy must NOT
 *      bounce the missing route to `/auth/login`.
 *   3. `/privacy` — the page mounts a collapsible `<details>` TOC
 *      (`data-slot="privacy-toc"`); clicking the summary opens it
 *      and the anchor links inside navigate to the right section.
 *
 * Specs intentionally do NOT use the authenticated storage state —
 * the test suite needs to prove the routes work for first-time
 * visitors and App-Store reviewers.
 */
test.describe("v1.4.27 — public pages", () => {
  // Force no storage state so we run as an anonymous visitor.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/about returns 200 and renders the GeoLite2 attribution", async ({
    page,
  }) => {
    const response = await page.goto("/about", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    // No bounce to the login page.
    expect(page.url()).toMatch(/\/about(\?|$)/);

    await expect(page.getByRole("heading", { name: /about/i }).first()).toBeVisible();

    // GeoLite2 attribution is the load-bearing reason this page exists.
    await expect(page.getByText(/GeoLite2/)).toBeVisible();
    await expect(page.getByText(/MaxMind/)).toBeVisible();
    await expect(
      page.getByText(/Attribution-ShareAlike 4\.0/i),
    ).toBeVisible();
  });

  test("/this-route-does-not-exist renders the branded 404 page", async ({
    page,
  }) => {
    const response = await page.goto("/this-route-does-not-exist", {
      waitUntil: "domcontentloaded",
    });
    // Next.js returns 404 for `not-found.tsx` — the page must render
    // its own body, not redirect to `/auth/login`.
    expect(response?.status()).toBe(404);
    expect(page.url()).not.toMatch(/\/auth\/login/);

    // Branded splash: small "404" eyebrow + headline + back link.
    await expect(page.getByText(/^404$/i)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /page not found/i }),
    ).toBeVisible();

    const back = page.getByRole("link", { name: /back to dashboard/i });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "/");
  });

  test("/privacy renders the TOC and the anchor links jump to sections", async ({
    page,
  }) => {
    const response = await page.goto("/privacy", {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    const toc = page.locator('[data-slot="privacy-toc"]');
    await expect(toc).toBeVisible();

    // <details> defaults to closed. Toggling the summary opens it.
    const isOpenBefore = await toc.evaluate(
      (el) => (el as HTMLDetailsElement).open,
    );
    expect(isOpenBefore).toBe(false);

    await toc.locator("summary").click();
    const isOpenAfter = await toc.evaluate(
      (el) => (el as HTMLDetailsElement).open,
    );
    expect(isOpenAfter).toBe(true);

    // Clicking a TOC anchor scrolls the matching section into view.
    // We assert the URL hash settles and the target section's heading
    // is visible inside the viewport.
    const intro = toc.locator('a[href="#intro"]').first();
    await expect(intro).toBeVisible();
    await intro.click();

    await expect.poll(() => page.url()).toMatch(/#intro$/);

    const introSection = page.locator("#intro");
    await expect(introSection).toBeVisible();
    // scroll-mt-28 leaves the section clear of the sticky header —
    // assert the section's top is inside the viewport.
    const introTop = await introSection.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    expect(introTop).toBeGreaterThanOrEqual(0);
    expect(introTop).toBeLessThan(800);
  });
});
