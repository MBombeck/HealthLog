/**
 * Unit tests for the version-poller decision.
 *
 * The guard is keyed on the TARGET (live) version: a repeat mismatch
 * against the SAME version is suppressed (no loop on a misset server),
 * but a SECOND deploy in one session moves the live version past the
 * recorded one and the flow re-arms.
 *
 * The runtime behaviour — a detected bump surfaces a Reload toast and
 * never reloads the page on its own — lives in `version-poller.tsx`:
 * the service-worker eviction + `location.reload()` run only from the
 * toast action's `onClick`, so an in-progress form or chat draft is
 * never destroyed unprompted.
 */

import { describe, expect, it } from "vitest";

import { resolveVersionPollDecision } from "../version-poller";

describe("resolveVersionPollDecision", () => {
  it("is up-to-date when live matches the shell", () => {
    expect(resolveVersionPollDecision("1.16.8", "1.16.8", null)).toBe(
      "up-to-date",
    );
  });

  it("is up-to-date when the live version cannot be read", () => {
    expect(resolveVersionPollDecision(null, "1.16.8", null)).toBe("up-to-date");
  });

  it("reloads on a mismatch with no prior attempt", () => {
    expect(resolveVersionPollDecision("1.16.9", "1.16.8", null)).toBe("reload");
  });

  it("suppresses a repeat reload for the SAME target version", () => {
    expect(resolveVersionPollDecision("1.16.9", "1.16.8", "1.16.9")).toBe(
      "already-attempted",
    );
  });

  it("re-arms when a SECOND deploy moves the live version past the recorded one", () => {
    expect(resolveVersionPollDecision("1.16.10", "1.16.8", "1.16.9")).toBe(
      "reload",
    );
  });

  it("treats a legacy timestamp guard value as no attempt", () => {
    // Pre-v1.16.8 sessions stored `String(Date.now())`; it never matches
    // a real version string, so a stranded session heals on its next poll.
    expect(
      resolveVersionPollDecision("1.16.9", "1.16.8", "1765400000000"),
    ).toBe("reload");
  });
});

describe("evictAndReload", () => {
  /**
   * The Reload action used to unregister every service worker. Unregistering
   * a registration ends its Web Push subscription, and nothing re-creates it,
   * so each update silently switched push reminders off in the installed app.
   * The action now updates the registration and deletes only HealthLog's
   * caches.
   */
  function stubBrowser(cacheNames: string[]) {
    const calls = { update: 0, unregister: 0, reload: 0 };
    const deleted: string[] = [];
    const registration = {
      update: async () => {
        calls.update += 1;
      },
      unregister: async () => {
        calls.unregister += 1;
        return true;
      },
    };
    const g = globalThis as Record<string, unknown>;
    const saved = {
      navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
      caches: g.caches,
      window: g.window,
      sessionStorage: g.sessionStorage,
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: { getRegistrations: async () => [registration] },
      },
    });
    g.caches = {
      keys: async () => cacheNames,
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    };
    g.window = {
      location: {
        reload: () => {
          calls.reload += 1;
        },
      },
    };
    g.sessionStorage = { setItem: () => {}, getItem: () => null };
    const restore = () => {
      if (saved.navigator)
        Object.defineProperty(globalThis, "navigator", saved.navigator);
      g.caches = saved.caches;
      g.window = saved.window;
      g.sessionStorage = saved.sessionStorage;
    };
    return { calls, deleted, restore };
  }

  it("updates the worker instead of unregistering it, so the push subscription survives", async () => {
    const { evictAndReload } = await import("../version-poller");
    const browser = stubBrowser([]);
    try {
      await evictAndReload("9.9.9");
    } finally {
      browser.restore();
    }
    expect(browser.calls.unregister).toBe(0);
    expect(browser.calls.update).toBe(1);
    expect(browser.calls.reload).toBe(1);
  });

  it("deletes HealthLog's caches and leaves another app's on the same origin", async () => {
    const { evictAndReload } = await import("../version-poller");
    const browser = stubBrowser([
      "healthlog-static-v1.41.2",
      "healthlog-pages-v1.41.2",
      "healthlog-data-v1.41.2",
      "other-app-runtime",
    ]);
    try {
      await evictAndReload("9.9.9");
    } finally {
      browser.restore();
    }
    expect(browser.deleted.sort()).toEqual([
      "healthlog-data-v1.41.2",
      "healthlog-pages-v1.41.2",
      "healthlog-static-v1.41.2",
    ]);
  });
});
