import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { FENCE_OFFLINE_STORAGE_STATE_PATH } from "./setup/test-helpers";

/**
 * FENCE-AC-07: no record's API answers are kept in CacheStorage, before or
 * after a record switch.
 *
 * Runs in the `chromium-service-worker` project with the worker allowed and
 * no route mocks, because the claim is about what the worker itself stores.
 * The worker passes every `/api/` request to the network and keeps none of
 * them; the only per-account layer on disk is the IndexedDB snapshot, which
 * refuses to write or restore inside another record (unit-tested in
 * `query-persister-shared-record.test.ts`).
 *
 * The positive control is the page cache: the worker is running and storing
 * something (public pages, catalogs, icons), so "no API entry" is not the
 * same sentence as "the worker did nothing".
 */

/** Pages whose reads used to be kept on disk. Visited, so the reads are the app's own. */
const WARM_PAGES = ["/", "/measurements", "/medications"] as const;

/**
 * A WHOLE-record READ grant, deliberately not a narrowed one.
 *
 * The narrowed `e2e-scope-labs` fixture opens only its labs section, so the
 * nav drops the other destinations and the record reads this file drives are
 * refused as out-of-scope before the fence ever matters. Section narrowing is
 * `v137-sharing-managed-profiles.spec.ts`'s subject; here it is noise that
 * hides the thing under test.
 */
const TARGET_USERNAME = "e2e-level-read";

async function openSwitcher(page: Page) {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
}

/**
 * Enter the target record, retrying the click if the switch did not land.
 *
 * See the twin in `v137-record-session-fence.spec.ts`: the switch is a
 * compare-and-set the client retries exactly once, and a harness driving it at
 * machine speed can legitimately lose twice. Bounded, and a third failure is a
 * real one.
 */
async function enterRecord(page: Page) {
  const banner = page.locator('[data-slot="shared-record-banner"]');
  for (let attempt = 0; attempt < 3; attempt++) {
    await openSwitcher(page);
    const entry = page.locator(
      `[data-slot="account-switcher-entry"][data-account-username="${TARGET_USERNAME}"]`,
    );
    await expect(entry).toBeVisible();
    const accountId = await entry.getAttribute("data-account-id");
    await entry.click();
    try {
      await expect(banner).toBeVisible({ timeout: 15_000 });
      return accountId;
    } catch {
      await page.goto("/");
      await expectShellReady(page);
    }
  }
  await expect(banner).toBeVisible({ timeout: 15_000 });
  return null;
}

async function expectShellReady(page: Page) {
  await expect(
    page.locator('[data-slot="record-scope-hydration-gate"]'),
    // A real budget, not the 10 s default. The gate IS the cross-tab hold: a
    // peer sits behind it until its own `/api/auth/me` resolves, and that read
    // queues behind whatever the other worker's browser is doing. Ten seconds
    // is a statement about machine load; thirty is about the hold actually
    // never releasing, which is the failure worth reporting.
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "User menu" })).toBeVisible({
    timeout: 30_000,
  });
}

/** Every HealthLog cache and the API answers it holds. */
async function cacheState(page: Page) {
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter((n) =>
      n.startsWith("healthlog-"),
    );
    const apiEntries: string[] = [];
    let entries = 0;
    for (const name of names) {
      for (const request of await (await caches.open(name)).keys()) {
        entries += 1;
        const { pathname } = new URL(request.url);
        if (pathname.startsWith("/api/")) apiEntries.push(pathname);
      }
    }
    return { names, entries, apiEntries };
  });
}

test.describe.serial("FENCE-AC-07 record-fence disk layers", () => {
  test("FENCE-AC-07 no record's API answers are kept on disk across a switch", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: FENCE_OFFLINE_STORAGE_STATE_PATH,
    });
    const page = await context.newPage();

    try {
      await page.goto("/");
      await expect(
        page.getByRole("button", { name: "User menu" }),
      ).toBeVisible();
      await expectShellReady(page);
      // The session is shared with the other sharing journeys, so "not inside
      // a record" is not something a fresh page can assume.
      const banner = page.locator('[data-slot="shared-record-banner"]');
      if ((await banner.count()) > 0) {
        await page.locator('[data-slot="shared-record-banner-exit"]').click();
        await expect(banner).toHaveCount(0);
      }
      await page.waitForFunction(
        () => navigator.serviceWorker?.controller !== null,
        undefined,
        { timeout: 20_000 },
      );

      for (const path of WARM_PAGES) {
        await page.goto(path);
        // Spelled out rather than left inside `expectShellReady`, because the
        // next act is a one-shot `page.evaluate` and
        // `src/__tests__/e2e-measurement-gating-guard.test.ts` reads the source
        // text between the navigation and the read.
        await expect(
          page.getByRole("button", { name: "User menu" }),
        ).toBeVisible();
        await expectShellReady(page);
      }

      // POSITIVE CONTROL: the worker controls the page and keeps something.
      await expect
        .poll(async () => (await cacheState(page)).entries, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      const own = await cacheState(page);
      expect(own.apiEntries).toEqual([]);
      expect(own.names.filter((n) => n.startsWith("healthlog-data-"))).toEqual(
        [],
      );

      await enterRecord(page);
      for (const path of WARM_PAGES) {
        await page.goto(path);
        await expect(
          page.getByRole("button", { name: "User menu" }),
        ).toBeVisible();
        await expectShellReady(page);
      }

      const inside = await cacheState(page);
      expect(inside.apiEntries).toEqual([]);
      expect(
        inside.names.filter((n) => n.startsWith("healthlog-data-")),
      ).toEqual([]);
    } finally {
      // Hand the shared session back to its own record; see the note in
      // `v137-record-session-fence.spec.ts`.
      await context.request
        .post("/api/account/switch", { data: { accountId: null } })
        .catch(() => {});
      await context.close();
    }
  });
});
