/**
 * Issue #490 — localStorage mirror of the per-user display timezone.
 *
 * The suite runs in the node environment (no jsdom), so a minimal
 * `window` stub provides localStorage + the event target the mirror
 * wires. The stub is deliberately tiny: the mirror only calls
 * `getItem` / `setItem` / `removeItem` and `add/removeEventListener` /
 * `dispatchEvent`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readStoredTimezone,
  storeTimezone,
  subscribeTimezone,
} from "../timezone-mirror";
import { makeFormatters } from "../format-locale";

const STORAGE_KEY = "healthlog-timezone";

function stubWindow() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const win = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (ev: Event) => {
      for (const fn of listeners.get(ev.type) ?? []) fn();
      return true;
    },
  };
  vi.stubGlobal("window", win);
  return { store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("timezone mirror (issue #490)", () => {
  it("reads '' when no mirror exists", () => {
    stubWindow();
    expect(readStoredTimezone()).toBe("");
  });

  it("stores a valid IANA zone and reads it back", () => {
    const { store } = stubWindow();
    storeTimezone("Asia/Manila");
    expect(store.get(STORAGE_KEY)).toBe("Asia/Manila");
    expect(readStoredTimezone()).toBe("Asia/Manila");
  });

  it("notifies same-tab subscribers on change, not on a no-op write", () => {
    stubWindow();
    const onChange = vi.fn();
    const unsubscribe = subscribeTimezone(onChange);
    storeTimezone("Pacific/Auckland");
    expect(onChange).toHaveBeenCalledTimes(1);
    // Same value again → no event (mirrors the time-format contract).
    storeTimezone("Pacific/Auckland");
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    storeTimezone("America/New_York");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("clears the mirror instead of storing a garbage zone", () => {
    const { store } = stubWindow();
    storeTimezone("Europe/Berlin");
    expect(store.get(STORAGE_KEY)).toBe("Europe/Berlin");
    storeTimezone("Mars/Olympus");
    expect(store.has(STORAGE_KEY)).toBe(false);
    expect(readStoredTimezone()).toBe("");
  });

  it("clears the mirror on an empty value", () => {
    const { store } = stubWindow();
    storeTimezone("Europe/Berlin");
    storeTimezone("");
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  it("treats a stale invalid mirror (pre-validation build) as absent", () => {
    const { store } = stubWindow();
    store.set(STORAGE_KEY, "not-a-zone");
    expect(readStoredTimezone()).toBe("");
    // …and the value must never reach Intl: the formatter chain renders
    // the Berlin fallback instead of throwing.
    const fmt = makeFormatters("en", readStoredTimezone(), "H24", "AUTO");
    expect(fmt.time(new Date("2026-04-18T14:30:00Z"))).toBe("16:30");
  });

  it("stale-mirror tolerance: an old but valid zone keeps rendering", () => {
    const { store } = stubWindow();
    // The profile moved to Auckland on another device; this tab still
    // mirrors Manila until the next `/api/auth/me` fetch. That must
    // render (in the stale zone), never throw.
    store.set(STORAGE_KEY, "Asia/Manila");
    const fmt = makeFormatters("en", readStoredTimezone(), "H24", "AUTO");
    expect(fmt.time(new Date("2026-04-18T14:30:00Z"))).toBe("22:30");
  });

  it("no-ops on SSR (window undefined)", () => {
    // Node environment without the stub — `window` is undefined.
    expect(readStoredTimezone()).toBe("");
    expect(() => storeTimezone("Europe/Berlin")).not.toThrow();
    const unsubscribe = subscribeTimezone(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});
