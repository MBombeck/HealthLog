import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

import { LabReferenceRangeBar } from "../lab-reference-range-bar";

function render(
  props: Partial<React.ComponentProps<typeof LabReferenceRangeBar>> = {},
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <LabReferenceRangeBar
        value={72}
        referenceLow={60}
        referenceHigh={100}
        unit="bpm"
        {...props}
      />
    </I18nProvider>,
  );
}

describe("<LabReferenceRangeBar>", () => {
  it("renders the existing colored range bar for a complete numeric range", () => {
    const html = render();

    expect(html).toContain('data-slot="lab-reference-range-bar"');
    expect(html).toContain('data-slot="target-range-bar"');
    expect(html).toContain("bg-info/35");
    expect(html).toContain("bg-warning/35");
    expect(html).toContain("bg-success/35");
    expect(html).toContain("left:0%;width:");
  });

  it.each([
    ["a qualitative value", { value: null }],
    ["a missing reference range", { referenceLow: null, referenceHigh: null }],
    ["an inverted range", { referenceLow: 100, referenceHigh: 60 }],
  ])("omits the bar for %s", (_label, props) => {
    expect(render(props)).not.toContain('data-slot="lab-reference-range-bar"');
  });

  it("renders one-sided upper and lower reference limits", () => {
    expect(render({ referenceLow: null })).toContain('aria-label="≤100 bpm"');
    expect(render({ referenceHigh: null })).toContain('aria-label="≥60 bpm"');
  });

  it("prints the reading and its range in the reader's number format", () => {
    const html = render(
      { value: 1.8333, referenceLow: 0.4, referenceHigh: 4.05, unit: "mIU/L" },
      "de",
    );
    expect(html).toContain('aria-label="0,4–4,05 mIU/L"');
    // Lab precision: every recorded digit, in the locale's separator.
    expect(html).toContain("1,8333\u00a0mIU/L");
    expect(html).not.toMatch(/\d\.\d+ mIU\/L/);
  });
});
