import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";

import { LayoutCoachFab } from "../layout-coach-fab";

/**
 * v1.4.33 (F15) — layout-level Coach FAB contract.
 *
 * The FAB sits at the mobile bottom-right. Before v1.4.33 it overlaid
 * Recharts tooltips when the user tapped a data point in the chart's
 * lower-right corner — the maintainer flagged this as F15 in the
 * runtime audit. The fix wires the FAB to `useChartTooltipActive()`
 * which reads a singleton MutationObserver of every
 * `.recharts-tooltip-wrapper`; while a wrapper is visible the FAB
 * fades and drops `pointer-events`.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`),
 * so we pin the initial-paint state — no tooltip can be active before
 * hydration, so the FAB renders without the active-flag attribute
 * and stays interactive on first paint. The end-to-end auto-hide
 * behaviour is exercised in the Playwright mobile suite.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<LayoutCoachFab>", () => {
  it("returns nothing when no <CoachLaunchProvider> is mounted", () => {
    // The hook returns `null` outside the provider; the FAB then
    // renders nothing rather than crashing — same posture as
    // `<CoachLaunchButton>`.
    const html = render(<LayoutCoachFab />);
    expect(html).not.toContain('data-slot="coach-launch-fab"');
  });

  it("mounts the FAB with the launch-fab slot under the provider", () => {
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).toMatch(/data-slot="coach-launch-fab"/);
  });

  it("renders without the chart-tooltip-active flag on first paint", () => {
    // SSR snapshot of `useChartTooltipActive()` is `false` so the
    // FAB stays interactive on initial render. The active classes
    // (opacity-0 + pointer-events-none) are applied client-side only
    // once a Recharts tooltip wrapper flips its inline visibility.
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    // The data attribute is `undefined` when inactive — React drops
    // it from the DOM so the rendered markup never carries it.
    expect(html).not.toContain('data-chart-tooltip-active="true"');
    // The shadcn `<Button>` primitive bakes in
    // `disabled:pointer-events-none` and `[&_svg]:pointer-events-none`,
    // so we look for the unprefixed token that the fade-out adds.
    // Match it as a class atom (preceded by space/start, followed by
    // space/end-of-class-list/quote) so the primitive's prefixed
    // variants can't false-match.
    expect(html).not.toMatch(/(?:^|["\s])pointer-events-none(?=["\s])/);
    expect(html).not.toContain("opacity-0");
  });

  it("carries the transition class so the fade is animated", () => {
    // The fade-out + fade-in shouldn't pop visually — the FAB
    // animates opacity over 150ms.
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).toContain("transition-opacity");
    expect(html).toContain("duration-150");
  });

  it("hides the FAB above lg via `lg:hidden`", () => {
    // The desktop Coach surface is the inline pill; the FAB stays
    // mobile-only.
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).toContain("lg:hidden");
  });

  it("renders the localised label in German", () => {
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
      "de",
    );
    expect(html).toContain("Coach fragen");
  });
});
