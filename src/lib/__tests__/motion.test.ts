import { afterEach, describe, expect, it, vi } from "vitest";

import { scrollBehaviorForUser } from "@/lib/motion";

// The vitest config runs unit tests under Node (no jsdom). The helper
// only touches `window.matchMedia`, so we mount a minimal stub via
// `vi.stubGlobal` and tear it down after each case.

function mountWindow(matchesReducedMotion: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches:
        matchesReducedMotion && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("scrollBehaviorForUser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns `auto` when window is undefined (SSR)", () => {
    vi.stubGlobal("window", undefined);
    expect(scrollBehaviorForUser()).toBe("auto");
  });

  it("returns `auto` when prefers-reduced-motion matches", () => {
    mountWindow(true);
    expect(scrollBehaviorForUser()).toBe("auto");
  });

  it("returns `smooth` when prefers-reduced-motion does not match", () => {
    mountWindow(false);
    expect(scrollBehaviorForUser()).toBe("smooth");
  });
});
