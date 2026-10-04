import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Expanding the sidebar must never flash a scrollbar on the nav list.
 *
 * The rail animates `width` from `w-16` to `w-64`. When the labels laid out
 * against the growing width, every row overran the 48 px nav and the
 * multi-word labels wrapped, so the nav's `overflow-y-auto` painted a
 * vertical and a horizontal scrollbar until the transition ended. The fix
 * lays the column out at its final width from the first frame and lets the
 * rail clip it (see `sidebar-column` in `src/components/layout/sidebar-nav.tsx`).
 *
 * This samples the nav on every animation frame of a real expand and a real
 * collapse, so it fails on the overflow itself rather than on a class name.
 * Desktop only: the sidebar is hidden below `md`.
 */
test.describe("sidebar width transition", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name === "chromium-mobile",
      "global sidebar is desktop-only (md+)",
    );
  });

  test("the nav list never overflows while the rail expands or collapses", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const toggle = page.locator('[data-slot="sidebar-collapse-toggle"]');
    await expect(toggle).toBeVisible();
    const nav = page.locator("aside nav").first();
    await expect(nav).toBeVisible();

    async function sampleToggle() {
      const heightBefore = await nav.evaluate((el) => el.scrollHeight);
      await page.evaluate(() => {
        const el = document.querySelector("aside nav") as HTMLElement;
        const samples: { sw: number; cw: number; sh: number }[] = [];
        (window as unknown as { __navSamples: typeof samples }).__navSamples =
          samples;
        const t0 = performance.now();
        const tick = () => {
          samples.push({
            sw: el.scrollWidth,
            cw: el.clientWidth,
            sh: el.scrollHeight,
          });
          if (performance.now() - t0 < 600) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await toggle.click();
      await page.waitForTimeout(700);
      const samples = await page.evaluate(
        () =>
          (
            window as unknown as {
              __navSamples: { sw: number; cw: number; sh: number }[];
            }
          ).__navSamples,
      );
      const heightAfter = await nav.evaluate((el) => el.scrollHeight);
      // Expanded rows are taller than rail rows, so the list may legitimately
      // be either rest height while the width moves, never more.
      return { samples, restHeight: Math.max(heightBefore, heightAfter) };
    }

    // Two round trips, so the run covers both directions whichever state
    // the stored preference started in.
    for (let i = 0; i < 4; i++) {
      const { samples, restHeight } = await sampleToggle();
      // A 200 ms transition yields several frames; too few means the
      // sampler never ran and the assertions below would prove nothing.
      expect(samples.length).toBeGreaterThan(5);
      for (const s of samples) {
        // No horizontal overflow: no row is wider than the nav.
        expect(s.sw).toBeLessThanOrEqual(s.cw + 1);
      }
      // No vertical growth: no label wraps mid-transition, so the list is
      // never taller than at rest and cannot summon a scrollbar.
      const tallest = Math.max(...samples.map((s) => s.sh));
      expect(tallest).toBeLessThanOrEqual(restHeight + 1);
    }
  });
});
