import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";

import { SubNavLink, SubNavRow, subNavItemClass } from "../sub-nav";

describe("sub-navigation pills", () => {
  it("marks the current page and tints its pill", () => {
    const html = renderToStaticMarkup(
      <SubNavRow>
        <SubNavLink href="/insights" active>
          Overview
        </SubNavLink>
        <SubNavLink href="/insights/sleep" active={false}>
          Sleep
        </SubNavLink>
      </SubNavRow>,
    );
    expect(html).toMatch(
      /<a[^>]*aria-current="page"[^>]*href="\/insights"|<a[^>]*href="\/insights"[^>]*aria-current="page"/,
    );
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(subNavItemClass(true)).toContain("border-primary");
    expect(subNavItemClass(true)).toContain("bg-primary/10");
    expect(subNavItemClass(false)).not.toContain("bg-primary");
  });

  it("is a 44 px target that never wraps its label", () => {
    for (const active of [true, false]) {
      const cls = subNavItemClass(active).split(" ");
      expect(cls).toEqual(
        expect.arrayContaining(["min-h-11", "shrink-0", "whitespace-nowrap"]),
      );
    }
  });

  it("scrolls sideways and leaves the vertical pan to the page", () => {
    const html = renderToStaticMarkup(<SubNavRow>x</SubNavRow>);
    expect(html).toContain("overflow-x-auto");
    expect(html).not.toMatch(/\btouch-(?:pan-x|none)\b/);
  });
});

/**
 * A row of pills that marks the current page is `SubNav`. The Insights
 * pills and the Admin console's phone strip were two hand-written copies in
 * two sizes and two tints. A file that marks a current page and spells a
 * bordered pill of its own is a third, and fails.
 */
describe("no hand-written pill strip beside SubNav", () => {
  // Empty since the Admin console's phone strip moved to `SubNavLink`.
  const REMAINING: string[] = [];

  const PILL_RE = /"[^"\n]*\brounded-full\b[^"\n]*"/g;

  function hasOwnPillStrip(source: string): boolean {
    const text = stripComments(source);
    if (!/aria-current=\{[^}]*"page"/.test(text)) return false;
    return (text.match(PILL_RE) ?? []).some(
      (literal) => /\bborder\b/.test(literal) && /\bpx-3\b/.test(literal),
    );
  }

  it("recognises a hand-written strip", () => {
    expect(
      hasOwnPillStrip(
        '<Link aria-current={on ? "page" : undefined} className={cn("flex min-h-11 items-center rounded-full border px-3 py-1.5 text-sm", on && "bg-primary/10")} />',
      ),
    ).toBe(true);
    expect(
      hasOwnPillStrip('<SubNavLink href="/a" active={on}>A</SubNavLink>'),
    ).toBe(false);
    // A current-page marker without a pill is a side list or a breadcrumb.
    expect(
      hasOwnPillStrip(
        '<Link aria-current={on ? "page" : undefined} className="flex rounded-lg px-3 py-2" />',
      ),
    ).toBe(false);
  });

  it("finds none", () => {
    const src = join(__dirname, "../../..");
    const found = walkSourceFiles(src, { floor: 1200, extensions: [".tsx"] })
      .filter((p) => /^(components|app)\//.test(p))
      .filter((p) => !p.includes("__tests__/"))
      .filter((p) => p !== "components/ui/sub-nav.tsx")
      .filter((p) => hasOwnPillStrip(readSourceText(join(src, p))))
      .sort();
    expect(found).toEqual(REMAINING);
  });
});
