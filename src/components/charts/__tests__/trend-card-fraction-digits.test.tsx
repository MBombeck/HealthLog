import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity } from "lucide-react";

import { TrendCard } from "../trend-card";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * A whole-number metric reads as a whole number on the tile: "121 mmHg",
 * not "121,0 mmHg", and "9.240" steps rather than "9.240,0".
 */
function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="de">{node}</I18nProvider>,
  );
}

const base = {
  label: "Schritte",
  latest: 9240,
  unit: "",
  avg7: 9535.14,
  avg30: 9100,
  slope30: null,
  icon: Activity,
};

describe("<TrendCard> fractionDigits", () => {
  it("keeps one decimal by default", () => {
    const html = render(<TrendCard {...base} />);
    expect(html).toContain("9.240,0");
  });

  it("prints whole numbers, averages and deltas at 0", () => {
    const html = render(
      <TrendCard {...base} fractionDigits={0} trend7Delta={-1383.2} />,
    );
    expect(html).toContain("9.240");
    expect(html).not.toContain("9.240,0");
    expect(html).toContain("9.535");
    expect(html).not.toContain("9.535,1");
    expect(html).toContain("−1.383");
    expect(html).not.toContain("−1.383,2");
  });

  it("reads a sub-step delta as zero at 0 decimals", () => {
    const html = render(
      <TrendCard {...base} fractionDigits={0} trend7Delta={0.3} />,
    );
    expect(html).toContain("±0");
  });
});
