import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { mockDashboardSnapshot } from "./utils/mock-dashboard-snapshot";
import { mockPopulatedInsights } from "./utils/mock-populated-insights";
import {
  expectNoHorizontalOverflow,
  measureHorizontalOverflow,
  PHONE_WIDTHS,
  settleForOverflowMeasurement,
} from "./utils/horizontal-overflow";
import { revealDeferredSections } from "./utils/deferred-sections";

/**
 * The content-heavy routes must not scroll sideways at any phone width.
 *
 * This replaces a per-surface habit of asserting
 * `documentElement.scrollWidth <= innerWidth` on whatever happened to render.
 * That assertion had two holes, and a real report walked through both:
 *
 *   1. It measured the DOCUMENT. `AuthShell` scrolls inside
 *      `<main id="main-content">`, whose `overflow-y:auto` makes `overflow-x`
 *      compute to `auto` — so an over-wide child grows `main.scrollWidth`, the
 *      user pans the page sideways, and the document never widens by a pixel.
 *   2. It ran against an EMPTY page. A surface with no content fits any
 *      viewport, so the guard proved nothing about the surface people use.
 *
 * `expectNoHorizontalOverflow` closes (1) by asserting both scroll areas and
 * naming the widest offending element on failure. The fixtures below close (2)
 * by giving each route a body before it is measured.
 *
 * Widths cover real iPhone (390 / 393 / 402 / 430) and common Android (360)
 * CSS widths — a single width hides anything whose overflow is width-dependent.
 * Runs on `chromium-mobile` only; the desktop project skips the whole file.
 */

interface RouteCase {
  path: string;
  /** Something that must be on-screen before measuring — proves it is populated. */
  ready: string;
  setup?: (page: import("@playwright/test").Page) => Promise<void>;
}

const ROUTE_CASES: RouteCase[] = [
  {
    path: "/insights",
    // The "signals of the day" section is the one whose heading carries the
    // long provenance sentence, so it is also the readiness signal.
    ready: '[data-slot="coincident-deviation-section"]',
    setup: mockPopulatedInsights,
  },
  {
    path: "/",
    ready: "main#main-content",
    setup: (page) => mockDashboardSnapshot(page),
  },
  { path: "/measurements", ready: "main#main-content" },
  { path: "/medications", ready: "main#main-content" },
];

test.describe("content-heavy routes have no horizontal page scroll at phone widths", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  for (const routeCase of ROUTE_CASES) {
    test(`${routeCase.path} does not scroll sideways on any phone width`, async ({
      page,
    }) => {
      await routeCase.setup?.(page);

      for (const width of PHONE_WIDTHS) {
        await page.setViewportSize({ width, height: 851 });
        await page.goto(routeCase.path, { waitUntil: "domcontentloaded" });
        // Measure the whole page, the overview sections that wait for the
        // viewport included, or a wide card far down would go unmeasured.
        if (routeCase.path === "/insights") await revealDeferredSections(page);
        await expect(page.locator(routeCase.ready).first()).toBeVisible();
        await settleForOverflowMeasurement(page);
        await expectNoHorizontalOverflow(page, `${routeCase.path} @${width}px`);
      }
    });
  }

  /**
   * The fixture itself has to stay honest. If `mockPopulatedInsights` ever
   * stops populating the overview — a renamed route, a changed envelope — the
   * width assertions above would keep passing against an empty page and the
   * guard would quietly go back to proving nothing. Assert the page is
   * actually carrying content, so fixture rot fails loudly instead.
   */
  test("the /insights fixture really populates the overview", async ({
    page,
  }) => {
    await mockPopulatedInsights(page);
    await page.setViewportSize({ width: 390, height: 851 });
    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    await revealDeferredSections(page);

    const signals = page.locator('[data-slot="coincident-deviation-section"]');
    await expect(signals).toBeVisible();

    // The prose in the heading's trailing action slot — the shape that widened
    // the page. It must be present AND long enough to be able to.
    const method = signals.locator('[data-slot="provenance-explainer-method"]');
    await expect(method).toBeVisible();
    const text = (await method.textContent()) ?? "";
    expect(
      text.length,
      `provenance caption too short to exercise the overflow class: "${text}"`,
    ).toBeGreaterThan(60);

    // And the surface as a whole is not the empty state.
    await expect(
      page.locator('[data-slot="section-heading"]').first(),
    ).toBeVisible();
    const headingCount = await page
      .locator('[data-slot="section-heading"]')
      .count();
    expect(headingCount, "overview rendered no sections").toBeGreaterThan(1);
  });

  /**
   * A long trailing caption must WRAP inside the row, not extend it. Asserting
   * the wrap directly (rather than only the page-level width) pins the fix at
   * the element that broke: a `shrink-0` action slot sized itself to the
   * caption's max-content width, ~1.2-1.5k px depending on locale.
   */
  test("a long heading action caption wraps instead of widening the row", async ({
    page,
  }) => {
    await mockPopulatedInsights(page);
    await page.setViewportSize({ width: 390, height: 851 });
    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    await revealDeferredSections(page);

    // Wait on the CAPTION, not the heading: the card first paints a skeleton
    // whose heading carries no action slot, then swaps to the resolved shell.
    // Both render `[data-slot="section-heading"]`, so gating on the heading
    // alone can measure the skeleton — or measure nothing at all, because the
    // element detaches during the swap.
    const method = page
      .locator(
        '[data-slot="coincident-deviation-section"] [data-slot="provenance-explainer-method"]',
      )
      .first();
    await expect(method).toBeVisible();

    // Read both rects in ONE evaluate so the swap cannot land between them.
    const box = await method.evaluate((el) => {
      const headingEl = el.closest('[data-slot="section-heading"]');
      if (!headingEl) return null;
      const caption = el.getBoundingClientRect();
      const heading = headingEl.getBoundingClientRect();
      return {
        captionWidth: caption.width,
        headingWidth: heading.width,
        viewportWidth: window.innerWidth,
      };
    });
    expect(box, "caption is not inside a section heading").not.toBeNull();

    expect(
      Math.round(box!.captionWidth),
      `caption width ${box!.captionWidth} exceeds its heading row ${box!.headingWidth} — the action slot is sizing to max-content instead of wrapping`,
    ).toBeLessThanOrEqual(Math.round(box!.headingWidth) + 1);
    expect(
      Math.round(box!.headingWidth),
      "heading row is wider than the viewport",
    ).toBeLessThanOrEqual(box!.viewportWidth);
  });

  /**
   * The helper must be able to SEE overflow through the `<main>` scroll
   * container — the exact blind spot that let the previous guard pass. Inject
   * a deliberately over-wide, un-contained block and assert the measurement
   * reports it. Without this, a helper that silently measured the wrong
   * element would make every assertion above vacuous.
   */
  test("the overflow measurement detects an over-wide block inside <main>", async ({
    page,
  }) => {
    await mockPopulatedInsights(page);
    await page.setViewportSize({ width: 390, height: 851 });
    await page.goto("/insights", { waitUntil: "domcontentloaded" });
    await revealDeferredSections(page);
    // Wait for the same readiness signal and settle step every route case
    // above uses. This was the one test in the file that measured and injected
    // straight after `domcontentloaded`, against a tree that was still
    // mounting, and it is the one that went flaky on CI: `main.scrollWidth`
    // came back at exactly `clientWidth` with a 1500px child supposedly in it.
    //
    // Two candidate mechanisms were checked against a local run rather than
    // assumed. A render swapping `main`'s children and taking the canary with
    // it does NOT happen: the node survives the skeleton-to-content swap
    // (12/12 runs, canary attached, scrollWidth 1500). That leaves `main` not
    // yet BEING the scroll container at injection time, which is what settling
    // rules out and what the assertions below now report on if it recurs.
    await expect(
      page.locator('[data-slot="coincident-deviation-section"]').first(),
    ).toBeVisible();
    await settleForOverflowMeasurement(page);

    const clean = await measureHorizontalOverflow(page);
    expect(clean.mainScrollWidth).toBeLessThanOrEqual(
      (clean.mainClientWidth ?? 0) + 1,
    );

    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.id = "overflow-canary";
      probe.style.width = "1500px";
      probe.style.height = "10px";
      document.querySelector("main#main-content")!.appendChild(probe);
    });

    // Separate the fixture's own failure from the helper's. If the canary is
    // not inside the CURRENT `main`, the measurement below proves nothing
    // either way, and a failure that says so is a diagnosis rather than an
    // accusation.
    await expect(
      page.locator("main#main-content #overflow-canary"),
      "the canary is not inside the current <main> — the fixture failed, not the helper",
    ).toBeAttached();

    // Captured so that a recurrence names its own cause instead of costing
    // another round of guessing. `overflowX: clip` or a `main` that is not a
    // scroll container both produce the observed "scrollWidth === clientWidth
    // with a 1500px child" and are indistinguishable without this.
    const state = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("main#main-content")!;
      const canary = document.getElementById("overflow-canary");
      const style = getComputedStyle(main);
      return {
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        canaryWidth: canary?.getBoundingClientRect().width ?? null,
        canaryInMain: canary ? main.contains(canary) : false,
      };
    });

    const dirty = await measureHorizontalOverflow(page);
    expect(
      dirty.mainScrollWidth,
      `an intentionally 1500px-wide block did not widen main's scroll area — main overflow-x:${state.overflowX} overflow-y:${state.overflowY}, canary width ${state.canaryWidth}, inside main: ${state.canaryInMain}`,
    ).toBeGreaterThan((dirty.mainClientWidth ?? 0) + 1);
    expect(
      dirty.offenders.some((o) => o.selector.includes("overflow-canary")),
      `the canary was not reported as an offender; got: ${dirty.offenders
        .map((o) => o.selector)
        .join(" | ")}`,
    ).toBe(true);
    // The document stayed exactly as wide as the viewport while `<main>` grew
    // by 1500px — this is the blind spot, asserted rather than described.
    expect(
      dirty.docScrollWidth,
      "document width changed, so the document-only assertion would have caught this after all",
    ).toBeLessThanOrEqual(dirty.innerWidth + 1);
  });
});
