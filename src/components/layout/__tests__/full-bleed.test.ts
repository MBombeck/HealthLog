import { describe, expect, it } from "vitest";

import { isFullBleedPage } from "../full-bleed";

const open = { outsideSharedRecord: false, moduleOff: false };

describe("isFullBleedPage", () => {
  it("renders /coach edge to edge", () => {
    expect(isFullBleedPage({ pathname: "/coach", ...open })).toBe(true);
  });

  it.each([
    "/coach/plans",
    "/coach/conversations",
    "/coach/",
    "/coaching",
    "/",
    "/insights",
    "/insights/coach",
    "/settings/ai",
    "/documents",
  ])("keeps %s in the padded frame", (pathname) => {
    expect(isFullBleedPage({ pathname, ...open })).toBe(false);
  });

  it("keeps the padded frame for a refusal on /coach", () => {
    expect(
      isFullBleedPage({
        pathname: "/coach",
        outsideSharedRecord: true,
        moduleOff: false,
      }),
    ).toBe(false);
    expect(
      isFullBleedPage({
        pathname: "/coach",
        outsideSharedRecord: false,
        moduleOff: true,
      }),
    ).toBe(false);
  });
});
