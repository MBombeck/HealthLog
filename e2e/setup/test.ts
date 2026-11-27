/**
 * The E2E suite's `test` / `expect` entry point.
 *
 * Every spec imports from here instead of from `@playwright/test`, and the
 * structural guard `src/__tests__/e2e-route-cleanup-guard.test.ts` keeps it
 * that way.
 *
 * ## Why
 *
 * A spec that registers `page.route(...)` in a `beforeEach` leaves the handler
 * armed until the context closes. If the handler is async — `route.fetch()`,
 * an `await` before `route.fulfill()` — teardown can close the context while
 * one invocation is still in flight. The callback then rejects against a dead
 * target, Playwright attributes the rejection to the test that just finished,
 * and a test that had already passed is reported as failed. With `retries: 2`
 * plus `failOnFlakyTests` on CI, that is a release blocker whose trigger is
 * timing, not code.
 *
 * The remedy Playwright names is `unrouteAll({ behavior: "ignoreErrors" })`
 * before the test ends. Written per spec that is 36 copies of the same three
 * lines and one forgotten copy away from the same failure. Written as an auto
 * fixture it happens for every test in the suite, including specs nobody has
 * written yet, and a spec author never has to know it exists.
 *
 * ## What it covers
 *
 * - `page.route(...)` on every page in the test's context.
 * - `context.route(...)` on the context itself.
 * - Page event listeners for the interactive event types a spec subscribes to.
 *   A listener that awaits something (a `dialog` handler, a `response` handler
 *   that reads a body) can reject after teardown for exactly the same reason a
 *   route handler can.
 *
 * ## What it does not cover
 *
 * A page that lives in a context the spec created itself — `browser.newContext()`
 * inside a helper — is invisible here, because this fixture can only see the
 * context Playwright built for the test. `share-documents.spec.ts` is the one
 * spec that does this; it owns those contexts and has to clean them up itself.
 */
import { test as base, expect } from "@playwright/test";

/**
 * Page event types cleared at teardown. Deliberately not the lifecycle events
 * (`close`, `crash`, `frameattached`, …): those describe the teardown we are
 * standing in, and nothing in the suite hangs work off them. These are the
 * types a spec attaches a handler to, and the ones whose handler can still be
 * running when the context goes away.
 */
const OBSERVED_PAGE_EVENTS = [
  "console",
  "dialog",
  "download",
  "filechooser",
  "pageerror",
  "popup",
  "request",
  "requestfailed",
  "requestfinished",
  "response",
  "websocket",
  "worker",
] as const;

/**
 * Setup steps, import forms and long notes fold under a card's own "Set up",
 * "Import" or "Learn more" (`data-fold` on the `<details>`). A journey spec
 * drives what is inside them, so every page opens its folds as they mount
 * unless a spec opts out with `test.use({ openFolds: false })`, which the text
 * budget spec does to count the page as a reader first meets it.
 */
const OPEN_FOLDS_SCRIPT = () => {
  const open = () => {
    for (const el of document.querySelectorAll("details[data-fold]")) {
      if (!(el as HTMLDetailsElement).open)
        (el as HTMLDetailsElement).open = true;
    }
  };
  new MutationObserver(open).observe(document, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("DOMContentLoaded", open);
};

export const test = base.extend<{ routeCleanup: void; openFolds: boolean }>({
  openFolds: [true, { option: true }],
  page: async ({ page, openFolds }, provide) => {
    if (openFolds) await page.addInitScript(OPEN_FOLDS_SCRIPT);
    await provide(page);
  },
  routeCleanup: [
    async ({ context }, use) => {
      await use();

      // Best-effort: a spec is free to close its own context (or the browser
      // can die under it), and a teardown helper must never be the thing that
      // turns a green run red. Everything below is a cleanup, so a failure to
      // clean up has nothing left to protect.
      try {
        for (const page of context.pages()) {
          await page.unrouteAll({ behavior: "ignoreErrors" });
          for (const event of OBSERVED_PAGE_EVENTS) {
            await page.removeAllListeners(event, { behavior: "ignoreErrors" });
          }
        }
        await context.unrouteAll({ behavior: "ignoreErrors" });
      } catch {
        // Target already gone — nothing left to unroute.
      }
    },
    { auto: true },
  ],
});

export { expect };
