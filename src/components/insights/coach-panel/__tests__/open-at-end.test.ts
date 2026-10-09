/**
 * A saved conversation opens at its last answer and stays there while late
 * layout (charts, tables) grows the thread, until the reader takes over.
 * Driven against a fake scroller: the test environment has no layout, and
 * the behaviour under test is which scroll the thread asks for, and when.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OPEN_AT_END_SETTLE_MS, openAtEnd } from "../open-at-end";

type Listener = () => void;

function fakeScroller(children = 3) {
  const listeners = new Map<string, Set<Listener>>();
  const el = {
    scrollHeight: 1000,
    children: Array.from({ length: children }, () => ({}) as Element),
    scrollTo: vi.fn(),
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
    fire: (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    listenerCount: () =>
      [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
  return el;
}

/** A ResizeObserver whose callback the test fires by hand. */
function fakeResizeObserver() {
  const instances: Array<{ fire: () => void; observed: unknown[] }> = [];
  class FakeResizeObserver {
    observed: unknown[] = [];
    disconnected = false;
    constructor(private readonly cb: () => void) {
      instances.push(this as never);
    }
    observe(node: unknown) {
      this.observed.push(node);
    }
    disconnect() {
      this.disconnected = true;
    }
    fire() {
      if (!this.disconnected) this.cb();
    }
  }
  return {
    Ctor: FakeResizeObserver as unknown as typeof ResizeObserver,
    instances,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("openAtEnd", () => {
  it("jumps to the end at once, without the smooth animation that lost it", () => {
    const el = fakeScroller();
    openAtEnd(el, { ResizeObserver: undefined, MutationObserver: undefined });
    expect(el.scrollTo).toHaveBeenCalledTimes(1);
    expect(el.scrollTo).toHaveBeenCalledWith({
      top: 1000,
      behavior: "instant",
    });
  });

  it("follows the end when a chart that loads later grows the thread", () => {
    const el = fakeScroller();
    const ro = fakeResizeObserver();
    openAtEnd(el, { ResizeObserver: ro.Ctor, MutationObserver: undefined });
    expect(ro.instances[0].observed).toHaveLength(3);

    el.scrollHeight = 1070; // one chart's height, the phone shortfall
    ro.instances[0].fire();
    expect(el.scrollTo).toHaveBeenLastCalledWith({
      top: 1070,
      behavior: "instant",
    });
  });

  it("lets go the moment the reader scrolls, touches or presses a key", () => {
    for (const event of ["wheel", "touchstart", "keydown", "pointerdown"]) {
      const el = fakeScroller();
      const ro = fakeResizeObserver();
      openAtEnd(el, { ResizeObserver: ro.Ctor, MutationObserver: undefined });
      el.fire(event);
      el.scrollHeight = 2000;
      ro.instances[0].fire();
      expect(el.scrollTo, event).toHaveBeenCalledTimes(1);
      expect(el.listenerCount(), event).toBe(0);
    }
  });

  it("stops following on its own once the layout has had time to settle", () => {
    const el = fakeScroller();
    const ro = fakeResizeObserver();
    openAtEnd(el, { ResizeObserver: ro.Ctor, MutationObserver: undefined });
    vi.advanceTimersByTime(OPEN_AT_END_SETTLE_MS);
    el.scrollHeight = 3000;
    ro.instances[0].fire();
    expect(el.scrollTo).toHaveBeenCalledTimes(1);
    expect(el.listenerCount()).toBe(0);
  });

  it("stops when the caller says so, as on switching conversations", () => {
    const el = fakeScroller();
    const ro = fakeResizeObserver();
    const stop = openAtEnd(el, {
      ResizeObserver: ro.Ctor,
      MutationObserver: undefined,
    });
    stop();
    ro.instances[0].fire();
    expect(el.scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe("the thread wires it to the conversation it opens", () => {
  it("runs on a layout effect keyed on the conversation", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/insights/coach-panel/message-thread.tsx",
      ),
      "utf8",
    );
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{[\s\S]*?return openAtEnd\(el\);[\s\S]*?\}, \[conversationId, hasMessages\]\);/,
    );
  });
});
