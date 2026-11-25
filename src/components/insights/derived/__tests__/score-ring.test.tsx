import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ScoreRing } from "../score-ring";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<ScoreRing>", () => {
  it("renders the root data-slot with a band derived from the score (populated, good)", () => {
    const html = render(<ScoreRing score={82} label="/100" />);
    expect(html).toContain('data-slot="score-ring"');
    expect(html).toContain('data-band="green"');
    expect(html).not.toContain('data-provisional="true"');
  });

  it("derives a yellow band for a mid score", () => {
    const html = render(<ScoreRing score={55} />);
    expect(html).toContain('data-band="yellow"');
  });

  it("derives a red band for a low score", () => {
    const html = render(<ScoreRing score={20} />);
    expect(html).toContain('data-band="red"');
  });

  it("reads a load score (stress, strain) the other way round", () => {
    // No server band: the ring bands 100 - score, so a stress of 80 is red.
    const heavy = render(<ScoreRing score={80} load />);
    expect(heavy).toContain('data-band="red"');
    expect(heavy).toContain("Score 80 out of 100, high");
    const light = render(<ScoreRing score={15} band="green" load />);
    expect(light).toContain('data-band="green"');
    expect(light).toContain("Score 15 out of 100, low");
  });

  it("honours an explicit band override", () => {
    const html = render(<ScoreRing score={20} band="green" />);
    expect(html).toContain('data-band="green"');
  });

  it("renders the provisional/empty state for a null score", () => {
    const html = render(<ScoreRing score={null} />);
    expect(html).toContain('data-provisional="true"');
    expect(html).toContain('data-band="none"');
    expect(html).toContain('data-slot="score-ring-provisional"');
  });

  it("carries an aria-label restating the number (not colour-only)", () => {
    const html = render(<ScoreRing score={74} />);
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
    expect(html).toContain("74");
  });

  it("carries a provisional aria-label when no score is available", () => {
    const html = render(<ScoreRing score={null} />);
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
  });

  it("keeps the band semantic regardless of the arc hue (per-metric or band)", () => {
    // The arc paints a per-metric / band hue, so the band must still ride the
    // data attribute + aria-label for the colour-blind/non-visual read.
    const html = render(<ScoreRing score={82} hue="readiness" label="/100" />);
    expect(html).toContain('data-band="green"');
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
  });
});
