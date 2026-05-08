import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { TrendHint } from "../trend-hint";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<TrendHint>", () => {
  it("renders nothing for 0 readings", () => {
    expect(render(<TrendHint count={0} />)).toBe("");
  });

  it("renders nothing once 5+ readings exist", () => {
    expect(render(<TrendHint count={5} />)).toBe("");
    expect(render(<TrendHint count={42} />)).toBe("");
  });

  it("shows a singular wording when only 1 reading missing", () => {
    const html = render(<TrendHint count={4} />);
    expect(html).toContain("First trend after 5 readings");
    expect(html).toContain("1 more reading to go.");
  });

  it("shows a plural wording for >1 missing readings", () => {
    const html = render(<TrendHint count={1} />);
    expect(html).toContain("4 more readings to go.");
  });

  it("translates to German when locale is de", () => {
    const html = render(<TrendHint count={3} />, "de");
    expect(html).toContain("Erster Trend nach 5 Messungen");
    expect(html).toContain("Noch 2 Messungen bis zum Trend.");
  });
});
