import type { Page } from "@playwright/test";

import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";
import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The phone shell's edges in an installed iOS app, in WebKit.
 *
 * An installed app on iOS 26 and 27 can be handed a layout viewport that is
 * short of the screen by the status bar's height: it starts at the top of the
 * screen, and everything sized or anchored to it (the shell, the bottom bar,
 * the Coach button) ends that far above the screen's bottom edge. What shows
 * in the strip below is the root's background. A browser under test is never
 * handed that viewport and reports no safe-area inset, so this file builds
 * both by hand:
 *
 *   - the insets through the properties the shell reads them from
 *     (`--safe-area-top` / `--safe-area-bottom`, globals.css), which is what
 *     `env()` feeds on a device;
 *   - the short viewport by lifting what is anchored to it (the document's
 *     boxes, the shell, the fixed bar and button) by the strip's height, so
 *     the strip under them shows the root's background exactly as on iOS.
 *
 * It then reads the screenshot's pixels: the strip is the bar's colour, the
 * status-bar band is the top bar's colour (dark theme; the light theme paints
 * that band in ink on purpose, for the white status-bar text), and the last
 * line of the page scrolls clear of the Coach button.
 */

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

/** iPhone with a Dynamic Island: status bar and home indicator, CSS px. */
const INSET_TOP = 59;
const INSET_BOTTOM = 34;
/** The strip iOS leaves out of the layout: the status bar's height. */
const SHORT_BY = INSET_TOP;

test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

async function applyTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((value: string) => {
    window.localStorage.setItem("healthlog-theme", value);
  }, theme);
}

async function simulateInstalledIphone(page: Page) {
  await page.addStyleTag({
    content: `
      :root {
        --safe-area-top: ${INSET_TOP}px !important;
        --safe-area-bottom: ${INSET_BOTTOM}px !important;
      }
      html[data-scroll="shell"],
      html[data-scroll="shell"] body {
        height: calc(100% - ${SHORT_BY}px) !important;
      }
      [data-slot="app-shell"] {
        bottom: ${SHORT_BY}px !important;
      }
      [data-slot="bottom-nav"],
      [data-slot="coach-fab"] {
        margin-bottom: ${SHORT_BY}px !important;
      }
    `,
  });
  // The simulation holds: the bar ends a strip above the screen's edge.
  const height = page.viewportSize()!.height;
  await expect
    .poll(() =>
      page
        .locator('[data-slot="bottom-nav"]')
        .evaluate((el) => Math.round(el.getBoundingClientRect().bottom)),
    )
    .toBe(height - SHORT_BY);
}

type Rgb = [number, number, number];

/** The colours of the screenshot at the given points. */
async function pixels(
  page: Page,
  points: ReadonlyArray<{ x: number; y: number }>,
): Promise<Rgb[]> {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const scale = image.naturalWidth / innerWidth;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return points.map(({ x, y }) => {
        const [r, g, b] = ctx.getImageData(
          Math.floor(x * scale),
          Math.floor(y * scale),
          1,
          1,
        ).data;
        return [r, g, b] as Rgb;
      });
    },
    { png, points },
  );
}

function expectSameColour(actual: Rgb, expected: Rgb, what: string) {
  const off = Math.max(...actual.map((c, i) => Math.abs(c - expected[i])));
  expect(off, `${what}: ${actual} against ${expected}`).toBeLessThanOrEqual(1);
}

async function openDashboard(page: Page) {
  // The Coach button shows where the Coach can answer.
  await serveAiBlock(page, aiBlockAvailable());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('#main-content [data-slot="main-content-wrapper"]'),
  ).toBeVisible();
  await expect(page.locator('[data-slot="bottom-nav"]')).toBeVisible();
  await expect(page.locator('[data-slot="coach-fab"]')).toBeVisible();
  // The shell is in place once AuthShell has flagged the document.
  await expect(page.locator("html")).toHaveAttribute("data-scroll", "shell");
}

/** Scrolls `<main>` to its end, waiting out content that grows on the way. */
async function scrollMainToEnd(page: Page) {
  let last = -1;
  for (let i = 0; i < 12; i += 1) {
    const height = await page.evaluate(() => {
      const main = document.getElementById("main-content")!;
      main.scrollTop = main.scrollHeight;
      return main.scrollHeight;
    });
    if (height === last) return;
    last = height;
    await page.waitForTimeout(300);
  }
}

for (const viewport of VIEWPORTS) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${viewport.width}x${viewport.height}, ${theme}`, () => {
      test.use({ viewport });

      test("the bar's surface reaches the screen's bottom edge", async ({
        page,
      }, testInfo) => {
        await applyTheme(page, theme);
        await openDashboard(page);
        await simulateInstalledIphone(page);

        const bar = await page
          .locator('[data-slot="bottom-nav"]')
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          });
        await page.screenshot({
          path: testInfo.outputPath(
            `bottom-edge-${viewport.width}-${theme}.png`,
          ),
        });

        const mid = bar.top + (bar.bottom - bar.top) / 2;
        // 8 px in from either side: past the slots' hit areas, inside the bar.
        const [barLeft, barRight, stripLeft, stripRight, edgeLeft, edgeRight] =
          await pixels(page, [
            { x: 8, y: mid },
            { x: viewport.width - 8, y: mid },
            { x: 8, y: bar.bottom + SHORT_BY / 2 },
            { x: viewport.width - 8, y: bar.bottom + SHORT_BY / 2 },
            { x: 8, y: viewport.height - 1 },
            { x: viewport.width - 8, y: viewport.height - 1 },
          ]);
        expectSameColour(stripLeft, barLeft, "strip under the bar, left");
        expectSameColour(stripRight, barRight, "strip under the bar, right");
        expectSameColour(edgeLeft, barLeft, "screen's last row, left");
        expectSameColour(edgeRight, barRight, "screen's last row, right");
      });

      test("the status-bar band and the top bar are one surface", async ({
        page,
      }) => {
        test.skip(
          theme === "light",
          "the light theme paints the band in ink for the white status-bar text",
        );
        await applyTheme(page, theme);
        await openDashboard(page);
        await simulateInstalledIphone(page);

        const header = await page
          .locator('[data-slot="top-bar"]')
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          });
        // The shell takes the status bar's inset above the top bar.
        expect(Math.round(header.top)).toBe(INSET_TOP);

        const [band, bar] = await pixels(page, [
          { x: 8, y: INSET_TOP / 2 },
          { x: 8, y: header.top + (header.bottom - header.top) / 2 },
        ]);
        expectSameColour(band, bar, "status-bar band against the top bar");
      });

      test("the last line of the page scrolls clear of the Coach button", async ({
        page,
      }) => {
        await applyTheme(page, theme);
        await openDashboard(page);
        await simulateInstalledIphone(page);
        await scrollMainToEnd(page);

        const m = await page.evaluate(() => {
          const wrapper = document.querySelector<HTMLElement>(
            '#main-content [data-slot="main-content-wrapper"]',
          )!;
          const fab = document
            .querySelector('[data-slot="coach-fab"]')!
            .getBoundingClientRect();
          const bar = document
            .querySelector('[data-slot="bottom-nav"]')!
            .getBoundingClientRect();
          const last = wrapper.lastElementChild!.getBoundingClientRect();
          return {
            lastBottom: last.bottom,
            fabTop: fab.top,
            fabBottom: fab.bottom,
            barTop: bar.top,
          };
        });
        // The button floats above the bar, and the page's end sits above
        // the button with room to spare.
        expect(m.fabBottom).toBeLessThan(m.barTop);
        expect(m.fabTop - m.lastBottom).toBeGreaterThanOrEqual(12);
      });
    });
  }
}
