"use client";

import { useEffect } from "react";

/**
 * Pure predicate for whether app-wide SW registration should proceed.
 * Extracted so the production + capability gating is unit-testable without
 * a DOM/effect harness. The registrar's `useEffect` calls this before it
 * touches `navigator.serviceWorker`.
 */
export function shouldRegisterServiceWorker(
  nodeEnv: string | undefined,
  hasWindow: boolean,
  hasServiceWorker: boolean,
): boolean {
  if (nodeEnv !== "production") return false;
  if (!hasWindow) return false;
  if (!hasServiceWorker) return false;
  return true;
}

/**
 * Earlier releases set a dose count on the installed app's icon, and nothing
 * sets one now, so a leftover count would stay for good. Cleared from the page
 * of the installed app only, where the badge exists; never from the worker,
 * where the call can stall Chromium's worker thread.
 */
export function clearLeftoverAppBadge(win: Window): void {
  const standalone =
    win.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const nav = win.navigator as Navigator & {
    clearAppBadge?: () => Promise<void>;
  };
  if (!standalone || typeof nav.clearAppBadge !== "function") return;
  nav.clearAppBadge().catch(() => undefined);
}

/**
 * App-wide service-worker registration.
 *
 * Until this component shipped, `/sw.js` was registered exactly once —
 * inside the Web-Push opt-in (`web-push-card.tsx`). Every user who never
 * enabled notifications ran with no SW at all, so the offline shell cache,
 * the precached app shell, and the network-first page cache were inert. This
 * mounts the registration for everyone, gated on production.
 *
 * Lifecycle owner split: this component only INSTALLS the worker. The
 * update→reload path stays solely with `<VersionPoller>` (polls
 * `/api/version`, then unregister + cache-wipe + reload on a server-ahead
 * deploy). No `updatefound` / `controllerchange` handling lives here — a
 * second reload trigger would double-fire against the poller and risk a loop.
 */
export function ServiceWorkerRegistrar(): null {
  useEffect(() => {
    // Production only: dev lacks the generated `/sw-version.js` (written by
    // the `prebuild` step), and a caching SW fights HMR. `process.env.
    // NODE_ENV` is inlined into the client bundle at build time.
    if (
      !shouldRegisterServiceWorker(
        process.env.NODE_ENV,
        typeof window !== "undefined",
        typeof navigator !== "undefined" && "serviceWorker" in navigator,
      )
    ) {
      return;
    }

    const register = () => {
      const idle =
        (window as unknown as { requestIdleCallback?: typeof setTimeout })
          .requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1));
      idle(() => {
        navigator.serviceWorker
          // `updateViaCache: "none"` forces the browser to byte-check
          // `/sw.js` (and its `importScripts('/sw-version.js')`) against the
          // network on every update check rather than honouring the HTTP
          // cache — without it a cached `sw.js` can mask a new deploy and the
          // worker never sees the new `CACHE_VERSION`.
          .register("/sw.js", { scope: "/", updateViaCache: "none" })
          .catch(() => {
            /* best effort — registration failure must never break the app */
          });
        clearLeftoverAppBadge(window);
      });
    };

    // Defer to `load` (+ idle) so install/precache never contends with the
    // first-paint critical path. If the window already fired `load`, run now.
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
