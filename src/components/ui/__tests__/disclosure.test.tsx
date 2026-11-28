import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";

import { Disclosure } from "../disclosure";

describe("<Disclosure>", () => {
  it("is the browser's own details with a chevron in place of the triangle", () => {
    const html = renderToStaticMarkup(
      <Disclosure summary="What the relay sees">
        <p>When this server sends a device something.</p>
      </Disclosure>,
    );
    expect(html).toMatch(/^<details[^>]*data-slot="disclosure"/);
    expect(html).toMatch(/<summary[^>]*>.*What the relay sees.*<\/summary>/);
    // The triangle is off in both engines, the chevron turns when open.
    expect(html).toContain("list-none");
    expect(html).toContain("[&amp;::-webkit-details-marker]:hidden");
    expect(html).toContain("group-open/disclosure:rotate-180");
    // A 44 px row on a phone.
    expect(html).toContain("min-h-11");
    expect(html).toContain("When this server sends a device something.");
  });

  it("draws its frame only when asked", () => {
    const plain = renderToStaticMarkup(<Disclosure summary="x">y</Disclosure>);
    const framed = renderToStaticMarkup(
      <Disclosure framed summary="x">
        y
      </Disclosure>,
    );
    expect(plain).not.toContain("border-border");
    expect(framed).toContain("border-border rounded-md border");
  });

  it("opens when told to and passes its attributes through", () => {
    const html = renderToStaticMarkup(
      <Disclosure summary="x" open data-testid="more">
        y
      </Disclosure>,
    );
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).toContain('data-testid="more"');
  });
});

/**
 * A bare `<details>` shows the browser's triangle and whatever text size it
 * inherits; four dozen chevron rows sat beside nine of them. This is a
 * ratchet: the ones that remain are listed by file, a new one fails, and one
 * that moves to `Disclosure` leaves the list. The ones that stay are fine
 * print under an import result and the long-form sections of the prose
 * pages, which `Disclosure`'s 44 px row would outweigh.
 */
describe("no bare <details> beside Disclosure", () => {
  const REMAINING: Record<string, number> = {
    "app/privacy/page.tsx": 2,
    "components/medications/intake-import-result.tsx": 1,
    "components/records/life-circumstances-manager.tsx": 1,
    "components/settings/import-panel/apple-health-import-card.tsx": 1,
    "components/settings/import-panel/import-result-view.tsx": 1,
  };

  const count = (source: string) =>
    (stripComments(source).match(/<details\b/g) ?? []).length;

  it("recognises the element it counts", () => {
    expect(count('<details className="x"><summary>a</summary></details>')).toBe(
      1,
    );
    expect(count("// a `<details>` in a comment\n<Disclosure />")).toBe(0);
  });

  it("finds none but the listed ones", () => {
    const src = join(__dirname, "../../..");
    const found: Record<string, number> = {};
    for (const path of walkSourceFiles(src, {
      floor: 1200,
      extensions: [".tsx"],
    })) {
      if (!/^(components|app)\//.test(path)) continue;
      if (path.includes("__tests__/")) continue;
      if (path === "components/ui/disclosure.tsx") continue;
      const n = count(readSourceText(join(src, path)));
      if (n > 0) found[path] = n;
    }
    requireFloor("bare <details>", Object.keys(found), 1);
    expect(found).toEqual(REMAINING);
  });
});
