/**
 * The app header keeps its height in every language.
 *
 * A translated label that is a little longer than the English one wraps, and
 * a header that wraps grows: the dashboard's title row once took a second
 * line in one locale while every English check stayed green. The top bar and
 * the dashboard's page-header row are measured here in every shipped locale,
 * on a 390 px phone and on a desktop window, against the height English gives
 * them on the same viewport.
 *
 * The language is switched the way the app switches it, through
 * `PUT /api/auth/me/locale`, which writes the account's language and the
 * locale cookie; `<html lang>` is then asserted before anything is measured,
 * so a switch that silently did not happen cannot pass as "same height".
 *
 * The locale list is the app's own (`src/lib/i18n/config.ts`), so a language
 * added there is swept without touching this file.
 */
import type { Page } from "@playwright/test";

import { locales, type Locale } from "@/lib/i18n/config";

import { HEADER_LOCALES_STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";

const VIEWPORTS = [
  { label: "phone 390", width: 390, height: 844 },
  { label: "desktop 1280", width: 1280, height: 800 },
] as const;

type ViewportLabel = (typeof VIEWPORTS)[number]["label"];

interface HeaderGeometry {
  topBar: number;
  pageHeader: number;
  /** For the failure message: what wrapped, not only that something did. */
  title: string;
  titleHeight: number;
}

/** English first: every other locale is compared with what it measured. */
const ORDER: Locale[] = ["en", ...locales.filter((l) => l !== "en")];

const reference = new Map<ViewportLabel, HeaderGeometry>();

async function readHeader(page: Page): Promise<HeaderGeometry | null> {
  return page.evaluate(() => {
    const topBar = document.querySelector('[data-slot="top-bar"]');
    const rows = document.querySelectorAll(
      'main [data-slot="page-header-row"]',
    );
    if (!topBar || rows.length !== 1) return null;
    const row = rows[0];
    const title = row.querySelector("h1");
    return {
      topBar: topBar.getBoundingClientRect().height,
      pageHeader: row.getBoundingClientRect().height,
      title: title?.textContent ?? "",
      titleHeight: title?.getBoundingClientRect().height ?? 0,
    };
  });
}

/**
 * Read the header until two reads a frame apart agree. The greeting swaps to
 * the personalised line after hydration; measuring mid-swap would compare a
 * frame nobody keeps.
 */
async function settledHeader(page: Page): Promise<HeaderGeometry> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let previous: HeaderGeometry | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const current = await readHeader(page);
    if (
      current &&
      previous &&
      current.topBar === previous.topBar &&
      current.pageHeader === previous.pageHeader
    ) {
      return current;
    }
    previous = current;
  }
  throw new Error(
    `header did not settle: ${JSON.stringify(previous ?? "not found")}`,
  );
}

test.describe("header height in every locale", () => {
  test.use({ storageState: HEADER_LOCALES_STORAGE_STATE_PATH });
  // The account's language is one value; the locales take turns on it.
  // It runs in the desktop project only (see `playwright.config.ts`) and sets
  // both viewports itself.
  test.describe.configure({ mode: "serial" });

  for (const locale of ORDER) {
    test(`top bar and dashboard header keep the English height in ${locale}`, async ({
      page,
    }) => {
      test.setTimeout(60_000);

      const switched = await page.request.put("/api/auth/me/locale", {
        data: { locale },
      });
      expect(switched.status(), await switched.text()).toBe(200);

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator('[data-slot="top-bar"]')).toBeVisible();
        await expect(
          page.locator('main [data-slot="page-header-row"]'),
        ).toBeVisible();
        await expect(
          page.locator('[data-slot="dashboard-header-greeting"]'),
        ).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => window.innerWidth))
          .toBe(viewport.width);

        const measured = await settledHeader(page);
        const at = `${locale}, ${viewport.label}`;
        // A band that is not there measures 0 in every locale and "agrees".
        expect(
          measured.topBar,
          `top bar has no height (${at})`,
        ).toBeGreaterThan(32);
        expect(
          measured.pageHeader,
          `page header has no height (${at})`,
        ).toBeGreaterThan(20);

        if (locale === "en") {
          reference.set(viewport.label, measured);
          continue;
        }
        const english = reference.get(viewport.label);
        expect(english, "the English reference ran first").toBeDefined();
        const detail = `title "${measured.title}" ${measured.titleHeight}px tall vs "${english!.title}" ${english!.titleHeight}px`;
        expect(
          Math.abs(measured.topBar - english!.topBar),
          `top bar is ${measured.topBar}px in ${at}, ${english!.topBar}px in English`,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(measured.pageHeader - english!.pageHeader),
          `dashboard header is ${measured.pageHeader}px in ${at}, ${english!.pageHeader}px in English; ${detail}`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});
