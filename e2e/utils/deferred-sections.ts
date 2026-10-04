import { expect, type Page } from "@playwright/test";

/**
 * Mount every overview section that waits for the viewport.
 *
 * Sections below the first screens of `/insights` render as a 1 px
 * `[data-deferred-section]` sentinel until they come near the visible area
 * (`src/components/insights/defer-until-near.tsx`). A spec that asserts on
 * one of them, or measures or scans the whole page, scrolls each sentinel
 * into view first, the way a reader would, until none is left. Polled, since
 * the observers only exist once the page has hydrated.
 */
export async function revealDeferredSections(page: Page): Promise<void> {
  // The sentinels render with the overview itself; until the hero is there,
  // "no sentinel" only means the page has not rendered yet.
  await expect(page.locator('[data-slot="insights-hero-strip"]')).toBeAttached({
    timeout: 20_000,
  });
  const sentinels = page.locator("[data-deferred-section]");
  await expect
    .poll(
      async () => {
        const remaining = await sentinels.count();
        if (remaining > 0) {
          await sentinels
            .first()
            .scrollIntoViewIfNeeded({ timeout: 1_000 })
            .catch(() => {
              // Mounted between the count and the scroll.
            });
        }
        return remaining;
      },
      { timeout: 20_000 },
    )
    .toBe(0);
  await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 0));
}

/**
 * `revealDeferredSections`, then wait until the reads the newly mounted
 * sections fired have landed: no request in flight for 750 ms. A
 * `waitForLoadState("networkidle")` cannot do this: the page reached that
 * state once already, so it resolves at once, and a count of zero taken then
 * passes before a deferred section has painted anything.
 */
export async function revealDeferredSectionsSettled(page: Page): Promise<void> {
  let inFlight = 0;
  const started = () => {
    inFlight += 1;
  };
  const ended = () => {
    inFlight -= 1;
  };
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  try {
    await revealDeferredSections(page);
    let quietSince = Date.now();
    await expect
      .poll(
        () => {
          if (inFlight > 0) quietSince = Date.now();
          return Date.now() - quietSince >= 750;
        },
        { timeout: 20_000, intervals: [100] },
      )
      .toBe(true);
  } finally {
    page.off("request", started);
    page.off("requestfinished", ended);
    page.off("requestfailed", ended);
  }
}
