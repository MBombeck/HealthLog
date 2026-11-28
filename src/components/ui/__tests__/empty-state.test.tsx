import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyState } from "../empty-state";

describe("<EmptyState>", () => {
  it("renders the title and the action inside a polite live region", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="Noch keine Messungen"
        action={<button type="button">Messung anlegen</button>}
      />,
    );
    expect(html).toContain("Noch keine Messungen");
    expect(html).toContain("Messung anlegen");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("says it once: a title and an action, no sentence beside them", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="Noch keine Messungen"
        action={<button type="button">Messung anlegen</button>}
      />,
    );
    // One paragraph (the title), no second text block.
    expect(html.match(/<p\b/g)).toHaveLength(1);
    const props = {
      title: "x",
      description: "Erkläre die Seite noch einmal.",
    };
    // @ts-expect-error a description is not part of an empty state
    void (<EmptyState {...props} description={props.description} />);
  });

  it("is one row, the height of the rows it stands for", () => {
    const html = renderToStaticMarkup(<EmptyState title="leer" />);
    expect(html).toContain("min-h-14");
    expect(html).toContain("items-center");
    expect(html).not.toContain("flex-col");
  });

  it("hides the decorative icon from assistive tech", () => {
    const html = renderToStaticMarkup(
      <EmptyState icon={<svg data-testid="icon" />} title="leer" />,
    );
    expect(html).toMatch(/aria-hidden="true"[^>]*>[^<]*<svg/);
  });

  it("frames the card variant and leaves the plain one bare", () => {
    const card = renderToStaticMarkup(<EmptyState title="x" />);
    const plain = renderToStaticMarkup(
      <EmptyState title="x" variant="plain" />,
    );
    expect(card).toMatch(/class="[^"]*\bborder\b/);
    expect(card).toMatch(/class="[^"]*\bpx-4\b/);
    expect(card).not.toContain("border-dashed");
    expect(plain).not.toMatch(/\bborder\b/);
    expect(plain).not.toMatch(/\bpx-4\b/);
  });
});
