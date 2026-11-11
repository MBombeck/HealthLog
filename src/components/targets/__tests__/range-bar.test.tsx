import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { EDGE_PADDING_PERCENT, RangeBar } from "../range-bar";

/**
 * v1.4.25 — `<RangeBar>` was extracted from the inline 790-line
 * `targets/page.tsx`. Behaviour is intentionally unchanged from the
 * v1.4.22 inline version; these tests pin the contract so the
 * extraction is provably side-effect-free.
 */

function render(
  props: Parameters<typeof RangeBar>[0],
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <RangeBar {...props} />
    </I18nProvider>,
  );
}

describe("<RangeBar>", () => {
  it("renders the bar slot + green/orange/red zones with semantic tokens", () => {
    const html = render({
      value: 72,
      min: 60,
      max: 100,
      unit: "bpm",
    });
    expect(html).toContain('data-slot="target-range-bar"');
    expect(html).toContain("bg-success/20");
    expect(html).toContain("bg-warning/15");
    expect(html).toContain("bg-destructive/10");
    // Pin the absence of the legacy raw Tailwind palette so the swap
    // doesn't silently regress on future merges.
    expect(html).not.toContain("bg-green-500/20");
    expect(html).not.toContain("bg-yellow-500/12");
    expect(html).not.toContain("bg-red-500/8");
  });

  it("paints the marker with the success token when the value is in range", () => {
    const html = render({
      value: 80,
      min: 60,
      max: 100,
      unit: "bpm",
    });
    expect(html).toContain("var(--success)");
  });

  it("paints the marker with the destructive token when the value is out of band", () => {
    const html = render({
      value: 180,
      min: 60,
      max: 100,
      unit: "bpm",
    });
    expect(html).toContain("var(--destructive)");
  });

  it("keeps a lab outlier clear of the bar edge", () => {
    const html = render({
      value: 6.8,
      min: 30,
      max: 100,
      unit: "ng/mL",
      compact: true,
      tone: "lab",
    });

    // Assert the distance, not one unlucky string. `not.toContain("left: 4%")`
    // passes for a marker at 4.02%, which is the same defect one rounding away.
    // The marker is the fourth `left:` in the markup — the three before it are
    // the bar slot and the band edges.
    const positions = [...html.matchAll(/left:\s*([0-9.]+)%/g)].map((m) =>
      Number(m[1]),
    );
    const marker = positions[3];

    expect(marker).toBeGreaterThan(EDGE_PADDING_PERCENT);
    // And not flung to the other end by an over-eager expansion.
    expect(marker).toBeLessThan(100 - EDGE_PADDING_PERCENT);
  });

  it("makes the marker a button named with the value + range, so a tap or a key opens its numbers", () => {
    const html = render({
      value: 72,
      min: 60,
      max: 100,
      unit: "bpm",
    });
    expect(html).toMatch(
      /<button type="button" aria-label="Current: 72 bpm[^"]*"/,
    );
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("prints value, bounds and delta in the reader's number format", () => {
    // A German reader saw "61.3 kg" under a German interface.
    const html = render(
      { value: 72.4, min: 50.5, max: 70.25, unit: "kg" },
      "de",
    );
    expect(html).toContain("50,5 kg");
    expect(html).toContain("70,25 kg");
    expect(html).toContain("72,4 kg");
    expect(html).toContain("2,2 kg");
    expect(html).not.toMatch(/\d\.\d+ kg/);
  });
});
