import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { MessageBundle } from "@/lib/i18n/load-locale";
import de from "../../../../messages/de.json";

import { DayNutrientsSection } from "../day-nutrients";

function render(
  nutrients: Parameters<typeof DayNutrientsSection>[0]["nutrients"],
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider
      initialLocale={locale}
      initialMessages={
        locale === "de" ? (de as unknown as MessageBundle) : undefined
      }
    >
      <DayNutrientsSection nutrients={nutrients} />
    </I18nProvider>,
  );
}

describe("<DayNutrientsSection>", () => {
  it("gives energy, macros and water a cell and counts the micronutrients", () => {
    const html = render([
      { code: "water", amount: 1450, unit: "ml" },
      { code: "energy", amount: 2150.4, unit: "kcal" },
      { code: "protein", amount: 82.5, unit: "g" },
      { code: "magnesium", amount: 310, unit: "mg" },
      { code: "vitamin_d", amount: 20, unit: "ug" },
    ]);
    expect(html).toContain('data-slot="day-nutrients"');
    expect(html).toContain("Nutrition");
    expect(html).toContain('data-nutrient="protein"');
    expect(html).toContain("82.5 g");
    expect(html).toContain("2,150 kcal");
    expect(html).not.toContain('data-nutrient="magnesium"');
    expect(html).toContain("2 micronutrients logged");
    expect(html).toContain('href="/insights/nutrients"');
  });

  it("reads the amounts the reader's way", () => {
    const html = render([{ code: "protein", amount: 82.5, unit: "g" }], "de");
    expect(html).toContain("82,5 g");
    expect(html).toContain("Ernährung");
  });

  it("renders nothing for codes it does not know", () => {
    expect(render([{ code: "unobtainium", amount: 3, unit: "g" }])).toBe("");
  });
});
