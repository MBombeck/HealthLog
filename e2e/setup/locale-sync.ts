/**
 * Wait until this tab's locale write to the account has landed.
 *
 * Every signed-in page mounts `LocaleServerSyncBridge`, which sends
 * `PUT /api/auth/me/locale` once per tab, account and locale. The reply sets
 * the `healthlog-locale` cookie to the locale the page was showing, and the
 * request goes out with `keepalive`, so it outlives the page: navigating away
 * does not cancel it.
 *
 * That makes a cookie swap racy for any spec that loads a page and then pins a
 * different locale. The page is parked, the new cookie is written, and the
 * first page's reply arrives a moment later and writes the old locale back
 * over it. The next navigation then renders in the old language. Nothing in
 * the page shows the request in flight, so the only safe order is to let it
 * land first.
 *
 * The bridge records the write in `sessionStorage` once the reply is in, and
 * by then the browser has applied its cookie. So this polls for that record,
 * keyed on the account `/api/auth/me` names and the locale `<html lang>`
 * carries, which are the two values the bridge keys it on. A page that is not
 * on the app's origin has no bridge and nothing in flight, and returns at once.
 */
import type { Page } from "@playwright/test";

import { expect } from "./test";

/** The bridge's `sessionStorage` key (`src/lib/i18n/context.tsx`). */
const LOCALE_SYNCED_KEY = "healthlog-locale-synced";

export async function settleLocaleSync(page: Page): Promise<void> {
  if (!page.url().startsWith("http")) return;
  await expect
    .poll(
      () =>
        page.evaluate(async (key) => {
          const res = await fetch("/api/auth/me", {
            credentials: "same-origin",
          });
          if (!res.ok) return `/api/auth/me answered ${res.status}`;
          const body = (await res.json()) as { data?: { id?: string } };
          const want = `${body.data?.id}:${document.documentElement.lang}`;
          const have = sessionStorage.getItem(key);
          return have === want ? "synced" : `${have ?? "nothing"} != ${want}`;
        }, LOCALE_SYNCED_KEY),
      {
        message: "the tab's locale write never landed",
        timeout: 30_000,
      },
    )
    .toBe("synced");
}
