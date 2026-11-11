"use client";

/**
 * Old deep links into cards that moved to another Settings page.
 *
 * A path that moved is a server redirect (`next.config.ts`), but a card that
 * moved while its page stayed cannot be: the `#anchor` never reaches the
 * server. Bookmarks, cross-links in older notifications and the docs point at
 * `/settings/privacy#sessions` and the like, so the shell forwards a known
 * anchor on a known page to the card's new home, on arrival and when a
 * same-page link changes only the hash.
 *
 * `SETTINGS_ANCHOR_FORWARDS` is also read by the legacy-routes guard, which
 * proves every target lands on a page that exists.
 */

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

export const SETTINGS_ANCHOR_FORWARDS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  // v1.44 — sessions, trusted devices and the security activity joined the
  // other sign-in controls under Security; the duplicate export card left.
  "/settings/privacy": {
    sessions: "/settings/security#sessions",
    "trusted-devices": "/settings/security#trusted-devices",
    "security-activity": "/settings/security#security-activity",
    "your-data-export": "/settings/export",
  },
  // v1.44 — the proactive nudges are a reminder and live with the others.
  "/settings/coach": {
    "coach-nudge": "/settings/notifications#coach-nudge",
  },
  // v1.44 — Arrangement holds order and view only; each module's own
  // settings moved to its page under Modules.
  "/settings/layout/labs": {
    "labs-local-ocr": "/settings/modules/labs#labs-local-ocr",
    "labs-biomarkers": "/settings/modules/labs#labs-biomarkers",
  },
  "/settings/layout/medications": {
    "injection-sites": "/settings/modules/medications#injection-sites",
  },
  "/settings/layout/checkups": {
    "screening-hints": "/settings/anamnesis#screening-hints",
    "vorsorge-reminders": "/settings/notifications#vorsorge-reminders",
  },
};

/** Where an anchor on a page now lives, or null when it did not move. */
export function forwardedAnchorTarget(
  pathname: string,
  hash: string,
): string | null {
  const anchor = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!anchor) return null;
  return SETTINGS_ANCHOR_FORWARDS[pathname]?.[anchor] ?? null;
}

/**
 * Forward now, and again whenever only the hash changes: a same-page link to
 * a moved anchor is no navigation, so an arrival check alone never sees it.
 * Returns the unsubscribe.
 */
export function watchAnchorForwards(
  pathname: string,
  replace: (target: string) => void,
  win: Pick<Window, "addEventListener" | "removeEventListener"> & {
    location: { hash: string };
  } = window,
): () => void {
  const forward = () => {
    const target = forwardedAnchorTarget(pathname, win.location.hash);
    if (target) replace(target);
  };
  forward();
  win.addEventListener("hashchange", forward);
  return () => win.removeEventListener("hashchange", forward);
}

export function SettingsAnchorForward() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!pathname) return;
    return watchAnchorForwards(pathname, (target) => router.replace(target));
  }, [pathname, router]);

  return null;
}
