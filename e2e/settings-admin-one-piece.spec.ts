import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { settleBeforeMeasure } from "./utils/settle";

/**
 * Settings + Admin read as one surface — measured, not eyeballed.
 *
 * Three claims, each with a number behind it:
 *
 *   1. **No jump on a route switch.** Every settings and admin route puts its
 *      heading at the SAME distance from the top of the scroll container, on
 *      both viewports. This is the U3 complaint stated as a measurement: the
 *      shells hand-rolled the heading, one page used `text-xs sm:text-sm` for
 *      the explainer and another `text-sm`, so the first card started at a
 *      different y depending on where you came from.
 *   2. **One card rhythm.** Inside a settings/admin card, the header's bottom
 *      and the first body block's top sit exactly one gap apart — the card's
 *      own gap, `gap-4` under `md` and `gap-6` above it. Three call-site
 *      techniques used to produce three values here.
 *   3. **One reading edge.** Every card body starts at the card's inner edge.
 *      The `pl-7` gutter put some bodies 28 px in and some at the edge, on the
 *      same page, one card apart.
 *   4. **One row rhythm in a list card.** A card whose rows are a `divide-y`
 *      ledger has nothing between two rows but the divider line, and its first
 *      row starts at the card's inner top edge. The card contract carries a
 *      `gap-4 md:gap-6` for a stack of blocks; dropping the padding without
 *      dropping the gap leaves that gap standing between the rows as dead,
 *      unclickable space the top of the list does not have.
 *
 * Runs in EN and DE, at desktop and phone widths. German runs 15-25% longer,
 * and an explainer that wraps in German where English fits is the same defect
 * the one-sentence rule exists to prevent — so at desktop width a wrap is a
 * failure in either language. On a phone it is reported, not asserted: a
 * 70-character sentence needs about 380 px of column at `text-sm`, so a
 * 393 px viewport wraps most of them, and the alternative is the truncation
 * this work removed.
 */

test.use({ storageState: STORAGE_STATE_PATH });

const SETTINGS_ROUTES = [
  "/settings",
  "/settings/account",
  "/settings/security",
  "/settings/notifications",
  "/settings/integrations",
  "/settings/ai",
  "/settings/coach",
  "/settings/modules",
  "/settings/layout",
  "/settings/thresholds",
  "/settings/sources",
  "/settings/environment",
  "/settings/export",
  "/settings/health-record",
  "/settings/privacy",
  "/settings/api",
  "/settings/mcp",
  "/settings/advanced",
  "/settings/about",
] as const;

/**
 * The Arrangement hub's children, plus (v1.44) the module pages under
 * Modules, which use the same back-link header. They are the routes whose header block
 * changed MOST — the shell used to hand-roll a `space-y-6` between the
 * back-link and the title, and `PageHeader`'s documented contract is
 * `space-y-1.5`. Nothing measured them before, so the step went from 24 px
 * to 6 px unobserved. 6 px is the standards' own number (§1's PageHeader
 * row), so the measurement pins it rather than reverting it.
 */
const LAYOUT_CHILD_ROUTES = [
  "/settings/layout/dashboard",
  "/settings/layout/insights",
  "/settings/layout/medications",
  "/settings/layout/labs",
  "/settings/layout/illness",
  "/settings/layout/checkups",
  "/settings/modules/medications",
  "/settings/modules/mood",
  "/settings/modules/labs",
] as const;

/** The `space-y-1.5` between a back-link and the title it sits above. */
const BACK_LINK_STEP = 6;

const ADMIN_ROUTES = [
  "/admin",
  "/admin/system-status",
  "/admin/general",
  "/admin/services",
  "/admin/users",
  "/admin/invites",
  "/admin/integrations",
  "/admin/coach",
  "/admin/reminders",
  "/admin/backups",
  "/admin/encryption",
  "/admin/app-logs",
  "/admin/api-tokens",
  "/admin/login-overview",
  "/admin/danger-zone",
] as const;

const ROUTES = [...SETTINGS_ROUTES, ...LAYOUT_CHILD_ROUTES, ...ADMIN_ROUTES];

/**
 * The card's own gap. `SettingsCard` inherits the `<Card>` contract —
 * `gap-4` under `md`, `gap-6` from `md` up — so the expected value is a
 * function of the viewport, not a constant. Asserting a constant here would
 * have hidden exactly the defect this run found: the `as="section"` branch
 * was writing a flat `gap-4` and sat one step tighter than its neighbour on
 * every desktop width.
 */
const cardGapFor = (width: number) => (width >= 768 ? 24 : 16);
/** Sub-pixel and font-metric slack. */
const TOLERANCE = 1.5;

type HeaderGeometry = {
  route: string;
  /** `<h1>` top, relative to the scroll container's content top. */
  headingTop: number;
  /** Height of the whole title + explainer block. */
  headerHeight: number;
  /** Rendered line count of the explainer (1 = it stayed on one line). */
  explainerLines: number;
  explainerText: string;
  /**
   * Distance from a hub back-link's bottom to the heading's top, or `null`
   * on a route that has no back-link. A route WITH one has a taller header
   * by construction, so the two families are compared separately.
   */
  backLinkStep: number | null;
};

async function measureHeader(
  page: import("@playwright/test").Page,
  route: string,
): Promise<HeaderGeometry | null> {
  return page.evaluate(
    ({ route }) => {
      const main = document.querySelector("main");
      // On a desktop width the visible heading is the real `<h1>`; on a phone
      // the shells paint it above the chip strip as
      // `role="heading" aria-level="1"` and the `<h1>` in the grid row is
      // display:none. Measure whichever one has a box — measuring the hidden
      // copy reports a constant zero and calls it stability.
      const heading = Array.from(
        document.querySelectorAll<HTMLElement>(
          'main h1, main [role="heading"][aria-level="1"]',
        ),
      ).find((el) => el.getBoundingClientRect().height > 0);
      if (!main || !heading) return null;
      const block = heading.parentElement!;
      const explainer = block.querySelector("p");
      const mainTop = main.getBoundingClientRect().top;
      const headBox = heading.getBoundingClientRect();
      const explainerBox = explainer?.getBoundingClientRect();
      // The hub back-link rides above the title inside the same header — and
      // like the heading it exists twice, because the shell paints the whole
      // block for both breakpoints. `querySelector` returns the first in
      // DOCUMENT order, which on a desktop width is the hidden mobile copy;
      // take the one with a box, the same way the heading is chosen.
      const backLink = Array.from(
        document.querySelectorAll<HTMLElement>(
          'main [data-slot="settings-hub-back-link"]',
        ),
      ).find((el) => el.getBoundingClientRect().height > 0);
      const backLinkBox = backLink?.getBoundingClientRect();
      const style = explainer ? getComputedStyle(explainer) : null;
      const lineHeight = style ? parseFloat(style.lineHeight) : 0;
      return {
        route,
        headingTop: headBox.top - mainTop,
        // Heading top to explainer bottom. The parent block's own box is not
        // a reliable proxy on a phone, where the heading is rendered outside
        // the grid row it belongs to on desktop.
        headerHeight: (explainerBox?.bottom ?? headBox.bottom) - headBox.top,
        explainerLines:
          lineHeight > 0 && explainerBox
            ? Math.round(explainerBox.height / lineHeight)
            : 0,
        explainerText: explainer?.textContent?.trim() ?? "",
        backLinkStep:
          backLinkBox && backLinkBox.height > 0
            ? headBox.top - backLinkBox.bottom
            : null,
      };
    },
    { route },
  );
}

/**
 * Header-to-body gap and body left edge, per card on the page.
 * Returns one entry per card that has both a header and a following sibling.
 */
async function measureCards(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const out: { gap: number; bodyInset: number }[] = [];
    for (const card of document.querySelectorAll('[data-slot="card"]')) {
      const header = card.querySelector(":scope > header");
      if (!header) continue;
      const next = header.nextElementSibling as HTMLElement | null;
      if (!next) continue;
      if (next.getBoundingClientRect().height === 0) continue;
      const cardBox = card.getBoundingClientRect();
      const cardStyle = getComputedStyle(card);
      const cardInnerLeft = cardBox.left + parseFloat(cardStyle.paddingLeft);
      out.push({
        gap:
          next.getBoundingClientRect().top -
          header.getBoundingClientRect().bottom,
        bodyInset: next.getBoundingClientRect().left - cardInnerLeft,
      });
    }
    return out;
  });
}

/**
 * Row rhythm inside a `divide-y` list card, per card on the page.
 *
 * A list card is recognised by its own shape rather than by a class name:
 * three or more direct children, no card header among them, and a divider on
 * every seam between them. That is the ledger pattern wherever it is written,
 * and the three-row floor keeps a header-plus-one-bordered-block card — which
 * claim 2 already owns — out of this one.
 *
 * `topInset` is the space above the FIRST row, measured from the card's inner
 * top edge; `rowGaps` is the space between consecutive rows, over and above
 * the divider line itself. Both are zero in a correct ledger — which is the
 * whole point: the first row and every later row sit the same distance from
 * the line above them.
 */
async function measureListCards(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const out: { slot: string; topInset: number; rowGaps: number[] }[] = [];
    for (const card of document.querySelectorAll('[data-slot="card"]')) {
      if (card.querySelector(":scope > header")) continue;
      const rows = Array.from(card.children) as HTMLElement[];
      if (rows.length < 3) continue;
      // Tailwind writes the divider on the top edge of every row but the
      // first, or on the bottom edge of every row but the last, depending on
      // the utility. Accept either — the pattern is the same ledger.
      const dividedFromTop = rows
        .slice(1)
        .every((row) => parseFloat(getComputedStyle(row).borderTopWidth) > 0);
      const dividedFromBottom = rows
        .slice(0, -1)
        .every(
          (row) => parseFloat(getComputedStyle(row).borderBottomWidth) > 0,
        );
      if (!dividedFromTop && !dividedFromBottom) continue;
      const cardStyle = getComputedStyle(card);
      const cardInnerTop =
        card.getBoundingClientRect().top +
        parseFloat(cardStyle.borderTopWidth) +
        parseFloat(cardStyle.paddingTop);
      out.push({
        slot: card.getAttribute("data-testid") ?? "card",
        topInset: rows[0].getBoundingClientRect().top - cardInnerTop,
        // The divider is drawn inside the row's border box, so it is already
        // inside the measured top edge — a correct ledger reports 0 here.
        rowGaps: rows
          .slice(1)
          .map(
            (row, index) =>
              row.getBoundingClientRect().top -
              rows[index].getBoundingClientRect().bottom,
          ),
      });
    }
    return out;
  });
}

for (const locale of ["en", "de"] as const) {
  test.describe(`one piece — ${locale}`, () => {
    test(`page headers land at one height across every route (${locale})`, async ({
      page,
    }) => {
      test.setTimeout(420_000);
      await page.context().addCookies([
        {
          name: "healthlog-locale",
          value: locale,
          url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
        },
      ]);

      const measured: HeaderGeometry[] = [];
      const skipped: string[] = [];
      for (const route of ROUTES) {
        const response = await page.goto(route, {
          waitUntil: "domcontentloaded",
        });
        if (response && response.status() >= 400) continue;
        // A hub route may client-redirect to its first section; wait for the
        // heading and skip a route that legitimately has none rather than
        // failing the sweep on it.
        const heading = page
          .locator(
            'main h1:visible, main [role="heading"][aria-level="1"]:visible',
          )
          .first();
        if (!(await heading.isVisible().catch(() => false))) {
          await heading
            .waitFor({ state: "visible", timeout: 8_000 })
            .catch(() => {});
        }
        if (!(await heading.isVisible().catch(() => false))) {
          skipped.push(route);
          continue;
        }
        await settleBeforeMeasure(page, heading);
        const geometry = await measureHeader(page, route);
        if (geometry) measured.push(geometry);
      }

      console.log(
        `[${locale}] routes without an <h1>: ${skipped.join(", ") || "none"}`,
      );
      // The sweep has to actually look at something.
      expect(measured.length).toBeGreaterThan(32);

      // Two families, compared separately: a route with a hub back-link
      // carries an extra row above the title, so it is TALLER by
      // construction and comparing it against a plain route would report
      // that structure as drift.
      const plain = measured.filter((m) => m.backLinkStep === null);
      const withBackLink = measured.filter((m) => m.backLinkStep !== null);
      expect(
        withBackLink.length,
        "the Layout children were meant to be measured",
      ).toBe(LAYOUT_CHILD_ROUTES.length);

      const tops = plain.map((m) => m.headingTop);
      const heights = plain.map((m) => m.headerHeight);
      const spreadTop = Math.max(...tops) - Math.min(...tops);
      const spreadHeight = Math.max(...heights) - Math.min(...heights);

      const childTops = withBackLink.map((m) => m.headingTop);
      const childSpreadTop = Math.max(...childTops) - Math.min(...childTops);
      const steps = withBackLink.map((m) => m.backLinkStep!);
      console.log(
        `[${locale}] back-link routes: heading top ${Math.min(...childTops).toFixed(1)}…${Math.max(...childTops).toFixed(1)} ` +
          `(spread ${childSpreadTop.toFixed(1)}px); back-link→title step ${[
            ...new Set(steps.map((v) => v.toFixed(1))),
          ].join(", ")}px`,
      );

      // Attached so a failure reports WHICH route moved, not just that one did.
      console.log(
        `[${locale}] heading top: ${Math.min(...tops).toFixed(1)}…${Math.max(...tops).toFixed(1)} (spread ${spreadTop.toFixed(1)}px)\n` +
          `[${locale}] header height: ${Math.min(...heights).toFixed(1)}…${Math.max(...heights).toFixed(1)} (spread ${spreadHeight.toFixed(1)}px)\n` +
          measured
            .map(
              (m) =>
                `    ${m.route.padEnd(32)} top ${m.headingTop.toFixed(1)}  h ${m.headerHeight.toFixed(1)}  lines ${m.explainerLines}`,
            )
            .join("\n"),
      );

      // A page explainer that wraps is a text problem, and it is the one the
      // ≤120-character rule exists to prevent. Reported per locale.
      const wrapped = measured.filter((m) => m.explainerLines > 1);
      console.log(
        `[${locale}] explainers wrapping past one line: ${wrapped.length}` +
          wrapped.map((m) => `\n    ${m.route}: ${m.explainerText}`).join(""),
      );
      // The no-jump claim, on every viewport: the title starts at the same y
      // whichever route you came from.
      expect(
        spreadTop,
        "heading top drifts between routes",
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(
        childSpreadTop,
        "heading top drifts between the Layout children",
      ).toBeLessThanOrEqual(TOLERANCE);

      // The back-link step is `PageHeader`'s documented `space-y-1.5`. The
      // shell used to hand-roll `space-y-6` here; 6 px is the standards'
      // number, and this is what stops it drifting back to 24.
      for (const measurement of withBackLink) {
        expect(
          Math.abs(measurement.backLinkStep! - BACK_LINK_STEP),
          `${measurement.route}: back-link→title step is ${measurement.backLinkStep!.toFixed(1)}px, not ${BACK_LINK_STEP}px`,
        ).toBeLessThanOrEqual(TOLERANCE);
      }

      // The header's HEIGHT can only be constant where every explainer fits on
      // one line, and on a 393 px phone most one-sentence explainers do not —
      // a 70-character sentence at `text-sm` needs about 380 px of column. The
      // honest rule there is that the block grows by whole lines of text, not
      // that it never grows; forcing one height on a phone means truncating,
      // which is the defect this work removed. So the height is pinned at the
      // width where one line is achievable, and on a phone the wrap count is
      // reported rather than asserted.
      const isPhone = (page.viewportSize()?.width ?? 1280) < 768;
      if (!isPhone) {
        expect(
          spreadHeight,
          "header block height drifts between routes",
        ).toBeLessThanOrEqual(TOLERANCE);
        expect(
          wrapped.map((m) => `${m.route}: ${m.explainerText}`),
          "a page explainer wraps to a second line at desktop width",
        ).toEqual([]);
      } else {
        // Every header is one or two lines of the same type scale — never a
        // third, which would mean a subtitle nobody trimmed.
        expect(
          measured.filter((m) => m.explainerLines > 2).map((m) => m.route),
          "a page explainer runs to three lines on a phone",
        ).toEqual([]);
      }
    });

    test(`cards share one header gap and one reading edge (${locale})`, async ({
      page,
    }) => {
      test.setTimeout(420_000);
      await page.context().addCookies([
        {
          name: "healthlog-locale",
          value: locale,
          url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
        },
      ]);

      const gaps: number[] = [];
      const insets: number[] = [];
      const expectedGap = cardGapFor(page.viewportSize()?.width ?? 1280);
      for (const route of ROUTES) {
        const response = await page.goto(route, {
          waitUntil: "domcontentloaded",
        });
        if (response && response.status() >= 400) continue;
        const heading = page
          .locator(
            'main h1:visible, main [role="heading"][aria-level="1"]:visible',
          )
          .first();
        if (!(await heading.isVisible().catch(() => false))) {
          await heading
            .waitFor({ state: "visible", timeout: 8_000 })
            .catch(() => {});
        }
        await settleBeforeMeasure(page, page.locator("main").first());
        for (const card of await measureCards(page)) {
          gaps.push(card.gap);
          insets.push(card.bodyInset);
        }
      }

      expect(gaps.length).toBeGreaterThan(30);

      const offGap = gaps.filter((g) => Math.abs(g - expectedGap) > TOLERANCE);
      const offEdge = insets.filter((i) => Math.abs(i) > TOLERANCE);
      console.log(
        `[${locale}] cards measured: ${gaps.length}; header→body ≠ ${expectedGap}px: ${offGap.length} (${[...new Set(offGap.map((g) => g.toFixed(1)))].join(", ")})\n` +
          `[${locale}] bodies off the card edge: ${offEdge.length} (${[...new Set(offEdge.map((i) => i.toFixed(1)))].join(", ")})`,
      );

      expect(offGap, "header→body gap is not the card's own gap").toEqual([]);
      expect(offEdge, "card body does not start at the card edge").toEqual([]);
    });

    test(`list cards keep one row rhythm (${locale})`, async ({ page }) => {
      test.setTimeout(420_000);
      await page.context().addCookies([
        {
          name: "healthlog-locale",
          value: locale,
          url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
        },
      ]);

      const offenders: string[] = [];
      let measured = 0;
      for (const route of ROUTES) {
        const response = await page.goto(route, {
          waitUntil: "domcontentloaded",
        });
        if (response && response.status() >= 400) continue;
        const heading = page
          .locator(
            'main h1:visible, main [role="heading"][aria-level="1"]:visible',
          )
          .first();
        if (!(await heading.isVisible().catch(() => false))) {
          await heading
            .waitFor({ state: "visible", timeout: 8_000 })
            .catch(() => {});
        }
        await settleBeforeMeasure(page, page.locator("main").first());
        for (const card of await measureListCards(page)) {
          measured += 1;
          const worstGap = Math.max(0, ...card.rowGaps);
          if (
            Math.abs(card.topInset) > TOLERANCE ||
            worstGap > TOLERANCE ||
            Math.abs(worstGap - Math.min(...card.rowGaps)) > TOLERANCE
          ) {
            offenders.push(
              `${route} (${card.slot}): first row inset ${card.topInset.toFixed(1)}px, ` +
                `between rows ${[...new Set(card.rowGaps.map((g) => g.toFixed(1)))].join("/")}px`,
            );
          }
        }
      }

      console.log(`[${locale}] list cards measured: ${measured}`);
      // The sweep has to actually find the ledgers it is about.
      expect(measured).toBeGreaterThan(0);
      expect(
        offenders,
        "a divided list card puts dead space above its rows that the first row does not have",
      ).toEqual([]);
    });
  });
}
