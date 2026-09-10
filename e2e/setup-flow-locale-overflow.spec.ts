/**
 * v1.39 (C2) — every setup screen, in every locale, with 30% longer strings.
 *
 * The design spec asks for 30–50% string headroom in every layout, and the
 * seven bundles are the floor, not the ceiling: a German label that fits
 * today is one revision from not fitting. So this spec does what
 * `locale-switch.spec.ts` does (set the locale cookie, render, refuse raw
 * keys) and then what `dialog-horizontal-overflow.spec.ts` does (measure
 * real overflow in the page), with one step between them: every text node
 * on the screen is lengthened by 30% in place before the measurement, so
 * the check is against the headroom rather than against today's copy.
 *
 * Three claims per screen, locale and width: the page does not scroll
 * sideways, nothing that clips its text (`overflow: hidden`) is actually
 * clipping, and every control sits inside the viewport. The state is driven
 * through the API once per test and every screen is visited by URL, which
 * the step machine allows for a flow that reached the end.
 */
import type { Page } from "@playwright/test";

import {
  E2E_SETUP_LOCALE,
  SETUP_LOCALE_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  answer,
  answerEverything,
  complete,
  expectScreen,
  SHELL,
  type SetupScreen,
} from "./setup-flow-helpers";

const LOCALES = ["en", "de", "es", "fr", "it", "pl", "ko"] as const;

const VIEWPORTS = [
  { label: "desktop 1280", width: 1280, height: 800 },
  { label: "phone 390", width: 390, height: 844 },
];

const SCREENS: Array<{ screen: SetupScreen; path: string }> = [
  { screen: "who", path: "/onboarding/who" },
  { screen: "areas", path: "/onboarding/areas" },
  { screen: "medication", path: "/onboarding/medication" },
  { screen: "sources", path: "/onboarding/sources" },
  { screen: "visit", path: "/onboarding/visit" },
  { screen: "units", path: "/onboarding/units" },
  { screen: "confirm", path: "/onboarding/confirm" },
  { screen: "first-result", path: "/onboarding/first-result" },
  { screen: "done", path: "/onboarding/done" },
];

/**
 * A rendered i18n key is a lookup that fell through. The flow's keys are
 * three or more dotted segments (`onboarding.flow.who.options.me`,
 * `onboarding.steps.first-result`), lowercase and kebab as often as camel —
 * so the test is the dotted shape itself, not a camelCase segment inside it
 * (which the locale-switch smoke test requires and which most of these keys
 * do not have). No sentence on these screens carries such a run.
 */
const RAW_KEY = /\b[a-z]+(?:\.[a-zA-Z][\w-]*){2,}\b/;

/**
 * Lengthen every text node under the shell by 30%, then measure. Padding
 * lengthens every WORD by 30%, so the longest unbreakable run grows in the
 * same proportion as the sentence — which is what a longer translation does.
 * Appending the whole surplus to one word would manufacture an unbreakable
 * run no locale produces; adding only spaces would wrap for free and prove
 * nothing.
 */
async function padAndMeasure(page: Page) {
  return page.evaluate((shellSelector) => {
    const shell = document.querySelector<HTMLElement>(shellSelector);
    if (!shell) return null;

    const walker = document.createTreeWalker(shell, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    let padded = 0;
    while (node) {
      const text = node.textContent ?? "";
      const letters = text.replace(/\s+/g, "").length;
      if (
        letters >= 3 &&
        node.parentElement?.closest("script,style") === null
      ) {
        node.textContent = text.replace(/\S+/g, (word) =>
          word.length >= 2
            ? word + "x".repeat(Math.ceil(word.length * 0.3))
            : word,
        );
        padded += 1;
      }
      node = walker.nextNode();
    }

    const doc = document.documentElement;
    const clippers = [...shell.querySelectorAll<HTMLElement>("*")]
      .filter((el) => {
        // Screen-reader-only text is a 1 px clipped box on purpose; it is
        // read, not seen, and cannot truncate.
        if (el.classList.contains("sr-only") || el.clientWidth <= 1) {
          return false;
        }
        // A select's value ellipsises by design (shadcn `SelectValue`, app
        // wide): the full text is the option in the list and the control's
        // accessible name, and a trigger that grew with its longest option
        // would move every neighbour. Not a layout that lost headroom.
        if (el.dataset.slot === "select-value") return false;
        const overflowX = getComputedStyle(el).overflowX;
        return overflowX === "hidden" || overflowX === "clip";
      })
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => ({
        slot: el.dataset.slot ?? el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 40),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
    /**
     * A name for the box that overflowed, so a red run says WHAT rather than
     * only that the page grew: tag, `data-slot`, the first classes, the text
     * it starts with, and its edges. The CI runner's fallback fonts render a
     * pixel or two wider than a Mac's, so the culprit is often invisible
     * locally and the message is the whole diagnosis.
     */
    const describe = (el: HTMLElement, r: DOMRect) => ({
      tag: el.tagName.toLowerCase(),
      slot: el.dataset.slot ?? null,
      classes: el.className.toString().split(/\s+/).slice(0, 4).join(" "),
      text: (el.textContent ?? "").trim().slice(0, 40),
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
    });
    const shellRight = shell.getBoundingClientRect().right;
    // Every box that reaches past the shell's own right edge, widest first,
    // deepest first among equals (the leaf is the culprit, its ancestors
    // merely grew with it).
    const widest = [...shell.querySelectorAll<HTMLElement>("*")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.right > shellRight + 1)
      .sort(
        (a, b) =>
          b.r.right - a.r.right || b.el.children.length - a.el.children.length,
      )
      .reverse()
      .slice(0, 6)
      .map(({ el, r }) => describe(el, r));
    const outside = [
      ...shell.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .filter(({ r }) => r.right > window.innerWidth + 1 || r.left < -1)
      .map(({ el, r }) => describe(el, r));

    return {
      padded,
      pageScrollWidth: doc.scrollWidth,
      pageClientWidth: doc.clientWidth,
      shellScrollWidth: shell.scrollWidth,
      shellClientWidth: shell.clientWidth,
      widest,
      clippers,
      outside,
    };
  }, SHELL);
}

// Serial: every test here drives the ONE account through the API, and two
// workers doing that at once would each find the other's answers.
test.describe.configure({ mode: "serial" });

test.describe("setup flow — every locale at 30% longer strings", () => {
  test.use({ storageState: SETUP_LOCALE_STORAGE_STATE_PATH });

  for (const locale of LOCALES) {
    for (const vp of VIEWPORTS) {
      test(`${locale} fits at ${vp.label}`, async ({ page, context }) => {
        test.setTimeout(180_000);
        await resetSetupFlow(E2E_SETUP_LOCALE.username);
        await answerEverything(page);
        await answer(page, {
          step: "units",
          units: { glucoseUnit: "mg/dL", unitPreference: "metric" },
        });
        await complete(page);
        await answer(page, { step: "first-result", status: "skipped" });

        const baseURL =
          test.info().project.use.baseURL ?? "http://localhost:3000";
        await context.addCookies([
          { name: "healthlog-locale", value: locale, url: baseURL },
        ]);
        await page.setViewportSize({ width: vp.width, height: vp.height });

        for (const item of SCREENS) {
          await page.goto(item.path, { waitUntil: "domcontentloaded" });
          await expectScreen(page, item.screen);
          await expect(page.locator("h1")).toBeVisible();

          // No raw key before the padding touches the text.
          const body = await page.locator(SHELL).innerText();
          const match = body.match(RAW_KEY);
          expect(
            match?.[0] ?? null,
            `raw i18n key on ${item.screen} in ${locale}`,
          ).toBeNull();

          const result = await padAndMeasure(page);
          const label = `${item.screen} ${locale} @${vp.label}`;
          expect(result, `${label}: shell not found`).not.toBeNull();
          expect(
            result!.padded,
            `${label}: nothing was padded, so this measured nothing`,
          ).toBeGreaterThan(3);
          const culprits = JSON.stringify(result!.widest);
          expect(
            result!.pageScrollWidth,
            `${label}: the page scrolls sideways; past the shell's edge: ${culprits}`,
          ).toBeLessThanOrEqual(result!.pageClientWidth + 1);
          expect(
            result!.shellScrollWidth,
            `${label}: the shell scrolls sideways; past the shell's edge: ${culprits}`,
          ).toBeLessThanOrEqual(result!.shellClientWidth + 1);
          expect(result!.clippers, `${label}: text is clipped`).toEqual([]);
          expect(
            result!.outside,
            `${label}: control(s) outside the viewport`,
          ).toEqual([]);
        }
      });
    }
  }
});
