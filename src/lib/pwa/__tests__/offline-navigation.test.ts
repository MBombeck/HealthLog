import { describe, expect, it } from "vitest";

import { isOfflineNavigationClick } from "@/lib/pwa/offline-navigation";

const HERE = {
  origin: "https://app.example",
  pathname: "/medications",
  search: "",
};

interface AnchorInit {
  href: string;
  target?: string;
  download?: boolean;
}

/** A click on an element inside an anchor, the way a nav icon is tapped. */
function clickOn(
  anchor: AnchorInit | null,
  overrides: Partial<Parameters<typeof isOfflineNavigationClick>[0]> = {},
) {
  const link = anchor && {
    href: new URL(anchor.href, HERE.origin).href,
    target: anchor.target ?? "",
    hasAttribute: (name: string) => name === "download" && !!anchor.download,
  };
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: {
      closest: (selector: string) => (selector === "a[href]" ? link : null),
    } as unknown as EventTarget,
    ...overrides,
  };
}

describe("isOfflineNavigationClick", () => {
  it("holds a tap on a link to another page while offline", () => {
    expect(isOfflineNavigationClick(clickOn({ href: "/" }), HERE, false)).toBe(
      true,
    );
    expect(
      isOfflineNavigationClick(
        clickOn({ href: "/measurements?add=WEIGHT" }),
        HERE,
        false,
      ),
    ).toBe(true);
    // Same path, different query: a different page for the router.
    expect(
      isOfflineNavigationClick(
        clickOn({ href: "/medications?tab=history" }),
        HERE,
        false,
      ),
    ).toBe(true);
  });

  it("lets every link through while online", () => {
    expect(isOfflineNavigationClick(clickOn({ href: "/" }), HERE, true)).toBe(
      false,
    );
  });

  it("leaves links within the open page alone", () => {
    expect(
      isOfflineNavigationClick(
        clickOn({ href: "/medications#main-content" }),
        HERE,
        false,
      ),
    ).toBe(false);
  });

  it("leaves clicks the browser handles itself alone", () => {
    const offline = (click: ReturnType<typeof clickOn>) =>
      isOfflineNavigationClick(click, HERE, false);
    expect(offline(clickOn({ href: "https://elsewhere.example/" }))).toBe(
      false,
    );
    expect(offline(clickOn({ href: "/", target: "_blank" }))).toBe(false);
    expect(offline(clickOn({ href: "/export.csv", download: true }))).toBe(
      false,
    );
    expect(offline(clickOn({ href: "/" }, { metaKey: true }))).toBe(false);
    expect(offline(clickOn({ href: "/" }, { button: 1 }))).toBe(false);
    expect(offline(clickOn({ href: "/" }, { defaultPrevented: true }))).toBe(
      false,
    );
    expect(offline(clickOn(null))).toBe(false);
  });
});
