import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Textarea } from "../textarea";

describe("<Textarea>", () => {
  it("pins text-base on touch screens and shrinks to text-sm only under a fine pointer (iOS zoom defence)", () => {
    const html = renderToStaticMarkup(<Textarea id="note" />);
    expect(html).toContain("text-base");
    expect(html).toContain("sm:pointer-fine:text-sm");
    // A width breakpoint alone handed 14 px to a phone held sideways.
    expect(html).not.toMatch(/(^|\s)sm:text-sm(\s|")/);
  });

  it("floors at min-h-11 on mobile and min-h-9 on sm+ (WCAG 2.5.5 tap target)", () => {
    const html = renderToStaticMarkup(<Textarea id="note" />);
    expect(html).toContain("min-h-11");
    expect(html).toContain("sm:min-h-9");
  });

  it("defaults autoComplete to off and tells password managers to skip", () => {
    const html = renderToStaticMarkup(<Textarea id="note" />);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('data-lpignore="true"');
    expect(html).toContain('data-1p-ignore="true"');
    expect(html).toContain('data-bwignore="true"');
  });

  it("defaults autoCapitalize to sentences for prose-like free-text input", () => {
    const html = renderToStaticMarkup(<Textarea id="note" />);
    expect(html).toContain('autoCapitalize="sentences"');
  });

  it("enables spellCheck by default", () => {
    const html = renderToStaticMarkup(<Textarea id="note" />);
    expect(html).toContain('spellCheck="true"');
  });

  it("emits the data-slot attribute (shadcn convention)", () => {
    const html = renderToStaticMarkup(<Textarea id="note" />);
    expect(html).toContain('data-slot="textarea"');
  });

  it("allows callers to override autoCapitalize for code / JSON input", () => {
    const html = renderToStaticMarkup(
      <Textarea id="json" autoCapitalize="none" spellCheck={false} />,
    );
    expect(html).toContain('autoCapitalize="none"');
    expect(html).not.toContain('spellCheck="true"');
  });

  it("respects an explicit autoComplete value and drops the ignore attrs", () => {
    const html = renderToStaticMarkup(<Textarea id="bio" autoComplete="on" />);
    expect(html).toContain('autoComplete="on"');
    expect(html).not.toContain('data-lpignore="true"');
    expect(html).not.toContain('data-1p-ignore="true"');
    expect(html).not.toContain('data-bwignore="true"');
  });

  it("merges caller className via cn() without dropping defaults", () => {
    const html = renderToStaticMarkup(
      <Textarea id="note" className="font-mono" />,
    );
    expect(html).toContain("font-mono");
    // iOS zoom defence still present after merge
    expect(html).toContain("text-base");
    expect(html).toContain("sm:pointer-fine:text-sm");
  });

  it("forwards rows / placeholder / maxLength to the underlying element", () => {
    const html = renderToStaticMarkup(
      <Textarea
        id="note"
        rows={8}
        placeholder="Tell us more"
        maxLength={5000}
      />,
    );
    expect(html).toContain('rows="8"');
    expect(html).toContain('placeholder="Tell us more"');
    expect(html).toContain('maxLength="5000"');
  });
});
