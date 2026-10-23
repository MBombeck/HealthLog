import type { Locator, Page } from "@playwright/test";

import { mockDay } from "./setup/day-mock";
import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The app shell on a tablet, under a finger, at every iPad size in both
 * orientations: the rail reaches every destination, `<main>` scrolls to its
 * last line, and closing a sheet or a dialog hands the scroll back.
 *
 * Runs in `webkit-tablet` (iPad, the engine an iPad runs; CI's WebKit job)
 * and `chromium-tablet` (an Android tablet, in the Chromium shards). Both
 * report `pointer: coarse`, so the rail keeps its 44 px rows and its list
 * overflows in landscape, which is the case that broke.
 *
 * What a browser under test cannot show is the iPadOS toolbar moving the
 * visible height away from `100dvh`; `shell-viewport.test.ts` holds the
 * decisions that take that disagreement out, and this file measures that the
 * shell they produce fills the window exactly and leaves the document
 * nothing to scroll or bounce.
 *
 * Stable hooks only: `sidebar-nav-region`, `sidebar-nav-scroll-cue`,
 * `sidebar-footer`, `main-content-wrapper`, `bottom-nav`,
 * `bottom-nav-more` (test id), `command-palette-trigger`,
 * `command-palette-input`, `day-panel`.
 */

/** iPad and Android tablet sizes, CSS px, with the browser's own bars where they take room. */
const VIEWPORTS = [
  { name: "iPad mini portrait", width: 744, height: 1133 },
  { name: "iPad mini landscape", width: 1133, height: 744 },
  { name: "iPad mini landscape, Safari bars", width: 1133, height: 670 },
  { name: "iPad landscape, Safari bars", width: 1000, height: 690 },
  { name: "iPad Air 11 portrait", width: 820, height: 1180 },
  { name: "iPad Air 11 landscape", width: 1180, height: 820 },
  { name: "iPad Pro 11 portrait", width: 834, height: 1194 },
  { name: "iPad Pro 11 landscape", width: 1194, height: 834 },
  { name: "iPad Pro 13 portrait", width: 1024, height: 1366 },
  { name: "iPad Pro 13 landscape", width: 1366, height: 1024 },
  { name: "Split View two thirds", width: 694, height: 1024 },
  { name: "Split View half, landscape", width: 590, height: 820 },
  { name: "Slide Over", width: 375, height: 1024 },
  { name: "Android tablet landscape", width: 1138, height: 712 },
] as const;

test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('#main-content [data-slot="main-content-wrapper"]'),
  ).toBeVisible();
  // The module-gated destinations join the rail once `/api/auth/me` lands.
  await expect(page.locator('aside nav a[href="/medications"]')).toHaveCount(1);
}

/** The shell fills the window exactly and the document has nothing to scroll. */
async function expectShellPinned(page: Page) {
  const m = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".shell-safe-area")!;
    const rect = shell.getBoundingClientRect();
    const root = document.scrollingElement!;
    const html = getComputedStyle(document.documentElement);
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      innerHeight,
      innerWidth,
      docScroll: root.scrollHeight - root.clientHeight,
      overflowY: html.overflowY,
      overscroll: html.overscrollBehaviorY,
    };
  });
  expect(m.top).toBe(0);
  expect(m.left).toBe(0);
  expect(Math.abs(m.bottom - m.innerHeight)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(m.right - m.innerWidth)).toBeLessThanOrEqual(0.5);
  expect(m.docScroll).toBeLessThanOrEqual(0);
  expect(m.overflowY).toBe("hidden");
  // No rubber band on the document: on iOS it held the next swipe.
  expect(m.overscroll).toBe("none");
}

function railNav(page: Page): Locator {
  return page.locator('aside [data-slot="sidebar-nav-region"] > nav');
}

/** Scrolls `<main>` to its end, waiting out content that grows on the way. */
async function scrollMainToEnd(page: Page) {
  let last = -1;
  for (let i = 0; i < 8; i += 1) {
    const height = await page.evaluate(() => {
      const main = document.getElementById("main-content")!;
      main.scrollTop = main.scrollHeight;
      return main.scrollHeight;
    });
    if (height === last) return;
    last = height;
    await page.waitForTimeout(250);
  }
}

/** Where the page's lowest content ends, and what covers the window's bottom edge. */
async function measureMainEnd(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById("main-content")!;
    const wrapper = main.querySelector<HTMLElement>(
      '[data-slot="main-content-wrapper"]',
    )!;
    let contentBottom = 0;
    for (const el of wrapper.querySelectorAll<HTMLElement>("*")) {
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      let p = el.parentElement;
      let nested = false;
      while (p && p !== main) {
        const ps = getComputedStyle(p);
        if (
          /(auto|scroll|hidden)/.test(ps.overflowY) &&
          p.scrollHeight > p.clientHeight + 1
        ) {
          nested = true;
          break;
        }
        p = p.parentElement;
      }
      if (nested) continue;
      contentBottom = Math.max(contentBottom, rect.bottom);
    }
    const visible = (el: Element | null): el is HTMLElement =>
      !!el &&
      getComputedStyle(el).display !== "none" &&
      el.getBoundingClientRect().height > 0;
    const bar = document.querySelector('[data-slot="bottom-nav"]');
    const mainRect = main.getBoundingClientRect();
    return {
      atEnd: main.scrollTop + main.clientHeight >= main.scrollHeight - 1,
      scrolls: main.scrollHeight > main.clientHeight,
      contentBottom,
      mainBottom: mainRect.bottom,
      barTop: visible(bar) ? bar.getBoundingClientRect().top : null,
    };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}x${vp.height})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    test("every rail destination scrolls into view and takes a tap", async ({
      page,
    }) => {
      await openDashboard(page);
      await expectShellPinned(page);

      const aside = page.locator("aside");
      const railShown = vp.width >= 768;
      if (!railShown) {
        // Split View and Slide Over get the phone shell: the bar, no rail.
        await expect(aside).toBeHidden();
        await expect(page.locator('[data-slot="bottom-nav"]')).toBeVisible();
        return;
      }
      await expect(aside).toBeVisible();

      // Nothing in the rail is clipped by the rail: the logo band, the list
      // region, the pinned footer and the account row all sit inside it, in
      // that order, and the list region alone gives up height.
      const parts = await page.evaluate(() => {
        const asideEl = document.querySelector("aside")!;
        const box = asideEl.getBoundingClientRect();
        const pick = (sel: string) =>
          asideEl.querySelector(sel)!.getBoundingClientRect();
        const column = asideEl.querySelector('[data-slot="sidebar-column"]')!;
        const user = column.lastElementChild!.getBoundingClientRect();
        return {
          clipped: asideEl.scrollHeight - asideEl.clientHeight,
          asideTop: box.top,
          asideBottom: box.bottom,
          header: pick('[data-slot="sidebar-header"]'),
          region: pick('[data-slot="sidebar-nav-region"]'),
          footer: pick('[data-slot="sidebar-footer"]'),
          user,
          overscroll: getComputedStyle(
            asideEl.querySelector('[data-slot="sidebar-nav-region"] > nav')!,
          ).overscrollBehaviorY,
        };
      });
      expect(parts.clipped).toBeLessThanOrEqual(0);
      expect(parts.header.top).toBeGreaterThanOrEqual(parts.asideTop - 0.5);
      expect(parts.region.top).toBeGreaterThanOrEqual(
        parts.header.bottom - 0.5,
      );
      expect(parts.footer.top).toBeGreaterThanOrEqual(
        parts.region.bottom - 0.5,
      );
      expect(parts.user.top).toBeGreaterThanOrEqual(parts.footer.bottom - 0.5);
      expect(parts.user.bottom).toBeLessThanOrEqual(parts.asideBottom + 0.5);
      expect(parts.overscroll).toBe("contain");
      await expect(
        aside.locator('[data-slot="sidebar-collapse-toggle"]'),
      ).toBeInViewport({ ratio: 1 });
      await expect(
        aside.locator('[data-slot="nav-settings-link"]'),
      ).toBeInViewport({ ratio: 1 });

      // Every destination: scrolled into the list's view, whole, on top
      // (not under the cue, the footer or anything else), and actionable.
      const nav = railNav(page);
      const links = nav.locator("a[href]");
      const count = await links.count();
      expect(count).toBeGreaterThanOrEqual(10);
      for (let i = 0; i < count; i += 1) {
        const link = links.nth(i);
        await link.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            link.evaluate((el) => {
              const navEl = el.closest("nav")!;
              const r = el.getBoundingClientRect();
              const n = navEl.getBoundingClientRect();
              const hit = document.elementFromPoint(
                r.left + r.width / 2,
                r.top + r.height / 2,
              );
              return (
                r.top >= n.top - 0.5 &&
                r.bottom <= n.bottom + 0.5 &&
                !!hit &&
                el.contains(hit)
              );
            }),
          )
          .toBe(true);
        await link.click({ trial: true });
      }

      // A list taller than its region shows the touch cue at the edge that
      // has more, and a tap on it is a way there.
      const overflows = await nav.evaluate(
        (el) => el.scrollHeight > el.clientHeight + 1,
      );
      const down = page.locator(
        '[data-slot="sidebar-nav-scroll-cue"][data-direction="down"]',
      );
      const up = page.locator(
        '[data-slot="sidebar-nav-scroll-cue"][data-direction="up"]',
      );
      await nav.evaluate((el) => (el.scrollTop = 0));
      if (overflows) {
        await expect(down).toBeVisible();
        await expect(up).toHaveCount(0);
        await down.tap();
        await expect
          .poll(() => nav.evaluate((el) => el.scrollTop))
          .toBeGreaterThan(0);
        await expect(up).toBeVisible();
        await nav.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await expect(down).toHaveCount(0);
      } else {
        await expect(down).toHaveCount(0);
        await expect(up).toHaveCount(0);
      }

      // And the last destination is a real tap away.
      const lastLink = links.nth(count - 1);
      const href = await lastLink.getAttribute("href");
      await lastLink.scrollIntoViewIfNeeded();
      await lastLink.tap();
      await expect(page).toHaveURL(new RegExp(`${href}$`));
    });

    // The Coach button's clearance is held by `shell-viewport.test.ts`: the
    // button renders only with an AI provider, which the suite's accounts
    // do not have, so a check here would never run.
    test("main scrolls to its last line, clear of the bottom bar", async ({
      page,
    }) => {
      await openDashboard(page);
      await scrollMainToEnd(page);
      const end = await measureMainEnd(page);
      expect(end.scrolls).toBe(true);
      expect(end.atEnd).toBe(true);
      expect(end.contentBottom).toBeLessThanOrEqual(end.mainBottom + 0.5);
      if (end.barTop !== null) {
        expect(end.contentBottom).toBeLessThanOrEqual(end.barTop);
      }
      await expectShellPinned(page);
    });
  });
}

/** After a modal closes, the page behind takes pointer and wheel again and scrolls. */
async function expectPageScrollsAgain(page: Page, browserName: string) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        locked: document.body.hasAttribute("data-scroll-locked"),
        pointer: getComputedStyle(document.body).pointerEvents,
      })),
    )
    .toEqual({ locked: false, pointer: "auto" });
  const before = await page.evaluate(() => {
    const main = document.getElementById("main-content")!;
    main.scrollTop = 0;
    const r = main.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const wheel = new WheelEvent("wheel", {
      deltaY: 120,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    hit?.dispatchEvent(wheel);
    return {
      onMain: !!hit && main.contains(hit),
      blocked: wheel.defaultPrevented,
      x,
      y,
    };
  });
  // Nothing invisible lies over `<main>`, and no scroll lock swallows the
  // wheel (react-remove-scroll cancels it outside its own layer).
  expect(before.onMain).toBe(true);
  expect(before.blocked).toBe(false);
  // A real wheel where the engine has one. Mobile WebKit under Playwright
  // has none (and no native touch scroll), so there the two checks above
  // are the proof: nothing covers `<main>` and nothing cancels its events.
  if (browserName === "webkit") return;
  await page.mouse.move(before.x, before.y);
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() =>
      page.evaluate(() => document.getElementById("main-content")!.scrollTop),
    )
    .toBeGreaterThan(0);
}

const MODAL_VIEWPORTS = [
  { name: "iPad Air 11 landscape", width: 1180, height: 820 },
  { name: "iPad Air 11 portrait", width: 820, height: 1180 },
  { name: "Split View two thirds", width: 694, height: 1024 },
] as const;

for (const vp of MODAL_VIEWPORTS) {
  test.describe(`${vp.name}: scroll after a modal`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    test("the page scrolls after the command palette dialog closes", async ({
      page,
      browserName,
    }) => {
      await openDashboard(page);
      await page.locator('[data-slot="command-palette-trigger"]:visible').tap();
      const input = page.locator('[data-slot="command-palette-input"]');
      await expect(input).toBeVisible();
      // The scroll lock makes the body `position: relative`; the shell
      // behind the dialog keeps the window's box all the same.
      await expectShellPinned(page);
      await page.keyboard.press("Escape");
      await expect(input).toBeHidden();
      await expectPageScrollsAgain(page, browserName);
    });

    test("the page scrolls after a sheet closes", async ({
      page,
      browserName,
    }) => {
      await openDashboard(page);
      if (vp.width < 768) {
        // The phone shell's More sheet: the draggable bottom sheet.
        await page.locator('[data-testid="bottom-nav-more"]').tap();
        const sheet = page.locator('[data-testid="bottom-nav-more-sheet"]');
        await expect(sheet).toBeVisible();
        await expectShellPinned(page);
        await sheet.locator('[data-slot="sheet-close-button"]').tap();
        await expect(sheet).toBeHidden();
      } else {
        // The day, a sheet from the right below 1280 px.
        await mockDay(page);
        const day = new Date(Date.now() - 86_400_000)
          .toISOString()
          .slice(0, 10);
        await page.goto(`/?day=${day}`, { waitUntil: "domcontentloaded" });
        const panel = page.locator('[data-slot="day-panel"]');
        await expect(panel).toBeVisible();
        await expectShellPinned(page);
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
      }
      await expectPageScrollsAgain(page, browserName);
    });
  });
}

test("a vertical swipe that starts on a tab strip is the page's", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto("/checkups", { waitUntil: "domcontentloaded" });
  const strip = page.locator('#main-content [data-slot="tabs-list"]').first();
  await expect(strip).toBeVisible();
  // `pan-x` here refused the vertical pan, so the page did not move.
  const touchAction = await strip.evaluate(
    (el) => getComputedStyle(el).touchAction,
  );
  expect(touchAction).toBe("auto");
});
