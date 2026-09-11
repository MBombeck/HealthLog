import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { SCOPE_A11Y_STORAGE_STATE_PATH } from "./setup/test-helpers";

/**
 * The five states of a shared record, each proved usable rather than merely
 * reachable.
 *
 * Accessibility work concentrates on the state where everything worked,
 * because that is the state the person building the screen is looking at. The
 * other four are where somebody who cannot see the screen is most stranded: a
 * spinner nobody announces, an error card that reads as an empty page, a
 * refusal whose only way out is a control no keyboard reaches. This file had
 * four tests for five states, success and empty shared one, and neither of
 * them entered an empty state at all.
 *
 * Each test now names its state in brackets, enters it, and runs four proofs:
 * an axe scan, the reading order, either a keyboard reach or an announcement,
 * and — where the state has copy somebody has to act on — that the copy is
 * content rather than muted meta.
 *
 * `src/__tests__/sharing-accessibility-states.test.tsx` reads this file back
 * against `tests/fixtures/v137/e2e-journeys.ts` and fails if a state loses its
 * test or one of its proofs. A browser suite reports what it ran, never what
 * it did not, so the enumeration lives where a fast test can check it.
 */

/** WCAG 2.1 AA, as the rest of the suite scans it. */
async function scanForViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

/**
 * The named elements appear in this order in the document.
 *
 * Reading order is what a screen reader follows and what a keyboard walks, and
 * CSS can put a control visually above an explanation while the DOM keeps it
 * below. Every selector must resolve: an absent element would otherwise make
 * an order of one trivially correct, which is the shape of check that passes
 * for the whole life of a regression.
 */
async function expectReaderOrder(page: Page, selectors: string[]) {
  expect(selectors.length).toBeGreaterThan(1);
  const positions = await page.evaluate((list) => {
    const all = Array.from(document.querySelectorAll("*"));
    return list.map((selector) => {
      const element = document.querySelector(selector);
      return element ? all.indexOf(element) : -1;
    });
  }, selectors);

  const missing = selectors.filter((_, i) => positions[i] === -1);
  expect(missing, `not on the page: ${missing.join(", ")}`).toEqual([]);
  expect(positions, `reading order is ${selectors.join(" then ")}`).toEqual(
    [...positions].sort((a, b) => a - b),
  );
}

/**
 * Tab from the top of the document until focus lands on the target.
 *
 * Real Tab presses rather than `element.focus()`, for two reasons: a control
 * that is present but not in the tab order fails here, which is the defect
 * this proves the absence of; and `:focus-visible` only applies to keyboard
 * focus, so the ring can be asserted at the same time. The invitation form's
 * own radios shipped `sr-only` inputs whose focus ring landed on a zero-size
 * box — the whole class of defect is invisible to `element.focus()`.
 */
async function expectKeyboardReach(page: Page, selector: string) {
  await expect(page.locator(selector).first()).toBeVisible();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });

  const MAX_TABS = 120;
  let reached = false;
  for (let i = 0; i < MAX_TABS && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(
      (sel) => document.activeElement?.matches(sel) ?? false,
      selector,
    );
  }
  expect(reached, `${selector} is not reachable by Tab`).toBe(true);

  // And the person can see where they are. A focusable control with no
  // visible indicator is WCAG 2.4.7 and is exactly what an `sr-only` input
  // produces.
  const outlined = await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return false;
    if (element.matches(":focus-visible")) return true;
    // Some rings are painted by an ancestor via `has-[:focus-visible]`.
    return Boolean(element.closest(":has(:focus-visible)"));
  }, selector);
  expect(outlined, `${selector} takes focus without showing it`).toBe(true);
}

/**
 * The state says out loud that it is happening.
 *
 * For the one state with nothing to press. A spinner is a picture; without a
 * live region and a label it is a blank page to a screen reader, and the hold
 * before the active record resolves is precisely when somebody must not be
 * told nothing.
 */
async function expectAnnounced(page: Page, selector: string) {
  const region = page.locator(selector).first();
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute("role", /status|alert/);
  const label = await region.evaluate((node) =>
    (node.textContent ?? "").trim(),
  );
  expect(label.length, `${selector} announces nothing`).toBeGreaterThan(0);
}

/**
 * Copy somebody has to act on is content, not meta.
 *
 * Two halves, and both are needed. The class check is the design standard —
 * UI-STANDARDS §3 reserves `text-muted-foreground` for meta, and consent or
 * safety text rendered as meta is text people skip. The ratio check is the
 * measurable one: it walks up for an opaque background and asserts the AA
 * floor for body text, so a future token change that keeps the class and
 * loses the contrast still fails.
 */
async function expectContentContrast(page: Page, selector: string) {
  const result = await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return null;

    const parse = (value: string): [number, number, number, number] | null => {
      const nums = value.match(/[\d.]+/g);
      if (!nums || nums.length < 3) return null;
      return [
        Number(nums[0]),
        Number(nums[1]),
        Number(nums[2]),
        nums.length > 3 ? Number(nums[3]) : 1,
      ];
    };

    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const channel = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };

    const foreground = parse(getComputedStyle(element).color);
    let node: Element | null = element;
    let background: [number, number, number, number] | null = null;
    while (node && !background) {
      const parsed = parse(getComputedStyle(node).backgroundColor);
      if (parsed && parsed[3] > 0) background = parsed;
      node = node.parentElement;
    }
    if (!foreground || !background) return null;

    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));

    // The class list of the element and of any descendant carrying the text:
    // the copy is sometimes a wrapper's child.
    const classes = [element, ...Array.from(element.querySelectorAll("*"))]
      .map((n) => n.className)
      .filter((c): c is string => typeof c === "string")
      .join(" ");

    return { ratio: (light + 0.05) / (dark + 0.05), classes };
  }, selector);

  expect(result, `${selector} is not on the page`).not.toBeNull();
  expect(
    result!.classes,
    `${selector} renders material copy in the muted token`,
  ).not.toContain("text-muted-foreground");
  expect(
    result!.ratio,
    `${selector} is below the AA floor for body text`,
  ).toBeGreaterThanOrEqual(4.5);
}

async function openProfileRecord(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
  const entry = page.locator(
    '[data-slot="account-switcher-entry"][data-account-username="e2e-scope-profile"]',
  );
  await expect(entry).toHaveCount(1);
  await entry.click();
  await expect(page).toHaveURL(/\/profile$/);
}

/**
 * Run an act that swaps the document out, and wait until it has.
 *
 * Exiting a record is a full navigation. A token stamped on the window before
 * the click is gone the moment the new document exists, which is the only
 * signal that the old one is not still the page under test.
 */
async function withDocumentReplacement(
  page: Page,
  act: () => Promise<void>,
): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __hlNavToken?: true }).__hlNavToken = true;
  });
  await act();
  await page.waitForFunction(
    () =>
      (window as Window & { __hlNavToken?: true }).__hlNavToken === undefined,
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * Leave the record and prove the own-record shell is back.
 *
 * Leaving replaces the document, and the protected shell renders its
 * hydration gate — no nav, no banner, no page body — until `/api/auth/me`
 * resolves. "The banner is gone" is true of that gate as well, so on its own
 * it is satisfied by the document on its way out and is not a wait at all.
 * The top bar only exists past the gate, so it is the anchor the absence
 * hangs on.
 */
async function leaveRecord(page: Page) {
  await withDocumentReplacement(page, () =>
    page.locator('[data-slot="shared-record-banner-exit"]').click(),
  );
  await expect(
    page.locator('[data-slot="record-scope-hydration-gate"]'),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-slot="top-bar"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-slot="shared-record-banner"]')).toHaveCount(
    0,
    { timeout: 30_000 },
  );
}

test.describe("shared record accessibility states", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: SCOPE_A11Y_STORAGE_STATE_PATH });

  test("[success] the shared profile is scannable, ordered and escapable", async ({
    page,
  }) => {
    await openProfileRecord(page);
    await expect(page.locator('[data-slot="profile-summary"]')).toBeVisible();

    await scanForViolations(page);
    // Whose record this is comes before what is in it. A reader who meets the
    // record before the banner has already read somebody else's health data
    // believing it is their own.
    await expectReaderOrder(page, [
      '[data-slot="shared-record-banner"]',
      '[data-slot="shared-record-banner-context"]',
      '[data-slot="profile-summary"]',
    ]);
    await expectContentContrast(
      page,
      '[data-slot="shared-record-banner-context"]',
    );
    await expectKeyboardReach(page, '[data-slot="shared-record-banner-exit"]');

    await leaveRecord(page);
  });

  test("[empty] nothing shared yet reads as an answer, not a failure", async ({
    page,
  }) => {
    // The delegate's own shared-access panel. They hold grants and have given
    // none, so the "who can open my record" card is genuinely empty — which is
    // a state the suite claimed to cover and never entered.
    await page.goto("/settings/access");
    await expect(
      page.locator('[data-slot="grants-given-card"] [data-slot="empty-state"]'),
    ).toBeVisible();

    await scanForViolations(page);
    await expectReaderOrder(page, [
      '[data-slot="grant-invite-card"]',
      '[data-slot="grants-given-card"]',
      '[data-slot="grants-given-card"] [data-slot="empty-state"]',
    ]);
    await expectContentContrast(
      page,
      '[data-slot="grants-given-card"] [data-slot="empty-state"] p',
    );
    // The way out of an empty state is the act that fills it.
    await expectKeyboardReach(page, '[data-slot="grant-invite-identifier"]');
  });

  test("[loading] the hold before the active record is known is announced", async ({
    page,
  }) => {
    const gate = '[data-slot="record-scope-hydration-gate"]';

    // Hold `/api/auth/me` open for exactly as long as the assertions need,
    // then release it once.
    //
    // A fixed sleep in the handler cannot do that, and it was the cause of a
    // CI-only failure here. Three things go wrong with it. The hold ends 1500
    // ms after the FIRST request whatever the axe scan is doing, so on a slow
    // runner the state being scanned is not the state the test names. Every
    // retry and every refetch queues another sleeping handler, so the number
    // of live handlers is a function of machine speed. And a handler still
    // sleeping when its request is cancelled — a navigation, a React Query
    // abort, teardown — answers `route.continue()` with "Route is already
    // handled", which is what the runner reported.
    //
    // An explicit gate fixes all three: one release, at a point the test
    // chooses, after which the hold is provably over.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holds = 0;

    await page.route("**/api/auth/me", async (route) => {
      holds += 1;
      await held;
      // Continuing a route the browser has already given up on is not a
      // failure of anything this test asserts, and it is the one call here
      // that can reject for a reason that has nothing to do with the subject.
      await route.continue().catch(() => {});
    });

    await page.goto("/measurements");
    await expect(page.locator(gate)).toBeVisible();

    await scanForViolations(page);
    await expectAnnounced(page, gate);
    // The label lives inside the region, so a reader that reaches the region
    // reaches the sentence. A label rendered as a sibling would be announced
    // separately or not at all.
    await expectReaderOrder(page, [gate, `${gate} .sr-only`]);

    // The hold was real. Without this the whole test passes on a page that was
    // merely slow, and the state it claims to have scanned would be a
    // coincidence rather than something it caused.
    expect(
      holds,
      "nothing was held, so the gate was not this test's doing",
    ).toBeGreaterThan(0);

    release();
    await page.unroute("**/api/auth/me");
    // And the gate was waiting on that hold rather than on something else:
    // releasing it ends the state. An entry assertion with no exit assertion
    // cannot tell a hold apart from a stuck page.
    await expect(page.locator(gate)).toHaveCount(0);
  });

  test("[error] a failed read says so and hands the retry to a keyboard", async ({
    page,
  }) => {
    await page.route("**/api/profile/summary**", (route) =>
      route.fulfill({ status: 500, body: "{}" }),
    );
    await openProfileRecord(page);
    await expect(page.locator('[data-slot="query-error-card"]')).toBeVisible();

    await scanForViolations(page);
    await expectReaderOrder(page, [
      '[data-slot="shared-record-banner"]',
      '[data-slot="query-error-card"]',
      '[data-slot="query-error-retry"]',
    ]);
    // The sentence that says the read failed. Muted here would put "this did
    // not load" in the same register as a timestamp.
    await expectContentContrast(page, '[data-slot="query-error-card"] p');
    await expectKeyboardReach(page, '[data-slot="query-error-retry"]');

    await page.unroute("**/api/profile/summary**");
    await leaveRecord(page);
  });

  test("[refusal] a surface sharing does not cover keeps a way back", async ({
    page,
  }) => {
    await openProfileRecord(page);
    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();

    await scanForViolations(page);
    // The explanation before the button. A reader who meets "leave this
    // record" first is being offered an act before being told why.
    await expectReaderOrder(page, [
      '[data-slot="shared-record-unavailable"]',
      '[data-slot="shared-record-unavailable"] p',
      '[data-slot="shared-record-unavailable-leave"]',
    ]);
    await expectContentContrast(
      page,
      '[data-slot="shared-record-unavailable"] p',
    );
    await expectKeyboardReach(
      page,
      '[data-slot="shared-record-unavailable-leave"]',
    );

    await page.locator('[data-slot="shared-record-unavailable-leave"]').click();
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toHaveCount(0);
  });
});
