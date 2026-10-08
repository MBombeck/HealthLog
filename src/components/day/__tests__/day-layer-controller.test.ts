import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The history contract of the day layer, against a small stand-in for the
 * browser's session history:
 *
 *   - opening adds exactly one entry, so Back closes the layer;
 *   - opening another day while one is open swaps it in place;
 *   - stepping to the neighbouring day never adds an entry, however often;
 *   - closing a day the layer opened goes Back (the next Back leaves the
 *     page); closing a deep link only drops the parameter and stays.
 */

interface Entry {
  state: unknown;
  url: string;
}

function installFakeBrowser(initialUrl: string) {
  const entries: Entry[] = [{ state: null, url: initialUrl }];
  let index = 0;
  const location = {
    get pathname() {
      return new URL(entries[index]!.url, "http://x").pathname;
    },
    get search() {
      return new URL(entries[index]!.url, "http://x").search;
    },
  };
  const history = {
    get state() {
      return entries[index]!.state;
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _unused: string, url: string) {
      entries.splice(index + 1);
      entries.push({ state, url });
      index = entries.length - 1;
    },
    replaceState(state: unknown, _unused: string, url: string) {
      entries[index] = { state, url };
    },
    back() {
      if (index > 0) index -= 1;
    },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = { location, history };
  g.document = { activeElement: null, body: {} };
  return {
    current: () => entries[index]!.url,
    length: () => entries.length,
  };
}

let browser: ReturnType<typeof installFakeBrowser>;

beforeEach(() => {
  browser = installFakeBrowser("/insights/blood-pressure?range=90");
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.document;
});

describe("day layer history", () => {
  it("opens with one entry and keeps the page's query", async () => {
    const { openDay } = await import("../day-layer-controller");
    openDay("2026-01-03");
    expect(browser.current()).toBe(
      "/insights/blood-pressure?range=90&day=2026-01-03",
    );
    expect(browser.length()).toBe(2);
  });

  it("swaps the day in place when another day opens beside it", async () => {
    const { openDay } = await import("../day-layer-controller");
    openDay("2026-01-03");
    openDay("2026-01-05");
    expect(browser.length()).toBe(2);
    expect(browser.current()).toContain("day=2026-01-05");
  });

  it("steps without adding history entries", async () => {
    const { openDay, stepDay } = await import("../day-layer-controller");
    openDay("2026-01-03");
    stepDay("2026-01-03", -1);
    stepDay("2026-01-02", -1);
    stepDay("2026-01-01", 1);
    expect(browser.length()).toBe(2);
    expect(browser.current()).toContain("day=2026-01-02");
  });

  it("closes a pushed day with Back, landing on the page without it", async () => {
    const { closeDay, openDay, stepDay } =
      await import("../day-layer-controller");
    openDay("2026-01-03");
    stepDay("2026-01-03", 1);
    closeDay();
    expect(browser.current()).toBe("/insights/blood-pressure?range=90");
  });

  it("closes a deep link in place: the parameter goes, the page stays", async () => {
    browser = installFakeBrowser("/?day=2026-01-03");
    const { closeDay, stepDay } = await import("../day-layer-controller");
    stepDay("2026-01-03", -1);
    expect(browser.current()).toBe("/?day=2026-01-02");
    closeDay();
    expect(browser.current()).toBe("/");
    expect(browser.length()).toBe(1);
  });
});
