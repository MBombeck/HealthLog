import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Heart } from "lucide-react";

import { SparklineDeltaTile } from "../sparkline-delta-tile";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const base = {
  label: "Resting HR",
  unit: "bpm",
  icon: Heart,
};

describe("<SparklineDeltaTile>", () => {
  it("renders the value, unit and a framing line (populated)", () => {
    const html = render(
      <SparklineDeltaTile
        {...base}
        value={58}
        series={[60, 59, 58, 57, 58]}
        delta={-3}
        directionSentiment="up-bad"
        framing="typical for age 31"
      />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile"');
    expect(html).toContain('data-slot="sparkline-delta-tile-value"');
    expect(html).toContain("58");
    expect(html).toContain("bpm");
    expect(html).toContain("typical for age 31");
    expect(html).toContain('data-slot="sparkline-delta-tile-framing"');
  });

  it("paints a falling delta on an up-bad metric as green (improvement)", () => {
    const html = render(
      <SparklineDeltaTile
        {...base}
        value={58}
        delta={-3}
        directionSentiment="up-bad"
      />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile-delta"');
    // Semantic --success token (AA-safe in light mode, identical in dark).
    expect(html).toContain("text-success");
  });

  it("renders the empty state for a null value with no sparkline slot", () => {
    const html = render(<SparklineDeltaTile {...base} value={null} />);
    expect(html).toContain('data-slot="sparkline-delta-tile-value"');
    expect(html).toContain("—");
    // No series → the sparkline row collapses entirely (no reserved empty
    // dashed placeholder, which read as visual dead space across the grid).
    expect(html).not.toContain('data-slot="sparkline-delta-tile-spark"');
    expect(html).not.toContain("border-dashed");
  });

  it("keeps the arrow slot empty when there is no delta", () => {
    const html = render(<SparklineDeltaTile {...base} value={58} />);
    expect(html).toMatch(
      /data-slot="sparkline-delta-tile-arrow"[^>]*><\/span>/,
    );
    expect(html).not.toContain("—");
  });

  it("omits the sparkline row when series < 2 points", () => {
    const html = render(
      <SparklineDeltaTile {...base} value={58} series={[58]} />,
    );
    expect(html).not.toContain('data-slot="sparkline-delta-tile-spark"');
  });

  it("renders the sparkline chart when a series of >= 2 points is passed", () => {
    const html = render(
      <SparklineDeltaTile {...base} value={58} series={[60, 59, 58]} />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile-spark"');
  });

  it("renders the provenance affordance in the label row when passed", () => {
    const html = render(
      <SparklineDeltaTile
        {...base}
        value={58}
        provenance={<button data-slot="test-prov">i</button>}
      />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile-provenance"');
    expect(html).toContain('data-slot="test-prov"');
  });

  it("surfaces the stale caption when staleDays > 7", () => {
    const html = render(
      <SparklineDeltaTile {...base} value={58} staleDays={12} />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile-stale"');
    expect(html).toContain('data-stale-days="12"');
  });

  it("omits the stale caption for fresh data", () => {
    const html = render(
      <SparklineDeltaTile {...base} value={58} staleDays={3} />,
    );
    expect(html).not.toContain('data-slot="sparkline-delta-tile-stale"');
  });
});
