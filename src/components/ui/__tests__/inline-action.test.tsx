import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { InlineAction } from "../inline-action";

describe("<InlineAction>", () => {
  it("is a non-submitting button with a touch target and a focus ring", () => {
    const html = renderToStaticMarkup(
      <InlineAction>Open schedule</InlineAction>,
    );
    expect(html).toMatch(/^<button[^>]*type="button"/);
    expect(html).toContain("pointer-coarse:before:h-11");
    expect(html).toContain("focus-visible:ring-[3px]");
    expect(html).toContain("text-primary");
    expect(html).toContain("text-xs");
  });

  it("keeps an explicit submit type", () => {
    const html = renderToStaticMarkup(
      <InlineAction type="submit">Send</InlineAction>,
    );
    expect(html).toContain('type="submit"');
  });

  it("maps the tones and sizes", () => {
    const muted = renderToStaticMarkup(
      <InlineAction tone="muted" size="sm">
        x
      </InlineAction>,
    );
    expect(muted).toContain("text-muted-foreground");
    expect(muted).toContain("hover:text-foreground");
    expect(muted).toContain("text-sm");
    expect(muted).not.toContain("text-primary");
  });

  it("renders a link through asChild without a button type", () => {
    const html = renderToStaticMarkup(
      <InlineAction asChild tone="foreground">
        <a href="/insights/health-score" data-slot="history-link">
          History
        </a>
      </InlineAction>,
    );
    expect(html).toMatch(/^<a /);
    expect(html).not.toContain("type=");
    expect(html).toContain('data-slot="history-link"');
    expect(html).toContain("pointer-coarse:before:h-11");
  });

  it("takes its touch target from a hit area, never from its own height", () => {
    // A 12 px link that is 44 px tall leaves a gap under the last line of a
    // card and opens a sentence it sits in. The target is an absolutely
    // placed pseudo-element, centred on the text, so the box stays one line.
    for (const html of [
      renderToStaticMarkup(<InlineAction>Edit</InlineAction>),
      renderToStaticMarkup(
        <InlineAction asChild size="sm" tone="muted">
          <a href="/x">Open</a>
        </InlineAction>,
      ),
    ]) {
      const cls = /class="([^"]*)"/.exec(html)![1].split(" ");
      expect(cls).toContain("relative");
      expect(cls).toEqual(
        expect.arrayContaining([
          "pointer-coarse:before:absolute",
          "pointer-coarse:before:inset-x-0",
          "pointer-coarse:before:top-1/2",
          "pointer-coarse:before:h-11",
          "pointer-coarse:before:-translate-y-1/2",
        ]),
      );
      expect(
        cls.filter(
          (c) => /(?:^|:)(?:min-h|h|py)-/.test(c) && !/before:/.test(c),
        ),
      ).toEqual([]);
    }
  });
});
