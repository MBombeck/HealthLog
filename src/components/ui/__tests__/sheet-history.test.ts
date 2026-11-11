import { describe, expect, it, vi } from "vitest";

import { createSheetHistory, type SheetHistoryHost } from "../sheet-history";

type Listener = (event: { stopImmediatePropagation(): void }) => void;

/**
 * A session history the way a browser keeps it: `back()` is queued and
 * answered later with a popstate, capture listeners hear it before bubble
 * ones, and the router is a bubble listener registered first.
 */
function fakeBrowser(start = "https://app.test/measurements") {
  const entries: Array<{ state: unknown; href: string }> = [
    { state: { __NA: true }, href: start },
  ];
  let index = 0;
  const queued: Array<() => void> = [];
  const capture: Listener[] = [];
  const bubble: Listener[] = [];
  const routerHeard: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;

  const resolve = (url: string | URL | null | undefined) =>
    url == null
      ? entries[index].href
      : new URL(String(url), entries[index].href).href;

  function dispatch() {
    let stopped = false;
    const event = { stopImmediatePropagation: () => (stopped = true) };
    for (const listener of [...capture, ...bubble]) {
      if (stopped) break;
      listener(event);
    }
  }

  function traverse(delta: number) {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    index = target;
    dispatch();
  }

  const host: SheetHistoryHost = {
    history: {
      get state() {
        return entries[index].state;
      },
      pushState(data, _unused, url) {
        entries.splice(index + 1);
        entries.push({ state: data, href: resolve(url) });
        index += 1;
      },
      replaceState(data, _unused, url) {
        entries[index] = { state: data, href: resolve(url) };
      },
      back() {
        queued.push(() => traverse(-1));
      },
    },
    location: {
      get href() {
        return entries[index].href;
      },
    },
    addEventListener(_type, listener, useCapture) {
      (useCapture ? capture : bubble).push(listener);
    },
    dispatchEvent: () => true,
    setTimeout(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  // The router listens from the start, in the bubble phase.
  bubble.push(() => routerHeard.push(entries[index].href));

  return {
    host,
    entries,
    get index() {
      return index;
    },
    routerHeard,
    /** The browser answers the Backs that were asked for. */
    settle() {
      while (queued.length > 0) queued.shift()!();
    },
    /** The person presses Back. */
    pressBack() {
      traverse(-1);
    },
    /** The person picks an entry further back from the Back button's list. */
    go(delta: number) {
      traverse(delta);
    },
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const run of pending) run();
    },
  };
}

function marked(state: unknown): boolean {
  return (
    state !== null &&
    typeof state === "object" &&
    "__healthlogSheet" in (state as Record<string, unknown>)
  );
}

describe("sheet history", () => {
  it("Back closes the sheet and the page under it stays where it was", () => {
    const browser = fakeBrowser();
    const sheets = createSheetHistory(browser.host);
    const onBack = vi.fn();
    sheets.open(onBack);
    expect(browser.entries).toHaveLength(2);

    browser.pressBack();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(browser.index).toBe(0);
    expect(browser.host.location.href).toBe("https://app.test/measurements");
    // Nothing changed for the page, so the router never hears of it.
    expect(browser.routerHeard).toEqual([]);
  });

  it("a sheet closed by its own controls takes its entry off again", () => {
    const browser = fakeBrowser();
    const sheets = createSheetHistory(browser.host);
    const onBack = vi.fn();
    const entry = sheets.open(onBack);

    entry.release();
    browser.settle();

    expect(browser.index).toBe(0);
    expect(onBack).not.toHaveBeenCalled();
    expect(browser.routerHeard).toEqual([]);
    expect(marked(browser.host.history.state)).toBe(false);
  });

  it("a page pushed right after the close is not undone by the close's Back", () => {
    const browser = fakeBrowser("https://app.test/medications");
    const sheets = createSheetHistory(browser.host);
    const entry = sheets.open(vi.fn());

    // A save closes the wizard and opens the new medication at once.
    entry.release();
    browser.host.history.pushState({ __NA: true }, "", "/medications/m1");
    browser.settle();

    expect(browser.entries.map((e) => e.href)).toEqual([
      "https://app.test/medications",
      "https://app.test/medications/m1",
    ]);
    expect(browser.index).toBe(1);
  });

  it("a link followed from inside the sheet replaces the sheet's entry", () => {
    const browser = fakeBrowser("https://app.test/settings");
    const sheets = createSheetHistory(browser.host);
    const entry = sheets.open(vi.fn());

    browser.host.history.pushState({ __NA: true }, "", "/settings/security");
    entry.release();
    browser.settle();

    expect(browser.entries.map((e) => e.href)).toEqual([
      "https://app.test/settings",
      "https://app.test/settings/security",
    ]);
    expect(browser.index).toBe(1);
  });

  it("Back on a sheet that stays open (unsaved input) gives it its entry back", () => {
    const browser = fakeBrowser();
    const sheets = createSheetHistory(browser.host);
    let restore = () => {};
    const entry = sheets.open(() => restore());
    restore = entry.restore;

    browser.pressBack();
    expect(browser.index).toBe(1);
    expect(marked(browser.host.history.state)).toBe(true);

    // Once it does close, its entry goes and one Back leaves the page.
    entry.release();
    browser.settle();
    expect(browser.index).toBe(0);
  });

  it("Back closes only the top sheet of two", () => {
    const browser = fakeBrowser();
    const sheets = createSheetHistory(browser.host);
    const lower = vi.fn();
    const upper = vi.fn();
    sheets.open(lower);
    sheets.open(upper);

    browser.pressBack();

    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
    expect(browser.index).toBe(1);
    expect(marked(browser.host.history.state)).toBe(true);
  });

  it("two sheets closed lower first still leave no entry behind", () => {
    const browser = fakeBrowser();
    const sheets = createSheetHistory(browser.host);
    const lower = sheets.open(vi.fn());
    const upper = sheets.open(vi.fn());

    lower.release();
    upper.release();
    browser.settle();

    expect(browser.index).toBe(0);
    expect(marked(browser.host.history.state)).toBe(false);
  });

  it("a URL the page replaced while the sheet was open is the one it keeps", () => {
    // `?add=` opens the sheet on the first paint and is stripped after it.
    const browser = fakeBrowser("https://app.test/measurements?add=WEIGHT");
    const sheets = createSheetHistory(browser.host);
    const entry = sheets.open(vi.fn());
    browser.host.history.replaceState(null, "", "/measurements");
    // The router rewrites the current entry; the sheet keeps its mark.
    expect(marked(browser.host.history.state)).toBe(true);

    entry.release();
    browser.settle();

    expect(browser.index).toBe(0);
    expect(browser.host.location.href).toBe("https://app.test/measurements");
    expect(browser.routerHeard).toEqual([]);
  });

  it("Back on a sheet opened by a one-shot URL does not bring the URL back", () => {
    const browser = fakeBrowser("https://app.test/measurements?add=WEIGHT");
    const sheets = createSheetHistory(browser.host);
    const onBack = vi.fn();
    sheets.open(onBack);
    browser.host.history.replaceState(null, "", "/measurements");

    browser.pressBack();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(browser.host.location.href).toBe("https://app.test/measurements");
    expect(browser.routerHeard).toEqual([]);
  });

  it("a Back that jumps past the page is the router's to handle", () => {
    const browser = fakeBrowser("https://app.test/");
    browser.host.history.pushState({ __NA: true }, "", "/labs");
    const sheets = createSheetHistory(browser.host);
    const onBack = vi.fn();
    sheets.open(onBack);

    browser.go(-2);

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(browser.routerHeard).toEqual(["https://app.test/"]);
  });

  it("writes stop waiting when the close's Back never arrives", () => {
    const browser = fakeBrowser("https://app.test/medications");
    const sheets = createSheetHistory(browser.host);
    const entry = sheets.open(vi.fn());

    entry.release();
    browser.host.history.pushState({ __NA: true }, "", "/medications/m1");
    expect(browser.host.location.href).toBe("https://app.test/medications");

    browser.runTimers();
    expect(browser.host.location.href).toBe("https://app.test/medications/m1");
  });
});
