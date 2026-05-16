import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// vitest runs in the Node environment (no jsdom). The tour's interactive
// behaviour (keyboard navigation, focus management, target measurement)
// is exercised by the pure state machine at
// `src/lib/onboarding/__tests__/tour-state.test.ts` and by the e2e
// suite at `e2e/onboarding-tour.spec.ts`. Here we lock the SSR contract:
// initial render shape, ARIA wiring, i18n keys, and that the first
// step is the tile strip.

import { I18nProvider } from "@/lib/i18n/context";
import { OnboardingTour } from "../tour";

function renderTour(includeAchievements = true) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <OnboardingTour
        includeAchievements={includeAchievements}
        onClose={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("<OnboardingTour>", () => {
  it("renders a modal dialog with role=dialog and aria-modal=true", () => {
    const html = renderTour();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="onboarding-tour-title"');
  });

  it("starts on the tile-strip step (1 of 5 by default)", () => {
    const html = renderTour();
    expect(html).toContain("Step 1 of 5");
    expect(html).toContain("Your daily numbers");
    // Body of the first step should mention the tile strip context.
    expect(html).toContain("tile strip");
  });

  it("drops the achievements stop when the flag is off (1 of 4)", () => {
    const html = renderTour(false);
    expect(html).toContain("Step 1 of 4");
  });

  it("exposes a skip control with an accessible label", () => {
    const html = renderTour();
    // After v1.4.33 F2 the dim panels are purely visual
    // (pointer-events: none) so skip lives entirely on the explicit
    // tooltip-footer Skip button. The visible label still has to be
    // there — both for sighted users and for screen readers.
    expect(html).toContain("Skip tour");
  });

  it("renders both the Skip button and the primary Next button on the first step", () => {
    const html = renderTour();
    expect(html).toContain("Skip tour");
    expect(html).toContain(">Next<");
  });

  it("attaches a stable test hook for the primary action so e2e can drive it", () => {
    const html = renderTour();
    expect(html).toContain('data-testid="onboarding-tour-primary"');
    expect(html).toContain('data-testid="onboarding-tour-tooltip"');
    expect(html).toContain('data-testid="onboarding-tour"');
  });

  it("places a polite live region announcing the current step", () => {
    const html = renderTour();
    expect(html).toContain('aria-live="polite"');
  });

  it("German locale resolves the tour i18n keys end-to-end", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <OnboardingTour onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(html).toContain("Schritt 1 von 5");
    expect(html).toContain("Deine Tageswerte");
    expect(html).toContain("Tour überspringen");
  });
});
