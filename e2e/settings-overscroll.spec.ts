import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { settleBeforeMeasure } from "./utils/settle";

/**
 * Vertical over-scroll regression guard (the recurring class behind the
 * v1.25.11 settings fix): the scroll viewport must never extend far past
 * the last content element. The rule the guard pins is structural — only
 * the AuthShell owns the scroll height and the bottom padding
 * (`pt-6 pb-20` on the wrapper, `pb-24` in the desktop shell, plus the `<md` bottom-nav clearance on
 * `<main>`); a page/section must never add its own viewport-height
 * reserve or bottom gutter, because every such nested reserve stacks on
 * the shell's own budget and reopens the dark-band-below-the-last-card
 * bug.
 *
 * The assertion: `main.scrollHeight` ≤ bottom edge of the lowest real
 * content element + the shell-owned padding + tolerance. "Real content"
 * is measured against each element's CONTENT-box bottom, not its padding-
 * box: a sub-shell column that re-declares its own bottom gutter (`pb-*`)
 * no longer folds that gutter into `contentBottom`, so a redundant reserve
 * FAILS the assertion instead of being absorbed by it. Runs across both
 * two-column sub-shells — Settings AND Admin (they share the grid-floor
 * source) — at desktop AND phone-shaped viewports, because the two shell
 * paddings differ per breakpoint.
 */
const ROUTES = [
  // Settings sub-shell — short hub, long sortable-list subpages, long form.
  "/settings/layout",
  "/settings/layout/dashboard",
  // The other sortable-list subpages + the Modules hub: each hosts an
  // order editor with the sr-only drag-hint paragraph (see the
  // one-scroll-floor assertion below).
  "/settings/layout/insights",
  "/settings/layout/medications",
  "/settings/modules/mood",
  "/settings/modules",
  "/settings/account",
  "/settings/notifications",
  // Admin sub-shell — short overview + a longer list page. Guards that the
  // pre-#154 column reserve stays retired on every admin breakpoint.
  "/admin",
  "/admin/login-overview",
  "/admin/system-status",
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, expectedPad: 96 }, // wrapper shell-desktop:pb-24
  { name: "phone", width: 390, height: 844, expectedPad: 144 }, // pb-20 + main pb-16
] as const;

test.describe("settings + admin vertical over-scroll guard", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-driven spec; desktop project only",
    );
  });

  for (const vp of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`no over-scroll on ${route} (${vp.name})`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(route, { waitUntil: "domcontentloaded" });
        // Was a fixed 500 ms sleep, which is the wrong shape twice over: too
        // long when the page is ready and too short on a loaded runner, and
        // it never says what it is waiting for. Gate on the element the
        // measurement reads instead.
        const wrapperLocator = page.locator(
          '#main-content [data-slot="main-content-wrapper"]',
        );
        await settleBeforeMeasure(page, wrapperLocator);

        const dims = await page.evaluate(() => {
          const main = document.getElementById("main-content");
          if (!main) return null;
          // Selected by the stable `data-slot` (auth-shell.tsx), not by
          // birth order: `firstElementChild` would resolve to whatever
          // lazily-mounted sibling (portal, toast, hydrating region) landed
          // first, silently measuring the wrong subtree instead of the
          // real content wrapper.
          const wrapper = main.querySelector<HTMLElement>(
            '[data-slot="main-content-wrapper"]',
          );
          if (!wrapper) return null;
          // Lowest content edge: max CONTENT-box bottom over the wrapper's
          // visible, non-fixed descendants, in the scroll container's
          // coordinate space. Using the content box (padding-box bottom
          // minus the element's own bottom padding + border) means a
          // layout column's own `pb-*` gutter is NOT counted — its last
          // real child (a card) is still measured through the column's
          // content box, so a redundant sub-shell bottom gutter shows up
          // as pure over-scroll instead of inflating the allowed budget.
          // Elements inside nested scroll containers are clipped by their
          // own overflow and never add page scroll height, so skip
          // anything whose scrollable ancestor is not `main`.
          let maxBottom = 0;
          const mainTop = main.getBoundingClientRect().top;
          for (const el of wrapper.querySelectorAll<HTMLElement>("*")) {
            const cs = getComputedStyle(el);
            if (cs.position === "fixed") continue;
            const rect = el.getBoundingClientRect();
            if (rect.height === 0 && rect.width === 0) continue;
            // Skip descendants of inner scroll containers (their
            // overflow does not contribute to the page scroll height).
            let p = el.parentElement;
            let inner = false;
            while (p && p !== main) {
              const pcs = getComputedStyle(p);
              if (
                (pcs.overflowY === "auto" || pcs.overflowY === "scroll") &&
                p.scrollHeight > p.clientHeight
              ) {
                inner = true;
                break;
              }
              p = p.parentElement;
            }
            if (inner) continue;
            const padBottom = parseFloat(cs.paddingBottom) || 0;
            const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
            const bottom =
              rect.bottom - padBottom - borderBottom + main.scrollTop - mainTop;
            if (bottom > maxBottom) maxBottom = bottom;
          }
          return {
            scrollHeight: main.scrollHeight,
            clientHeight: main.clientHeight,
            contentBottom: Math.round(maxBottom),
          };
        });

        expect(dims, "main-content / wrapper present").not.toBeNull();
        if (!dims) return;

        // One-scroll-floor (ui-standards.md §9), structural half. `<main>` may
        // only be the ONLY vertical scroll surface if it also OWNS the
        // containing block of its absolutely-positioned descendants: an
        // abspos box with no positioned ancestor resolves against the
        // initial containing block, which sits outside the scroll container,
        // so `overflow-y-auto` never clips it and its static position
        // extends the DOCUMENT's scrollable overflow instead.
        //
        // This is asserted separately from the height read below because the
        // two catch the same defect at different reliabilities. The height
        // read only sees an escapee that is mounted at measure time, and the
        // escapees are mostly transient: a Radix `<Switch>` outside a
        // `<form>` renders a hidden `position:absolute` bubble input on the
        // first pass and drops it once its button ref resolves, and the root
        // `loading.tsx` chart skeleton carries an `sr-only` announcement
        // that lives only until the real content streams in. Both made the
        // document scrollable for the whole pre-hydration window, and both
        // are gone by the time a fast machine gets around to measuring, so
        // the height read caught them on a loaded CI runner and nowhere
        // else. The computed style of `<main>` is timing-free.
        const mainPosition = await page.evaluate(
          () =>
            getComputedStyle(document.getElementById("main-content")!).position,
        );
        expect(
          mainPosition,
          "<main id=main-content> must establish a containing block, or an " +
            "absolutely-positioned descendant escapes its overflow clip and " +
            "becomes a second vertical scroll surface",
        ).not.toBe("static");

        // Same rule, measured: the document itself must never become
        // scrollable next to `<main>` (a second painted scrollbar + a dead
        // dark band under the shell).
        const doc = await page.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight,
        }));
        expect(
          doc.scrollHeight,
          `document scrollHeight=${doc.scrollHeight} > viewport ` +
            `${doc.clientHeight} — a second vertical scroll surface exists ` +
            `beside <main> (likely an absolutely-positioned element escaping ` +
            `to the initial containing block)`,
        ).toBeLessThanOrEqual(doc.clientHeight + 1);

        // A page shorter than the viewport cannot over-scroll at all.
        if (dims.scrollHeight <= dims.clientHeight) return;

        const tolerance = 24;
        expect(
          dims.scrollHeight,
          `scrollHeight=${dims.scrollHeight} contentBottom=${dims.contentBottom} ` +
            `expectedPad=${vp.expectedPad} — the scroll area extends past the ` +
            `last content element + the shell-owned padding; some nested ` +
            `min-h / bottom padding is stacking on the shell budget`,
        ).toBeLessThanOrEqual(dims.contentBottom + vp.expectedPad + tolerance);
      });
    }
  }
});
