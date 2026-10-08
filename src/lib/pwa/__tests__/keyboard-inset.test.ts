import { describe, expect, it } from "vitest";

import {
  KEYBOARD_MIN_PX,
  keyboardInset,
  trackKeyboardInset,
} from "@/lib/pwa/keyboard-inset";

describe("keyboardInset", () => {
  it("is the layout viewport left below the visual one", () => {
    // iPhone 15, portrait: 844 tall, keyboard 336.
    expect(keyboardInset(844, { height: 508, offsetTop: 0, scale: 1 })).toBe(
      336,
    );
  });

  it("counts a visual viewport iOS panned to keep the field in view", () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 120, scale: 1 })).toBe(
      216,
    );
  });

  it("is zero without a keyboard", () => {
    expect(keyboardInset(844, { height: 844, offsetTop: 0, scale: 1 })).toBe(0);
  });

  it("does not read a collapsing toolbar as a keyboard", () => {
    expect(
      keyboardInset(844, {
        height: 844 - (KEYBOARD_MIN_PX - 1),
        offsetTop: 0,
        scale: 1,
      }),
    ).toBe(0);
  });

  it("does not read pinch-zoom as a keyboard", () => {
    expect(keyboardInset(844, { height: 422, offsetTop: 0, scale: 2 })).toBe(0);
  });

  it("is zero where the browser has no visual viewport", () => {
    expect(keyboardInset(844, null)).toBe(0);
  });
});

class FakeViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  scale = 1;
}

function fakeRoot() {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  return {
    props,
    attrs,
    el: {
      style: {
        setProperty: (k: string, v: string) => props.set(k, v),
        removeProperty: (k: string) => props.delete(k),
      },
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement,
  };
}

describe("trackKeyboardInset", () => {
  it("publishes the inset while the keyboard is open and clears it after", () => {
    const viewport = new FakeViewport();
    const root = fakeRoot();
    const stop = trackKeyboardInset(
      {
        innerHeight: 844,
        visualViewport: viewport as unknown as VisualViewport,
      },
      root.el,
    );
    expect(root.attrs.has("data-keyboard")).toBe(false);

    viewport.height = 508;
    viewport.dispatchEvent(new Event("resize"));
    expect(root.props.get("--keyboard-inset")).toBe("336px");
    expect(root.attrs.get("data-keyboard")).toBe("open");

    viewport.offsetTop = 100;
    viewport.dispatchEvent(new Event("scroll"));
    expect(root.props.get("--keyboard-inset")).toBe("236px");

    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    expect(root.props.has("--keyboard-inset")).toBe(false);
    expect(root.attrs.has("data-keyboard")).toBe(false);

    viewport.height = 508;
    stop();
    viewport.dispatchEvent(new Event("resize"));
    expect(root.attrs.has("data-keyboard")).toBe(false);
  });

  it("does nothing without a visual viewport", () => {
    const root = fakeRoot();
    const stop = trackKeyboardInset(
      { innerHeight: 844, visualViewport: null },
      root.el,
    );
    stop();
    expect(root.attrs.size).toBe(0);
    expect(root.props.size).toBe(0);
  });
});
