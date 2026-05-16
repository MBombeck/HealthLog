import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { TargetCoachButton } from "../target-coach-button";

/**
 * v1.4.25 W3e — gate test for the per-card Coach CTA. The button
 * MUST disappear when `aiEnabled` is false (the maintainer's rule:
 * no broken-button state for users with no provider configured).
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
    // v1.4.28 FB-L1 — the affordance is now icon-only; the label
    // survives as an aria-label + title so screen readers + tooltips
    // still surface "Ask Coach" / "Coach fragen".
    expect(html).toContain('aria-label="Ask Coach"');
    expect(html).toContain('title="Ask Coach"');
    // No visible text label — only the Sparkles glyph.
    expect(html).not.toMatch(/>Ask Coach</);
    // UI-H2 — the Coach-launch glyph is one Sparkles vocabulary
    // across hero strip, inline pill, layout FAB and per-card icon.
    expect(html).toMatch(/lucide-sparkles/i);
    expect(html).not.toMatch(/lucide-message-circle/i);
  });

  it("lifts the tap target to the 44 px WCAG 2.5.5 floor", () => {
    // The icon variant alone ships `size-10` (40 px); the per-card
    // Coach button rides `min-h-11 min-w-11` on top so the hit
    // surface matches the medication-history and Coach drawer
    // buttons. Pinning the class so a future refactor can't drop
    // back to the 40 px shadcn default.
    const html = render({ ...baseProps, aiEnabled: true });
    const trigger = html.match(
      /<button[^>]*data-slot="target-coach-cta"[^>]*>/,
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.[0]).toContain("min-h-11");
    expect(trigger?.[0]).toContain("min-w-11");
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
