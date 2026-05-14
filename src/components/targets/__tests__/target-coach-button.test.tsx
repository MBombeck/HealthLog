import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { TargetCoachButton } from "../target-coach-button";

/**
 * v1.4.25 W3e — gate test for the per-card Coach CTA. The button
 * MUST disappear when `aiEnabled` is false (Marc directive: no
 * broken-button state for users with no AI provider configured).
 */

function render(props: Parameters<typeof TargetCoachButton>[0]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <TargetCoachButton {...props} />
    </I18nProvider>,
  );
}

describe("<TargetCoachButton>", () => {
  const baseProps = {
    prefill: "How am I doing on weight?",
    sources: ["weight"] as const,
    onAskCoach: vi.fn(),
  };

  it("renders the button when aiEnabled is true", () => {
    const html = render({ ...baseProps, aiEnabled: true });
    expect(html).toContain('data-slot="target-coach-cta"');
    expect(html).toContain("Ask Coach");
  });

  it("renders NOTHING when aiEnabled is false (no broken-button state)", () => {
    const html = render({ ...baseProps, aiEnabled: false });
    expect(html).toBe("");
  });

  it("does not call onAskCoach during SSR", () => {
    const onAskCoach = vi.fn();
    render({ ...baseProps, onAskCoach, aiEnabled: true });
    // Server-side render does not fire click handlers.
    expect(onAskCoach).not.toHaveBeenCalled();
  });
});
