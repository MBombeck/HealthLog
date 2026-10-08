import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The installed-app behaviours a phone depends on, measured in the Pixel 5
 * project (a touch screen: `pointer: coarse`).
 *
 *   1. The "new version" hint stands above the bottom bar instead of on it,
 *      and its Reload action reloads the page.
 *   2. With the on-screen keyboard open, a bottom sheet stands on the
 *      keyboard (its Save button stays visible) and the bottom bar steps
 *      aside. Playwright has no on-screen keyboard, so the visual viewport is
 *      replaced by a stand-in whose height the test shrinks the way a
 *      keyboard does; what is asserted is the page's answer to that signal.
 *   3. No form field a phone can focus is set below 16 px, in portrait or
 *      held sideways, because iOS Safari zooms the page into such a field.
 *   4. Held sideways, the sign-in card is not centred out of reach.
 *
 * The account is the populated mobile-sweep account; nothing here writes.
 */

const VISUAL_VIEWPORT_STAND_IN = () => {
  const stand = new EventTarget() as EventTarget & {
    height: number;
    width: number;
    offsetTop: number;
    offsetLeft: number;
    pageTop: number;
    pageLeft: number;
    scale: number;
  };
  stand.height = window.innerHeight;
  stand.width = window.innerWidth;
  stand.offsetTop = 0;
  stand.offsetLeft = 0;
  stand.pageTop = 0;
  stand.pageLeft = 0;
  stand.scale = 1;
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    get: () => stand,
  });
  (window as unknown as { __viewport: typeof stand }).__viewport = stand;
};

async function setKeyboard(page: Page, covered: number) {
  await page.evaluate((px) => {
    const stand = (
      window as unknown as {
        __viewport: EventTarget & { height: number };
      }
    ).__viewport;
    stand.height = window.innerHeight - px;
    stand.dispatchEvent(new Event("resize"));
  }, covered);
}

async function openCaptureForm(page: Page) {
  await page.goto("/");
  await page.getByTestId("bottom-nav-capture").click();
  const picker = page.locator('[data-slot="responsive-sheet-content"]');
  await expect(picker).toBeVisible();
  await picker
    .locator('[data-slot="responsive-sheet-body"] button')
    .first()
    .click();
  const form = page
    .locator('[data-slot="responsive-sheet-content"]')
    .filter({ has: page.locator('[data-slot="responsive-sheet-footer"]') });
  await expect(form).toBeVisible();
  return form;
}

/** Every visible field a phone can focus, with its computed font size. */
async function fieldFontSizes(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),textarea,select",
      ),
    )
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      })
      .map((el) => ({
        field:
          el.getAttribute("name") ||
          el.id ||
          el.getAttribute("aria-label") ||
          el.tagName,
        px: parseFloat(getComputedStyle(el).fontSize),
      })),
  );
}

test.describe("installed app on a phone", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("the new-version hint stands above the bottom bar and reloads", async ({
    page,
  }) => {
    await page.route("**/api/version", (route) =>
      route.fulfill({
        json: {
          data: { version: "999.0.0", buildSha: "e2e" },
          error: null,
        },
      }),
    );
    await page.goto("/");
    const toast = page.locator("[data-sonner-toast]").filter({
      has: page.getByRole("button", { name: "Reload" }),
    });
    // The poller's first check runs five seconds after mount.
    await expect(toast).toBeVisible({ timeout: 15_000 });

    const nav = page.locator('[data-slot="bottom-nav"]');
    const navBox = (await nav.boundingBox())!;
    // Polled: the toast slides in from below, so an early sample is
    // mid-animation.
    await expect
      .poll(async () => {
        const b = (await toast.boundingBox())!;
        return b.y + b.height;
      })
      .toBeLessThanOrEqual(navBox.y);
    // The bottom bar's controls are still reachable with the hint up.
    await expect(page.getByTestId("bottom-nav-more")).toBeVisible();

    const reloaded = page.waitForEvent("load");
    await toast.getByRole("button", { name: "Reload" }).click();
    await reloaded;
  });

  test("a bottom sheet stands on the on-screen keyboard and the bottom bar steps aside", async ({
    page,
  }) => {
    await page.addInitScript(VISUAL_VIEWPORT_STAND_IN);
    const form = await openCaptureForm(page);
    const save = form
      .locator('[data-slot="responsive-sheet-footer"] button')
      .last();
    const viewportHeight = page.viewportSize()!.height;

    const bottomEdge = async () => {
      const b = (await form.boundingBox())!;
      return Math.round(b.y + b.height);
    };
    // Closed keyboard: the sheet sits on the bottom edge (polled: it slides
    // in from below).
    await expect.poll(bottomEdge).toBe(viewportHeight);

    const keyboard = 300;
    await setKeyboard(page, keyboard);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
    await expect.poll(bottomEdge).toBe(viewportHeight - keyboard);
    const box = (await form.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    const saveBox = (await save.boundingBox())!;
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(
      viewportHeight - keyboard,
    );
    await expect(page.locator('[data-slot="bottom-nav"]')).toBeHidden();

    // A toolbar-sized change is not a keyboard.
    await setKeyboard(page, 60);
    await expect(page.locator("html")).not.toHaveAttribute("data-keyboard");
    await expect.poll(bottomEdge).toBe(viewportHeight);
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`no focusable field is below 16 px at ${viewport.width}x${viewport.height} (iOS focus zoom)`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const offenders: string[] = [];
      for (const path of [
        "/settings",
        "/documents",
        "/settings/notifications",
      ]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const fields = await fieldFontSizes(page);
        expect(fields.length, `${path} renders no field`).toBeGreaterThan(0);
        for (const f of fields)
          if (f.px < 16) offenders.push(`${path} ${f.field} ${f.px}px`);
      }
      if (viewport.width < 768) {
        const form = await openCaptureForm(page);
        await expect(form.locator("input").first()).toBeVisible();
        for (const f of await fieldFontSizes(page))
          if (f.px < 16) offenders.push(`capture ${f.field} ${f.px}px`);
      }
      expect(offenders).toEqual([]);
    });
  }
});

test.describe("signed out, held sideways", () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("the sign-in card stays reachable from its top edge", async ({
    page,
  }) => {
    await page.goto("/auth/login");
    const card = page.locator("main#main-content > *").first();
    await expect(card).toBeVisible();
    // Open the password form, the tallest state of the card.
    await page
      .getByRole("button", { name: /password|passwort/i })
      .first()
      .click();
    await expect(page.locator("input[type=password]").first()).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    // And the document scrolls to reach whatever lies below the fold.
    const scrollable = await page.evaluate(
      () =>
        document.documentElement.scrollHeight >= window.innerHeight &&
        getComputedStyle(document.documentElement).overflowY !== "hidden",
    );
    expect(scrollable).toBe(true);
  });
});
