import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { SSR_PREFETCH_BASE_URL } from "./setup/ssr-prefetch-server";

/**
 * The dashboard survives hydration in the configuration that ships.
 *
 * `/` is an RSC wrapper that runs the dashboard's reads server-side and hands
 * them to TanStack through a `HydrationBoundary` (`src/app/page.tsx`), so the
 * first HTML already carries real tiles. It only does that when
 * `DASHBOARD_SSR_PREFETCH` is not `"false"` — which is the default, and
 * therefore what every self-hoster runs.
 *
 * The rest of the suite runs against a server with that flag OFF, because the
 * dashboard specs drive their fixtures through `page.route` and a route mock
 * only sees client fetches. So nothing here ever exercised the shipped path,
 * and a React #418 hydration bailout sat on `/` for a signed-in account on
 * every cold load: the app shell hydrates first and its queries answer before
 * the streamed dashboard boundary hydrates, so the dashboard's first CLIENT
 * render read an account payload (and an achievements payload, and its own
 * in-flight tiles) the server never had. React threw the streamed tree away
 * and rebuilt it — paying for the prefetch and delivering none of it.
 *
 * This spec talks to the second server (`SSR_PREFETCH_BASE_URL`, prefetch ON,
 * no route mocks, the real seeded account) and asserts two things a mocked
 * spec cannot:
 *
 *  1. the browser reports no hydration error at all;
 *  2. the tile node the SERVER streamed is still the same DOM node once the
 *     page settles. A bailout re-creates it, so node identity is the honest
 *     witness that the server's work survived instead of being re-done. The
 *     probe only reads identity — writing a marker attribute onto server HTML
 *     would be a hydration mismatch of its own making.
 *
 * Runs on both viewport projects, because the defect reproduced on both.
 */
declare global {
  interface Window {
    __ssrTileWitness?: { seen: boolean; replaced: number };
  }
}

test.describe("dashboard hydration with the SSR prefetch on", () => {
  test.use({
    storageState: STORAGE_STATE_PATH,
    baseURL: SSR_PREFETCH_BASE_URL,
  });

  test("streams the dashboard and keeps it through hydration", async ({
    page,
  }) => {
    const clientErrors: string[] = [];
    page.on("pageerror", (error) => clientErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") clientErrors.push(message.text());
    });

    // `addInitScript` runs before any page script, so the poll is armed for
    // the very first frame and latches the node React hydrated into.
    await page.addInitScript(() => {
      const witness = { seen: false, replaced: 0 };
      window.__ssrTileWitness = witness;
      let node: Element | null = null;
      const poll = () => {
        const el = document.querySelector('[data-slot="dashboard-tile-strip"]');
        if (el) {
          if (!node) witness.seen = true;
          else if (node !== el) witness.replaced += 1;
          node = el;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });

    await page.goto("/");

    const strip = page.locator('[data-slot="dashboard-tile-strip"]');
    await expect(strip).toBeVisible();
    // The seeded account owns one weight reading, so the strip carries a real
    // tile — proof the prefetch populated this render rather than the client
    // having filled it in after mount.
    await expect(
      strip.locator('[data-slot="dashboard-tile-link"]').first(),
    ).toBeVisible();

    // Let every boundary hydrate and every post-mount refetch land before the
    // verdict; a bailout that happens late is still a bailout.
    await page.waitForLoadState("networkidle");

    expect(
      clientErrors.filter((message) => /418|hydrat/i.test(message)),
    ).toEqual([]);

    const witness = await page.evaluate(() => window.__ssrTileWitness);
    expect(witness?.seen).toBe(true);
    expect(witness?.replaced).toBe(0);
  });

  // The two list-page prefetch wrappers (`/care`, `/mood`) hand TanStack a
  // server-dehydrated state through the same HydrationBoundary mechanism the
  // dashboard uses. Their page-clients render behind a `useMounted` gate, so
  // the streamed HTML is the auth-gate shell by design — the node-identity
  // witness has nothing to latch. What CAN break, and what these assert, is
  // the hydration itself: a dehydrated state that disagrees with the client
  // render surfaces as a React #418 bailout on exactly this server (the
  // mocked suite runs with the prefetch OFF and can never see it).
  for (const target of [
    {
      path: "/care",
      name: "care",
      readySelector: '[data-testid="checkups-tab-vorsorge"]',
    },
    {
      path: "/mood",
      name: "mood",
      readySelector: '[data-tour-id="mood-hero"]',
    },
  ]) {
    test(`hydrates ${target.name} with its prefetched list state`, async ({
      page,
    }) => {
      const clientErrors: string[] = [];
      page.on("pageerror", (error) => clientErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") clientErrors.push(message.text());
      });

      await page.goto(target.path);
      await expect(page.locator(target.readySelector)).toBeVisible();
      // Let every boundary hydrate and every post-mount refetch land before
      // the verdict; a bailout that happens late is still a bailout.
      await page.waitForLoadState("networkidle");

      expect(
        clientErrors.filter((message) => /418|hydrat/i.test(message)),
      ).toEqual([]);
    });
  }
});
