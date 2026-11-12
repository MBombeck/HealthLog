/**
 * Gating predicate for app-wide service-worker registration.
 *
 * The registrar must install `/sw.js` only in production and only where the
 * browser supports the API. Dev lacks the generated `/sw-version.js` (the
 * `prebuild` step writes it) and a caching SW fights HMR, so a dev register
 * would be actively harmful.
 */
import { describe, expect, it } from "vitest";

import {
  clearLeftoverAppBadge,
  shouldRegisterServiceWorker,
} from "../service-worker-registrar";

describe("shouldRegisterServiceWorker", () => {
  it("registers in production with window + serviceWorker support", () => {
    expect(shouldRegisterServiceWorker("production", true, true)).toBe(true);
  });

  it("does not register outside production", () => {
    expect(shouldRegisterServiceWorker("development", true, true)).toBe(false);
    expect(shouldRegisterServiceWorker("test", true, true)).toBe(false);
    expect(shouldRegisterServiceWorker(undefined, true, true)).toBe(false);
  });

  it("does not register without a window (SSR)", () => {
    expect(shouldRegisterServiceWorker("production", false, true)).toBe(false);
  });

  it("does not register when serviceWorker is unsupported", () => {
    expect(shouldRegisterServiceWorker("production", true, false)).toBe(false);
  });
});

describe("clearLeftoverAppBadge", () => {
  function fakeWindow(standalone: boolean, hasApi = true) {
    const calls = { cleared: 0 };
    const win = {
      matchMedia: () => ({ matches: standalone }),
      navigator: hasApi
        ? {
            clearAppBadge: async () => {
              calls.cleared += 1;
            },
          }
        : {},
    } as unknown as Window;
    return { win, calls };
  }

  it("clears the icon badge in the installed app", () => {
    const { win, calls } = fakeWindow(true);
    clearLeftoverAppBadge(win);
    expect(calls.cleared).toBe(1);
  });

  it("leaves a browser tab alone", () => {
    const { win, calls } = fakeWindow(false);
    clearLeftoverAppBadge(win);
    expect(calls.cleared).toBe(0);
  });

  it("does nothing where the badge API does not exist", () => {
    const { win } = fakeWindow(true, false);
    expect(() => clearLeftoverAppBadge(win)).not.toThrow();
  });
});
