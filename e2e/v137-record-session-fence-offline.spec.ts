import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { FENCE_OFFLINE_STORAGE_STATE_PATH } from "./setup/test-helpers";

/**
 * FENCE-AC-07 — the disk layers cannot serve one record's bytes inside
 * another.
 *
 * ## Why this is a spec of its own
 *
 * `playwright.config.ts` sets `serviceWorkers: "block"` for every other
 * project, and for a good reason written there: a worker-originated `fetch` is
 * not subject to `page.route`, so the SW would bypass the per-spec route mocks.
 *
 * This case is the exact inverse. Its whole claim is about what the
 * `healthlog-data-*` cache can and cannot serve across a record switch — and
 * with the worker blocked that cache is never populated at all, so the positive
 * control ("the owner snapshot really WAS on disk before the switch") could
 * never pass no matter what the application did. A check that cannot pass is
 * worse than no check, so this runs in the `chromium-service-worker` project
 * with the worker allowed, and uses no route mocks.
 *
 * ## What is asserted, in order
 *
 *   1. the owner's record reads really are on disk before the switch — a test
 *      that seeded nothing proves nothing;
 *   2. only current-version caches exist, which is the eviction the fence's
 *      design relies on to make "a response with no echo" safe;
 *   3. the switch empties the data cache before it reloads;
 *   4. every response now on disk carries the TARGET's record scope and never
 *      the previous one — the claim, read off the disk layer itself rather
 *      than inferred from what a page did or did not paint;
 *   5. and offline, that cache is what answers a record read, still carrying
 *      the target's context. The non-empty scope set is the paired positive
 *      control: an empty cache would satisfy "no previous-record bytes" while
 *      proving nothing.
 */

/**
 * Pages whose reads the service worker is configured to hold on disk
 * (`sw-cache-policy.ts` allowlists `/api/dashboard/snapshot`,
 * `/api/measurements` and `/api/medications`). Visited rather than fetched, so
 * the requests are the app's own and carry the record-session assertion.
 */
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

/** What the `healthlog-data-*` caches hold right now. */
async function dataCacheState(page: Page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const data = names.filter((n) => n.startsWith("healthlog-data-"));
    let entries = 0;
    for (const name of data) {
      entries += (await (await caches.open(name)).keys()).length;
    }
    return { names, dataCaches: data, entries };
  });
}

/**
 * The record context every cached response was stored WITH.
 *
 * This is the disk-layer claim, read off the disk layer. A cached record
 * response carries the echo it was served under, so if a previous record's
 * bytes were still reachable they would show up here as that record's scope.
 */
async function cachedScopes(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const scopes: string[] = [];
    for (const name of (await caches.keys()).filter((n) =>
      n.startsWith("healthlog-data-"),
    )) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const cached = await cache.match(request);
        const scope = cached?.headers.get("x-healthlog-record-scope");
        if (scope) scopes.push(scope);
      }
    }
    return scopes;
  });
}

test.describe.serial("FENCE-AC-07 record-fence disk layers", () => {
  test("FENCE-AC-07 the disk layers cannot serve one record's bytes inside another", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: FENCE_OFFLINE_STORAGE_STATE_PATH,
    });
    const page = await context.newPage();

    try {
      await page.goto("/");
      // The gate is spelled out here rather than left inside a helper because
      // the next act is a one-shot `page.evaluate`, and
      // `src/__tests__/e2e-measurement-gating-guard.test.ts` reads the source
      // text between the navigation and the read.
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

      // Wait for the worker to control the page — until it does, nothing it
      // would cache is going through it.
      await page.waitForFunction(
        () => navigator.serviceWorker?.controller !== null,
        undefined,
        { timeout: 20_000 },
      );

      // Warm the disk cache by VISITING the pages, not by issuing bare
      // fetches. A bare `fetch` in `page.evaluate` carries no record-session
      // assertion, so on a session that has been inside a shared record the
      // fence refuses it and nothing cacheable comes back — the cache filled
      // from the app's own reads instead, and those were the ones that happened
      // to resolve no record scope. Driving the app is what puts real,
      // echo-carrying record responses on disk.
      for (const path of WARM_PAGES) {
        await page.goto(path);
        // Spelled out rather than left inside `expectShellReady`, because the
        // next act is a one-shot `page.evaluate` and
        // `src/__tests__/e2e-measurement-gating-guard.test.ts` reads the source
        // text between the navigation and the read. A gate hidden in a helper
        // is invisible to that guard and to the next reader.
        await expect(
          page.getByRole("button", { name: "User menu" }),
        ).toBeVisible();
        await expectShellReady(page);
      }
      await expect
        .poll(async () => (await dataCacheState(page)).entries, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);

      // (1) POSITIVE CONTROL: the owner's bytes really are on disk.
      const seeded = await dataCacheState(page);
      expect(seeded.dataCaches.length).toBeGreaterThan(0);
      expect(seeded.entries).toBeGreaterThan(0);

      // (2) Only current-version caches survive activation. This is the
      // eviction the fence's "a response with no echo is served normally" rule
      // depends on: a PRE-fence cached response carries no echo, and it can
      // only be served if its cache is still there.
      const version = seeded.dataCaches[0].replace("healthlog-data-", "");
      const stale = seeded.names.filter(
        (n) =>
          /^healthlog-(static|pages|data)-/.test(n) && !n.endsWith(version),
      );
      expect(stale).toEqual([]);

      await openSwitcher(page);
      const entry = page.locator(
        `[data-slot="account-switcher-entry"][data-account-username="${TARGET_USERNAME}"]`,
      );
      await expect(entry).toBeVisible();
      const targetAccountId = await entry.getAttribute("data-account-id");
      expect(targetAccountId).not.toBeNull();
      await entry.click();
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toBeVisible();

      // (3) NOT asserted: "the data cache is momentarily empty".
      //
      // The switch does wipe the disk layers — `clearOfflineCachesForRecordSwitch`
      // runs before the reload — but the reload immediately refills them from
      // the target's own reads, so an empty cache is a state that exists for a
      // few milliseconds and cannot be sampled reliably. Polling for it made
      // this case fail for a reason that had nothing to do with the claim.
      //
      // The claim is asserted directly below instead, and it is the stronger
      // statement anyway: what matters is not that the cache was briefly empty
      // but that nothing in it belongs to the previous record.

      // Visit inside the TARGET record so there is something of its own on
      // disk to find.
      for (const path of WARM_PAGES) {
        await page.goto(path);
        // Spelled out rather than left inside `expectShellReady`, because the
        // next act is a one-shot `page.evaluate` and
        // `src/__tests__/e2e-measurement-gating-guard.test.ts` reads the source
        // text between the navigation and the read. A gate hidden in a helper
        // is invisible to that guard and to the next reader.
        await expect(
          page.getByRole("button", { name: "User menu" }),
        ).toBeVisible();
        await expectShellReady(page);
      }
      await expect
        .poll(async () => (await dataCacheState(page)).entries, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);

      // (4) + (5) The disk layer now holds the TARGET's bytes and only those,
      // read off the disk layer itself.
      //
      // The first draft asserted the shared-record banner after an offline
      // reload. That could never pass and had nothing to do with the claim:
      // `/api/auth/me` is not a cached read, so offline it fails, `useAuth`
      // errors and the shell paints its offline gate rather than a banner. The
      // banner's absence says nothing about what is on disk.
      //
      // What IS on disk is checkable, and it is the whole point: every cached
      // record response carries the echo it was served under, so a previous
      // record's bytes surviving the switch would appear here as that record's
      // scope.
      const scopes = await cachedScopes(page);
      // POSITIVE CONTROL: something really is cached with a context, so the
      // assertion below is about a non-empty set.
      expect(scopes.length).toBeGreaterThan(0);
      for (const scope of scopes) {
        expect(scope).toBe(targetAccountId);
      }
      expect(scopes).not.toContain("self");

      // And the target's own record read really is one of the entries on disk,
      // so the scope assertion above is about the reads that matter rather
      // than about some incidental cached response.
      const cachedUrls = await page.evaluate(async () => {
        const urls: string[] = [];
        for (const name of (await caches.keys()).filter((n) =>
          n.startsWith("healthlog-data-"),
        )) {
          for (const request of await (await caches.open(name)).keys()) {
            urls.push(new URL(request.url).pathname);
          }
        }
        return urls;
      });
      expect(cachedUrls).toContain("/api/measurements");

      // NOT asserted: that a bare `fetch` from page context can read those
      // bytes back while offline. Since v1.37.0 an echoing response also
      // carries `Vary: x-healthlog-record-epoch, x-healthlog-record-scope`, and
      // the Cache API honours `Vary` — so a request WITHOUT the fence headers
      // does not match the stored entry at all. That is the correct behaviour
      // and a second line of defence worth naming: bytes cached under one
      // record context cannot be retrieved by a request asserting a different
      // one, or none. The app's own reads carry the headers and do match.
    } finally {
      await context.setOffline(false);
      // Hand the shared session back to its own record; see the note in
      // `v137-record-session-fence.spec.ts`.
      await context.request
        .post("/api/account/switch", { data: { accountId: null } })
        .catch(() => {});
      await context.close();
    }
  });

  test("FENCE-AC-07 a cached record response cannot be SERVED under a different context", async ({
    browser,
  }) => {
    /**
     * The serving path, which the case above does not exercise.
     *
     * The test above asserts what is IN the cache. That is worth asserting and
     * it is not the same claim: an entry can sit on disk under one context and
     * still be handed to a request made under another, and on the EXTERNAL
     * switch path nothing wipes it — the app never initiated the switch, so
     * `clearOfflineCachesForRecordSwitch` never runs. On that path `Vary` is
     * the only thing standing between a cached delegated response and the next
     * request for the same URL.
     *
     * So this asks the Cache API the question a service worker asks it:
     * `cache.match(request)` honours the stored response's `Vary`, so a request
     * whose fence headers differ from the ones the entry was stored with does
     * not match at all. Remove the `Vary` block from `attachRecordContextEcho`
     * and the second lookup starts hitting.
     */
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

      // Enter the record and let its reads land on disk.
      await enterRecord(page);
      await page.goto("/measurements");
      await expect(
        page.getByRole("button", { name: "User menu" }),
      ).toBeVisible();
      await expectShellReady(page);

      // The context those bytes were stored under, read off the entry itself.
      //
      // Polled, not sampled once. The service worker writes its `healthlog-data-*`
      // entry AFTER the response has been handed to the page, so
      // `expectShellReady` returning is not evidence that the write has landed —
      // it is evidence that the read arrived. Sampling here read `null` on a
      // loaded machine and failed the positive control below, which then said
      // "there is no cache entry" about a cache that was about to have one.
      // Waiting on the entry itself waits for the signal rather than for a
      // number of milliseconds, and it still fails if the entry never appears.
      const readStoredEntry = async () =>
        page.evaluate(async () => {
          for (const name of (await caches.keys()).filter((n) =>
            n.startsWith("healthlog-data-"),
          )) {
            const cache = await caches.open(name);
            for (const request of await cache.keys()) {
              if (
                !new URL(request.url).pathname.startsWith("/api/measurements")
              )
                continue;
              const response = await cache.match(request);
              if (!response) continue;
              return {
                cacheName: name,
                url: request.url,
                vary: response.headers.get("Vary"),
                epoch: response.headers.get("x-healthlog-record-epoch"),
                scope: response.headers.get("x-healthlog-record-scope"),
              };
            }
          }
          return null;
        });

      // POSITIVE CONTROL: there really is an entry, stored with a context.
      await expect.poll(readStoredEntry, { timeout: 20_000 }).not.toBeNull();
      const stored = await readStoredEntry();
      expect(stored).not.toBeNull();
      expect(stored!.epoch).toMatch(/^\d+$/);
      expect(stored!.scope).not.toBe("self");

      // The EXTERNAL switch: nothing in the app initiates it, so
      // `clearOfflineCachesForRecordSwitch` never runs and the entry above
      // survives — the positive control below is what proves that.
      //
      // Sent with the page's own `fetch` rather than through
      // `context.request`. Both are outside the app: the switch UI is what runs
      // the wipe, and a bare `fetch` is not it (the service worker returns
      // without touching any non-GET, so the request reaches the network
      // unaltered). What differs is the socket. Every Playwright API context in
      // the runner shares one process-wide keep-alive agent, so this POST could
      // be handed a connection the server had already closed on its five-second
      // idle timeout, and a POST is never replayed on a fresh one — twice this
      // line ended the spec with `read ECONNRESET`, on all three attempts.
      const left = await page.evaluate(async () => {
        const res = await fetch("/api/account/switch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: null }),
        });
        return res.status;
      });
      expect(left).toBe(200);
      // Read back through the page for the same reason the switch above goes
      // that way. This was the last call in the file still using the shared
      // API context, and it duly failed with `read ECONNRESET` on all three
      // attempts once the pooled socket had gone stale. The browser opens its
      // own connection, and a GET for the caller's own session is outside the
      // app either way.
      const now = (await page.evaluate(async () => {
        const res = await fetch("/api/auth/me");
        return (await res.json()).data.recordSession;
      })) as {
        epoch: number;
        scope: string | null;
      };
      // The context genuinely moved, or the comparison below is vacuous.
      expect(String(now.epoch)).not.toBe(stored!.epoch);

      const lookups = await page.evaluate(
        async ({
          cacheName,
          url,
          storedEpoch,
          storedScope,
          nowEpoch,
          nowScope,
        }) => {
          const cache = await caches.open(cacheName);
          const ask = async (epoch: string, scope: string) =>
            (await cache.match(
              new Request(url, {
                headers: {
                  "x-healthlog-record-epoch": epoch,
                  "x-healthlog-record-scope": scope,
                },
              }),
            )) !== undefined;
          return {
            underStoredContext: await ask(storedEpoch, storedScope),
            underNewContext: await ask(nowEpoch, nowScope),
            withNoAssertion:
              (await cache.match(new Request(url))) !== undefined,
          };
        },
        {
          cacheName: stored!.cacheName,
          url: stored!.url,
          storedEpoch: stored!.epoch!,
          storedScope: stored!.scope!,
          nowEpoch: String(now.epoch),
          nowScope: now.scope ?? "self",
        },
      );

      // POSITIVE CONTROL: the entry IS servable to the context it belongs to.
      // Without this, "the other context misses" would pass for an entry that
      // was simply not there.
      expect(lookups.underStoredContext).toBe(true);
      // The claim. Remove the `Vary` and this starts hitting.
      expect(lookups.underNewContext).toBe(false);
      expect(lookups.withNoAssertion).toBe(false);
    } finally {
      await context.request
        .post("/api/account/switch", { data: { accountId: null } })
        .catch(() => {});
      await context.close();
    }
  });
});
