import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { TargetsSummaryHeader } from "../targets-summary-header";

/**
 * v1.4.25 W3e — page-level summary line. Three load-bearing cases:
 *  1. Partial: "4 of 6 targets met this week"
 *  2. Full: "All 6 targets met this week" + check mark
 *  3. With streak highlight chip
 */

function render(props: Parameters<typeof TargetsSummaryHeader>[0]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <TargetsSummaryHeader {...props} />
    </I18nProvider>,
  );
}

describe("<TargetsSummaryHeader>", () => {
  it("renders the partial-count headline when met < total", () => {
    const html = render({
      targetsMetThisWeek: 4,
      totalTargets: 6,
      streakHighlight: null,
    });
    expect(html).toContain('data-slot="targets-summary-title"');
    expect(html).toContain("4 of 6 targets met this week");
    // Check mark should NOT render in the partial state.
    expect(html).not.toContain("lucide-check");
  });

  it("renders the all-met headline + check mark when every target is met", () => {
    const html = render({
      targetsMetThisWeek: 6,
      totalTargets: 6,
      streakHighlight: null,
    });
    expect(html).toContain("All 6 targets met this week");
    expect(html).toContain("text-[var(--dracula-green)]");
  });

  it("renders the streak highlight chip when present", () => {
    const html = render({
      targetsMetThisWeek: 4,
      totalTargets: 6,
      streakHighlight: { metric: "BLOOD_PRESSURE", days: 5 },
    });
    expect(html).toContain('data-slot="targets-summary-streak"');
    expect(html).toContain("5-day streak: Blood pressure");
  });

  it("renders nothing when there are no targets at all", () => {
    const html = render({
      targetsMetThisWeek: 0,
      totalTargets: 0,
      streakHighlight: null,
    });
    expect(html).toBe("");
  });
});
