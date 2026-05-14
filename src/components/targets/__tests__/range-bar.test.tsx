import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { RangeBar } from "../range-bar";

/**
 * v1.4.25 W3e — `<RangeBar>` was extracted from the inline 790-line
 * `targets/page.tsx`. Behaviour is intentionally unchanged from the
 * v1.4.22 inline version; these tests pin the contract so the
 * extraction is provably side-effect-free.
 */

function render(props: Parameters<typeof RangeBar>[0]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <RangeBar {...props} />
    </I18nProvider>,
  );
}

describe("<RangeBar>", () => {
  it("renders the bar slot + green/orange/red zones with Dracula tokens", () => {
    const html = render({
      value: 72,
      min: 60,
      max: 100,
      unit: "bpm",
    });
    expect(html).toContain('data-slot="target-range-bar"');
    expect(html).toContain("bg-dracula-green/20");
    expect(html).toContain("bg-dracula-orange/15");
    expect(html).toContain("bg-dracula-red/10");
    // Pin the absence of the legacy raw Tailwind palette so the swap
    // doesn't silently regress on future merges.
    expect(html).not.toContain("bg-green-500/20");
    expect(html).not.toContain("bg-yellow-500/12");
    expect(html).not.toContain("bg-red-500/8");
  });

  it("paints the marker with the green token when the value is in range", () => {
    const html = render({
      value: 80,
      min: 60,
      max: 100,
      unit: "bpm",
    });
    expect(html).toContain("var(--dracula-green)");
  });

  it("paints the marker with the red token when the value is out of band", () => {
    const html = render({
      value: 180,
      min: 60,
      max: 100,
      unit: "bpm",
    });
    expect(html).toContain("var(--dracula-red)");
  });
});
