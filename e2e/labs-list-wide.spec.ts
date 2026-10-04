import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";
import { MOBILE_ROUTES_ANALYTE } from "./setup/mobile-routes-fixture";
import {
  expectNoHorizontalOverflow,
  settleForOverflowMeasurement,
} from "./utils/horizontal-overflow";

/**
 * The lab list uses the width it has, at every width, inside a frame that does
 * not move.
 *
 * The signed-in frame is 1280 px wide on purpose, so a page never jumps
 * sideways when you move between routes. Inside it the compact list was one
 * five-column row whose only flexible column was the name: on a wide window the
 * name column sat mostly empty while the range bar and the trend stayed small
 * at the right edge. The columns now follow the width of the list's own card
 * (a container query), not the window's:
 *
 *   - below 64 rem of card the row is the `lg` table it always was, and the
 *     range bar keeps its 12 rem;
 *   - from 64 rem the bar follows its column up to 18 rem, and the trend
 *     column stays as wide as its 72 px sparkline.
 *
 * From `lg` a long name wraps instead of being cut off. The tiers are measured
 * on the card's width and not the viewport's, so the spec reads the card and
 * asserts the tier that width belongs to; a width at which no card ever reaches
 * 64 rem would otherwise pass the wide check by never running it.
 *
 * The account is the one `globalSetup` seeds for the mobile route sweep: a long
 * analyte name, readings with reference ranges. Desktop only; the phone layout
 * has its own specs.
 */

const WIDTHS = [1280, 1920, 3440] as const;
const REM = 16;
const BAR = '[data-slot="lab-reference-range-bar"]';

test.describe("the lab list uses its width", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "desktop-only spec",
    );
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "de", url: baseURL },
    ]);
  });

  for (const width of WIDTHS) {
    test(`at ${width} px: no sideways scroll, names read in full, the bar follows its tier`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/labs", { waitUntil: "domcontentloaded" });
      const names = page.locator('[data-slot="lab-list-analyte"]');
      await expect(names.first()).toBeVisible();
      await settleForOverflowMeasurement(page);

      await expectNoHorizontalOverflow(page, `/labs at ${width}px`);

      // The long name is the point of the wrap: it is fully on screen.
      const long = page
        .locator('[data-slot="lab-list-analyte"]')
        .filter({ hasText: MOBILE_ROUTES_ANALYTE });
      await expect(long.first()).toBeVisible();
      const clipped = await names.evaluateAll(
        (nodes) =>
          nodes.filter((node) => node.scrollWidth > node.clientWidth + 1)
            .length,
      );
      expect(clipped, "an analyte name is cut off").toBe(0);

      const cardWidth = await page
        .locator('[data-slot="lab-list"] [data-slot="card"]')
        .first()
        .evaluate((node) => node.getBoundingClientRect().width);
      const bars = page.locator(BAR);
      expect(await bars.count()).toBeGreaterThan(0);
      const barWidths = await bars.evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().width),
      );

      if (cardWidth < 64 * REM) {
        // The narrow tier: exactly what the list had, 12 rem.
        for (const w of barWidths) expect(Math.round(w)).toBe(12 * REM);
      } else {
        // The wide tier: wider than 12 rem, no wider than its column's cap.
        for (const w of barWidths) {
          expect(w).toBeGreaterThan(12 * REM);
          expect(w).toBeLessThanOrEqual(18 * REM + 1);
        }
      }

      // The trend column is exactly as wide as the sparkline it holds, in both
      // tiers. The sparkline is a fixed 72 px glyph; a wider column would only
      // open an empty strip between it and the chevron.
      const tracks = await page
        .locator('[data-slot="lab-list"] [data-slot="card-content"]')
        .first()
        .evaluate((node) => getComputedStyle(node).gridTemplateColumns);
      const trendTrack = tracks.split(" ")[3];
      expect(trendTrack, `trend column in "${tracks}"`).toBe("72px");

      // The widest windows must actually reach the wide tier, or the branch
      // above never ran.
      if (width >= 1920) {
        expect(
          cardWidth,
          "the card never reached 64 rem",
        ).toBeGreaterThanOrEqual(64 * REM);
      }
    });
  }

  test("the frame is the same width on /labs, /measurements and /mood at every viewport", async ({
    page,
  }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      const frameWidths: Record<string, number> = {};
      for (const path of ["/labs", "/measurements", "/mood"]) {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        const frame = page.locator('[data-slot="main-content-wrapper"]');
        await expect(frame).toBeVisible();
        frameWidths[path] = Math.round(
          await frame.evaluate((node) => node.getBoundingClientRect().width),
        );
      }
      const widths = Object.values(frameWidths);
      expect(
        new Set(widths).size,
        `the frame differs between routes at ${width}px: ${JSON.stringify(frameWidths)}`,
      ).toBe(1);
    }
  });
});
