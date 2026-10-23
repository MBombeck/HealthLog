import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Tabs, TabsList, TabsTrigger } from "../tabs";

describe("<TabsList>", () => {
  it("clamps the y-axis so a fixed-height strip never paints a vertical scrollbar", () => {
    // The maintainer reported a stray "mini scroll-button" on the right side of
    // the feedback inbox tab strip (Open / Acknowledged / Resolved /
    // Archived). Root cause: `overflow-x-auto` couples to `overflow-y`
    // — once one axis is `auto`, the other can no longer be `visible`,
    // so the browser silently flips it to `auto` too. Combined with
    // the fixed `h-9` strip and the badges (`py-0.5` + text-xs) that
    // ride 1-2 px taller than the strip on some glyph stacks, a
    // tiny vertical scrollbar paints on the right edge.
    //
    // Locking `overflow-y-hidden` on the strip kills the painted bar
    // without touching the horizontal swipe behaviour.
    const html = renderToStaticMarkup(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = html.match(/<div\b[^>]*data-slot="tabs-list"[^>]*>/);
    expect(list).not.toBeNull();
    expect(list![0]).toMatch(/\boverflow-y-hidden\b/);
    // Horizontal scroll behaviour is still intact for long strips.
    expect(list![0]).toMatch(/\boverflow-x-auto\b/);
  });

  it("leaves the vertical pan to the page", () => {
    // `touch-pan-x` (or `touch-none`) on the strip refuses a vertical pan
    // that starts on it, so a swipe up or down over a tab strip scrolled
    // nothing. The strip pans sideways through its own overflow.
    const html = renderToStaticMarkup(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = html.match(/<div\b[^>]*data-slot="tabs-list"[^>]*>/)![0];
    expect(list).not.toMatch(
      /\btouch-(?:pan-x|pan-left|pan-right|none|pinch-zoom)\b/,
    );
  });
});
