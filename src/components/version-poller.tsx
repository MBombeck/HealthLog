"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { HEALTHLOG_CACHE_NAME_RE } from "@/lib/pwa/sw-cache-policy";

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
 * the running shell it surfaces a non-blocking toast with a Reload
 * action. The eviction + reload only runs when the user clicks
 * Reload — an in-progress form or chat draft is never destroyed by a
 * silent mid-session reload. On that click:
 *
 *   1. Ask the service worker registration to update, so the new
 *      deploy's worker (its `sw-version.js` changed) installs and takes
 *      over; it activates at once (`skipWaiting` + `clients.claim`) and
 *      drops the previous release's caches itself.
 *   2. Delete HealthLog's CacheStorage entries so the `/_next/static/*`
 *      chunks and page shells from the previous deploy can't be served
 *      back while that happens.
 *   3. `window.location.reload()` — fetches the fresh shell + new
 *      chunk graph.
 *
 * v1.42 — the worker is updated, never unregistered. Unregistering a
 * registration ends its Web Push subscription, and nothing re-creates one:
 * every click on Reload silently switched off push reminders in the
 * installed app (the server kept the dead endpoint, the settings card
 * showed push as off). An update keeps the registration and with it the
 * subscription. The page navigation is network-first in the worker, so the
 * reload reaches the new shell whichever worker answers it.
 *
 * The toast is shown once per detected version (the poll keeps
 * running, but a repeated mismatch against a version we already
 * surfaced doesn't re-spam every 60 s). The reload guard is keyed on
 * the TARGET version: `sessionStorage` records which live version we
 * last reloaded for, and only a repeat mismatch against that SAME
 * version is suppressed (a misset version — server briefly serves a
 * stale image mid-deploy — cannot loop). On a multi-deploy day a
 * SECOND release moves the live version past the recorded one and the
 * flow re-arms.
 */

const POLL_INTERVAL_MS = 60_000;
const SESSION_GUARD_KEY = "healthlog:version-reload-attempted";
const SHELL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

export type VersionPollDecision = "up-to-date" | "reload" | "already-attempted";

/**
 * Pure reload decision so the guard semantics carry direct unit
 * coverage. `lastReloadedFor` is the live version recorded by the most
 * recent heal attempt in this session (`null` when none happened);
 * legacy guard values (the pre-v1.16.8 timestamp) never match a real
 * version string, so a stuck session from before the change heals on
 * its next mismatch.
 */
export function resolveVersionPollDecision(
  liveVersion: string | null,
  shellVersion: string,
  lastReloadedFor: string | null,
): VersionPollDecision {
  if (!liveVersion || liveVersion === shellVersion) return "up-to-date";
  if (lastReloadedFor === liveVersion) return "already-attempted";
  return "reload";
}

async function fetchLiveVersion(signal: AbortSignal): Promise<string | null> {
  try {
    const data = await apiGet<{ version?: string } | undefined>(
      "/api/version",
      { cache: "no-store", signal },
    );
    return data?.version ?? null;
  } catch {
    return null;
  }
}

// In-memory mirror of the session guard: under strict-privacy modes
// sessionStorage throws, and without a fallback a persistent
// shell/live mismatch (misconfigured build) would reload every poll.
// Module scope survives re-renders but not the reload itself — after
// a reload the storage read is retried first, so the mirror only has
// to break the loop within one document lifetime.
let inMemoryReloadGuard: string | null = null;

export async function evictAndReload(targetVersion: string): Promise<void> {
  inMemoryReloadGuard = targetVersion;
  try {
    sessionStorage.setItem(SESSION_GUARD_KEY, targetVersion);
  } catch {
    // sessionStorage can throw under strict-privacy modes; the
    // in-memory mirror above still breaks same-document loops.
  }

  if ("serviceWorker" in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update()));
    } catch {
      /* best effort — the reload below still fetches the new shell */
    }
  }

  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => HEALTHLOG_CACHE_NAME_RE.test(k))
          .map((k) => caches.delete(k)),
      );
    } catch {
      /* best effort */
    }
  }

  window.location.reload();
}

export function VersionPoller(): null {
  const { t } = useTranslations();
  // Tracks the live version we've already surfaced a toast for, so a
  // repeated mismatch on the recurring poll doesn't re-spam.
  const notifiedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!SHELL_VERSION) return;
    if (typeof window === "undefined") return;

    const controller = new AbortController();

    async function checkOnce(): Promise<void> {
      const live = await fetchLiveVersion(controller.signal);
      let lastReloadedFor: string | null = null;
      try {
        lastReloadedFor = sessionStorage.getItem(SESSION_GUARD_KEY);
      } catch {
        /* storage unavailable — the in-memory mirror still applies */
      }
      lastReloadedFor ??= inMemoryReloadGuard;
      const decision = resolveVersionPollDecision(
        live,
        SHELL_VERSION,
        lastReloadedFor,
      );
      if (decision !== "reload") return;

      const target = live as string;
      // One toast per detected version — don't re-open it every poll.
      if (notifiedForRef.current === target) return;
      notifiedForRef.current = target;

      toast(t("version.updateAvailable.title"), {
        duration: Infinity,
        action: {
          label: t("version.updateAvailable.reload"),
          onClick: () => void evictAndReload(target),
        },
        cancel: {
          label: t("version.updateAvailable.dismiss"),
          onClick: () => {},
        },
      });
    }

    // First check 5 s after mount — gives the app a chance to settle
    // before we surface anything. Then on the recurring interval.
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
  }, [t]);

  return null;
}
