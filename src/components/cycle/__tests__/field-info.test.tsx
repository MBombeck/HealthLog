import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { FieldInfo } from "../field-info";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<FieldInfo>", () => {
  it("is a real focusable button carrying the accessible label", () => {
    const html = render(
      <FieldInfo
        label="What is basal body temperature?"
        detail="Your resting temperature."
      />,
    );
    // A real <button type="button"> — keyboard- and SR-reachable, not hover-only.
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="What is basal body temperature?"');
    // The e2e hook the cycle sheet asserts on.
    expect(html).toContain('data-hint="cycle-field-info"');
  });

  it("starts closed so the explainer opens on tap/focus, not hover-only", () => {
    // Radix renders the tooltip content lazily (portal, on open); the trigger
    // therefore reports a closed state until interacted with.
    const html = render(
      <FieldInfo
        label="Cervical mucus"
        detail="Discharge changes across the cycle."
      />,
    );
    expect(html).toContain('data-state="closed"');
  });
});
