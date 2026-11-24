import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { readSourceFolder } from "@/__tests__/helpers/source-files";

import { Label } from "../label";

describe("<Label>", () => {
  it("lays out inline so the colon stays on the last word when it wraps", () => {
    const html = renderToStaticMarkup(
      <Label htmlFor="x">Body temperature</Label>,
    );
    expect(html).toContain("inline-block");
    // A flex box turns the ::after colon into a flex item of its own, which
    // floats beside a wrapped label instead of following its last word.
    expect(html).not.toMatch(/class="[^"]*\binline-flex\b/);
    expect(html).toContain("after:content-[&#x27;:&#x27;]");
  });

  it("starts on the reading edge, with no left padding of its own", () => {
    const html = renderToStaticMarkup(<Label htmlFor="x">Push back by</Label>);
    const cls = html.match(/class="([^"]*)"/)?.[1] ?? "";
    expect(cls).toContain("inline-block");
    expect(cls).not.toMatch(/(^|\s)(pl|px|ps|p)-/);
  });

  it("drops the colon when asked", () => {
    const html = renderToStaticMarkup(
      <Label htmlFor="x" noColon>
        Note
      </Label>,
    );
    expect(html).toContain('data-no-colon="true"');
  });

  it("adds no colon to a label that already ends in punctuation", () => {
    // "What are you tracking for?:" and "Your recent average::" were both on
    // screen. The label reads its own text.
    for (const text of [
      "What are you tracking for?",
      "Your recent average:",
      "Wofür trackst du?",
      "무엇을 기록하나요？",
    ]) {
      const html = renderToStaticMarkup(<Label htmlFor="x">{text}</Label>);
      expect(html, text).toContain('data-no-colon="true"');
    }
    for (const text of ["Body temperature", "Note (optional)", "Dose (mg)"]) {
      const html = renderToStaticMarkup(<Label htmlFor="x">{text}</Label>);
      expect(html, text).toContain('data-no-colon="false"');
    }
  });

  it("lets a call site take over the layout", () => {
    const html = renderToStaticMarkup(
      <Label htmlFor="x" className="flex items-baseline">
        Weight
      </Label>,
    );
    expect(html).toMatch(/class="[^"]*\bflex\b/);
    expect(html).not.toContain("inline-block");
  });
});

describe("Label call sites", () => {
  // The primitive owns the label's left edge. A call site that pads it
  // back in (`pl-1`) or out (`pl-0`, which only made sense against the old
  // `pl-1`) reopens the 4 px step between a field name and its card text.
  const LABEL_WITH_INSET =
    /<(Label|legend)\b[^>]*className=["'`{][^>]*?\b(pl|px|ps)-\d/;

  it("never set a horizontal inset on a Label or a group's legend", () => {
    const isSource = (rel: string) =>
      rel.endsWith(".tsx") &&
      !rel.includes("__tests__/") &&
      !rel.includes(".test.");
    const files = [
      ...readSourceFolder("src/components", { floor: 500, include: isSource }),
      ...readSourceFolder("src/app", { floor: 100, include: isSource }),
    ];
    const offenders = files
      .filter(([, text]) => LABEL_WITH_INSET.test(text))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("matches the shape it guards", () => {
    expect(LABEL_WITH_INSET.test('<Label htmlFor="a" className="pl-0">')).toBe(
      true,
    );
    expect(LABEL_WITH_INSET.test('<legend className="pl-1 text-sm">')).toBe(
      true,
    );
    expect(LABEL_WITH_INSET.test('<Label htmlFor="a" className="gap-1">')).toBe(
      false,
    );
  });
});
