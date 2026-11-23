import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SEGMENT_CHOSEN, SEGMENT_REST } from "../segmented";
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

describe("<Tabs> root", () => {
  it("cannot widen the cell it stands in to the strip's labels", () => {
    // The strip scrolls, but its min-content is still every label side by
    // side. Without `min-w-0` on the root, a root in a grid or flex cell
    // widened that cell to the labels (Cycle on a 390 px phone ran 10 px
    // past the screen) instead of letting the strip scroll.
    const html = renderToStaticMarkup(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const root = html.match(/<div\b[^>]*data-slot="tabs"[^>]*>/)![0];
    expect(root).toMatch(/\bmin-w-0\b/);
  });
});

describe("<Tabs> paints as the segmented control", () => {
  const html = renderToStaticMarkup(
    <Tabs defaultValue="a">
      <TabsList>
        <TabsTrigger value="a">Calendar</TabsTrigger>
        <TabsTrigger value="b">Predictions</TabsTrigger>
      </TabsList>
    </Tabs>,
  );
  const list = /<div\b[^>]*data-slot="tabs-list"[^>]*class="([^"]*)"/
    .exec(html)![1]
    .split(" ");
  const trigger =
    /<button\b[^>]*class="([^"]*)"[^>]*data-slot="tabs-trigger"|<button\b[^>]*data-slot="tabs-trigger"[^>]*class="([^"]*)"/
      .exec(html)!
      .slice(1)
      .find(Boolean)!
      .split(" ");

  it("has no track and no raised segment", () => {
    // The muted track with a raised segment is the look `Segmented` dropped;
    // four pages kept it through this primitive.
    expect(list.filter((c) => /^bg-/.test(c))).toEqual([]);
    expect(trigger.filter((c) => /shadow/.test(c))).toEqual([]);
  });

  it("fills the chosen tab and rests the others on the segment's own tokens", () => {
    for (const token of SEGMENT_REST.split(" ")) {
      expect(trigger, token).toContain(token);
    }
    for (const token of SEGMENT_CHOSEN.split(" ")) {
      expect(trigger, token).toContain(`data-[state=active]:${token}`);
    }
  });

  it("keeps a segment's touch floor", () => {
    expect(trigger).toEqual(
      expect.arrayContaining(["min-h-9", "pointer-coarse:min-h-11"]),
    );
  });
});
