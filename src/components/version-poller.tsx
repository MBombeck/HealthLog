"use client";

import { useEffect } from "react";

/**
 * v1.4.38.4 — runtime self-heal for the stale-shell post-deploy
 * paper-cut.
 *
 * After a release the cached SPA shell still references the old
 * chunk filenames; the running React tree lazy-loads them, the new
 * server 404s them, and the user lands on `ChunkLoadError`. The
 * v1.4.38.3 `AppError` boundary added a one-shot
 * `window.location.reload()` for that case, but it only fires AFTER
 * the user trips the error — typically in the middle of a
 * navigation flow.
 *
 * This component runs the check pro-actively. Every 60 s it fetches
 * `/api/version` and compares the live version string against
 * `NEXT_PUBLIC_APP_VERSION` (injected from `package.json` at build
 * time by `next.config.ts`). When the live version moves ahead of
 * the running shell:
 *
 *   1. Unregister every active service worker so the next page load
 *      doesn't reinstall the old SW.
 *   2. Delete every CacheStorage entry so the precached root HTML
 *      and the `/_next/static/*` chunks from the previous deploy
 *      can't be served back.
 *   3. `window.location.reload()` — fetches the fresh shell + new
 *      chunk graph.
 *
 * `sessionStorage` gates the reload to once per session so a misset
 * version (server briefly serves a stale image, e.g. mid-deploy
 * webhook race) cannot loop.
 */

const POLL_INTERVAL_MS = 60_000;
const SESSION_GUARD_KEY = "healthlog:version-reload-attempted";
const SHELL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

type VersionEnvelope = {
  data?: { version?: string };
};

async function fetchLiveVersion(signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch("/api/version", {
      cache: "no-store",
      signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as VersionEnvelope;
    return json.data?.version ?? null;
  } catch {
    return null;
  }
}

async function evictAndReload(): Promise<void> {
  try {
    sessionStorage.setItem(SESSION_GUARD_KEY, String(Date.now()));
  } catch {
    // sessionStorage can throw under strict-privacy modes; fall
    // through to the reload anyway — worst case the next deploy
    // re-triggers the same heal flow.
  }

  if ("serviceWorker" in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch {
      /* best effort */
    }
  }

  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* best effort */
    }
  }

  window.location.reload();
}

export function VersionPoller(): null {
  useEffect(() => {
    if (!SHELL_VERSION) return;
    if (typeof window === "undefined") return;
    try {
      if (sessionStorage.getItem(SESSION_GUARD_KEY)) return;
    } catch {
      /* fall through — we'll try the reload anyway if mismatch hits */
    }

    const controller = new AbortController();

    async function checkOnce(): Promise<void> {
      const live = await fetchLiveVersion(controller.signal);
      if (!live) return;
      if (live === SHELL_VERSION) return;
      await evictAndReload();
    }

    // First check 5 s after mount — gives the app a chance to settle
    // before we touch caches. Then on the recurring interval.
    const initial = window.setTimeout(() => void checkOnce(), 5_000);
    const interval = window.setInterval(
      () => void checkOnce(),
      POLL_INTERVAL_MS,
    );

    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      controller.abort();
    };
  }, []);

  return null;
}
