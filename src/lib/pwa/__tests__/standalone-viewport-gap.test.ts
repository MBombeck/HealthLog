import { describe, expect, it } from "vitest";

import {
  standaloneViewportGap,
  trackStandaloneViewportGap,
  type ViewportGapInput,
} from "@/lib/pwa/standalone-viewport-gap";

// iPhone 17 Pro Max: 440 x 956 CSS px, a 62 px status-bar inset.
const PHONE: ViewportGapInput = {
  standalone: true,
  innerWidth: 440,
  innerHeight: 956 - 62,
  screenWidth: 440,
  screenHeight: 956,
  safeAreaTop: 62,
};

describe("standaloneViewportGap", () => {
  it("is the status-bar height an installed app's viewport ends short by", () => {
    expect(standaloneViewportGap(PHONE)).toBe(62);
  });

  it("is zero where the installed app's viewport reaches the screen's bottom", () => {
    expect(standaloneViewportGap({ ...PHONE, innerHeight: 956 })).toBe(0);
  });

  it("is zero in a browser tab, whatever the toolbar leaves", () => {
    expect(standaloneViewportGap({ ...PHONE, standalone: false })).toBe(0);
  });

  it("is zero without a top inset (the page does not draw under the status bar)", () => {
    expect(standaloneViewportGap({ ...PHONE, safeAreaTop: 0 })).toBe(0);
  });

  it("does not read a shortfall that is not the status bar's as this defect", () => {
    expect(standaloneViewportGap({ ...PHONE, innerHeight: 956 - 40 })).toBe(0);
    expect(standaloneViewportGap({ ...PHONE, innerHeight: 956 - 336 })).toBe(0);
  });

  it("leaves an iPad window narrower than the screen alone", () => {
    expect(
      standaloneViewportGap({
        standalone: true,
        innerWidth: 507,
        innerHeight: 1366 - 24,
        screenWidth: 1024,
        screenHeight: 1366,
        safeAreaTop: 24,
      }),
    ).toBe(0);
  });

  it("measures against the screen in its current orientation", () => {
    expect(
      standaloneViewportGap({
        ...PHONE,
        innerWidth: 956,
        innerHeight: 440 - 20,
        safeAreaTop: 20,
      }),
    ).toBe(20);
    expect(
      standaloneViewportGap({
        ...PHONE,
        innerWidth: 956,
        innerHeight: 440,
        safeAreaTop: 20,
      }),
    ).toBe(0);
  });
});

class FakeWindow extends EventTarget {
  innerWidth = 440;
  innerHeight = 894;
  screen = { width: 440, height: 956 } as Screen;
  navigator = { standalone: true } as unknown as Navigator;
  visualViewport = null;
}

function fakeRoot() {
  const props = new Map<string, string>();
  return {
    props,
    el: {
      style: {
        setProperty: (k: string, v: string) => props.set(k, v),
        removeProperty: (k: string) => props.delete(k),
      },
    } as unknown as HTMLElement,
  };
}

describe("trackStandaloneViewportGap", () => {
  it("publishes the gap, follows a resize, and clears it on cleanup", () => {
    const win = new FakeWindow();
    const root = fakeRoot();
    const stop = trackStandaloneViewportGap(
      win as unknown as Window,
      root.el,
      () => 62,
    );
    expect(root.props.get("--viewport-bottom-gap")).toBe("62px");

    // iOS corrects the viewport (seen after the keyboard has been up once).
    win.innerHeight = 956;
    win.dispatchEvent(new Event("resize"));
    expect(root.props.has("--viewport-bottom-gap")).toBe(false);

    win.innerHeight = 894;
    win.dispatchEvent(new Event("resize"));
    expect(root.props.get("--viewport-bottom-gap")).toBe("62px");

    stop();
    expect(root.props.has("--viewport-bottom-gap")).toBe(false);
  });

  it("does nothing outside an installed iOS app", () => {
    const win = new FakeWindow();
    win.navigator = {} as Navigator;
    const root = fakeRoot();
    const stop = trackStandaloneViewportGap(
      win as unknown as Window,
      root.el,
      () => 62,
    );
    win.dispatchEvent(new Event("resize"));
    stop();
    expect(root.props.size).toBe(0);
  });
});
