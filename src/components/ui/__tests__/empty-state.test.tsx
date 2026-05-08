import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyState } from "../empty-state";

describe("<EmptyState>", () => {
  it("renders title, description, and action inside a polite live region", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="Noch keine Messungen"
        description="Lege deine erste Messung an."
        action={<button type="button">Messung anlegen</button>}
      />,
    );
    expect(html).toContain("Noch keine Messungen");
    expect(html).toContain("Lege deine erste Messung an.");
    expect(html).toContain("Messung anlegen");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("hides the decorative icon from assistive tech", () => {
    const html = renderToStaticMarkup(
      <EmptyState icon={<svg data-testid="icon" />} title="leer" />,
    );
    // The icon's wrapper carries aria-hidden so the icon doesn't
    // double-announce alongside the title.
    expect(html).toMatch(/aria-hidden="true"[^>]*>[^<]*<svg/);
  });

  it("compact variant tightens spacing", () => {
    const def = renderToStaticMarkup(<EmptyState title="default" />);
    const compact = renderToStaticMarkup(
      <EmptyState title="compact" size="compact" />,
    );
    expect(def).toContain("py-8");
    expect(compact).toContain("py-4");
    expect(compact).not.toContain("py-8");
  });

  it("plain variant drops the dashed wrapper", () => {
    const card = renderToStaticMarkup(<EmptyState title="x" />);
    const plain = renderToStaticMarkup(
      <EmptyState title="x" variant="plain" />,
    );
    expect(card).toContain("border-dashed");
    expect(plain).not.toContain("border-dashed");
  });
});
