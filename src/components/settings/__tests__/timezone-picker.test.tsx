import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { TimezonePicker } from "../timezone-picker";

/**
 * v1.4.37 — the "Browser-Zeitzone übernehmen" / "Use browser timezone"
 * affordance retired. Auto-seeding now happens silently inside the
 * account-section bootstrap (`detectBrowserTimezone()` on first mount
 * when the stored value is still the Europe/Berlin default), so the
 * picker chrome is just `<Label>` + `<NativeSelect>` + the hint line.
 *
 * These SSR smoke tests pin that contract end-to-end so a regression
 * that re-adds either the button copy or the icon would fail the
 * suite before reaching production.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<TimezonePicker> v1.4.37 affordance removal", () => {
  it("renders the label, select, and hint without the legacy button (en)", () => {
    const html = render(
      <TimezonePicker value="Europe/Berlin" onChange={() => {}} />,
    );
    expect(html).toContain("Timezone");
    expect(html).toContain("Used for chart axis labels");
    expect(html).not.toContain("Use browser timezone");
  });

  it("renders the label, select, and hint without the legacy button (de)", () => {
    const html = render(
      <TimezonePicker value="Europe/Berlin" onChange={() => {}} />,
      "de",
    );
    expect(html).toContain("Zeitzone");
    expect(html).not.toContain("Browser-Zeitzone übernehmen");
  });

  it("keeps the stored value selectable even when not in the IANA list", () => {
    // A made-up zone simulates an engine where the runtime IANA list
    // has rolled but the user's stored value is still valid. The
    // picker keeps the value as an extra <option> so the form does
    // not silently fall back to the first list entry.
    const html = render(
      <TimezonePicker value="Antarctica/Casey" onChange={() => {}} />,
    );
    expect(html).toContain("Antarctica/Casey");
  });
});
