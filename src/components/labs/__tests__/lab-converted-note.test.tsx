import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";

import { LabConvertedNote } from "../lab-converted-note";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function render(
  reading: Parameters<typeof LabConvertedNote>[0]["reading"],
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <LabConvertedNote reading={reading} />
    </I18nProvider>,
  );
}

describe("<LabConvertedNote>", () => {
  it("says what the report printed beside a converted reading", () => {
    const html = render({
      converted: true,
      sourceValue: 5.6,
      sourceUnit: "mmol/L",
    });
    expect(html).toContain('data-slot="lab-converted-note"');
    expect(html).toContain("converted from 5.6\u00a0mmol/L");
  });

  it("formats the number for the reader's language", () => {
    expect(
      render({ converted: true, sourceValue: 5.6, sourceUnit: "mmol/L" }, "de"),
    ).toContain("umgerechnet aus 5,6\u00a0mmol/L");
  });

  it("prints the figure the report printed, with every digit", () => {
    expect(
      render({ converted: true, sourceValue: 5.6123456, sourceUnit: "mmol/L" }),
    ).toContain("converted from 5.6123456\u00a0mmol/L");
  });

  it.each([
    [{ converted: false, sourceValue: null, sourceUnit: null }],
    [{ converted: true, sourceValue: null, sourceUnit: "mmol/L" }],
    [{ converted: true, sourceValue: 5.6, sourceUnit: null }],
  ])("renders nothing for %j", (reading) => {
    expect(render(reading)).toBe("");
  });
});
