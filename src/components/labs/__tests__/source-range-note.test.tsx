import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";

import { SourceRangeNote } from "../source-range-note";

type Reading = Parameters<typeof SourceRangeNote>[0]["reading"];

function render(reading: Reading) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SourceRangeNote reading={reading} />
    </I18nProvider>,
  );
}

const STATED: Reading = {
  unit: "mg/dL",
  referenceLow: 70,
  referenceHigh: 99,
  catalogReferenceLow: 70,
  catalogReferenceHigh: 99,
  sourceReferenceText: "70 - 99",
  printedReferenceText: null,
  sourceUnit: null,
  referenceOrigin: "source",
  referenceDivergesFromCatalog: false,
};

// 5.6 mmol/L stored as 100.9 mg/dL, with the report's 3.9 to 5.5 mmol/L window
// converted alongside it.
const CONVERTED: Reading = {
  unit: "mg/dL",
  referenceLow: 70.27,
  referenceHigh: 99.1,
  catalogReferenceLow: 70,
  catalogReferenceHigh: 100,
  sourceReferenceText: null,
  printedReferenceText: "3.9 - 5.5",
  sourceUnit: "mmol/L",
  referenceOrigin: "source",
  referenceDivergesFromCatalog: true,
};

describe("<SourceRangeNote>", () => {
  it("names a stated reading's window verbatim", () => {
    const html = render(STATED);
    expect(html).toContain("Lab&#x27;s range 70 - 99");
    expect(html).not.toContain("as printed");
  });

  it("states a converted reading's window in the marker's unit", () => {
    const html = render(CONVERTED);
    expect(html).toContain("Lab&#x27;s range 70.27–99.1 mg/dL");
  });

  it("keeps the printed text as evidence, labelled with the unit it is in", () => {
    const html = render(CONVERTED);
    expect(html).toContain("as given in mmol/L: 3.9 - 5.5");
  });

  it("never puts the printed numbers in the statement about the stored unit", () => {
    const html = render(CONVERTED);
    // The window in force is followed by the marker's unit, not the printed text.
    expect(html).not.toContain("Lab&#x27;s range 3.9 - 5.5");
    expect(html).toContain("your range 70–100 mg/dL");
  });

  it("renders nothing when the window in force is not the report's", () => {
    expect(render({ ...CONVERTED, referenceOrigin: "catalog" })).toBe("");
  });
});
