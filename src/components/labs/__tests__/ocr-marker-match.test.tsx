import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import type { OcrExtractedRowDto } from "@/lib/validations/labs-ocr";

import {
  chooseMarker,
  seedReviewRows,
  type OcrReviewRow,
} from "../ocr-review-types";
import { toCommitRow } from "../ocr-review-validation";
import { OcrRowEditor } from "../ocr-row-editor";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

const dto: OcrExtractedRowDto = {
  analyte: "Bilirubin ges.",
  value: 0.8,
  valueText: null,
  unit: "mg/dL",
  referenceLow: null,
  referenceHigh: null,
  referenceText: null,
  takenAt: "2026-06-01",
  confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
  biomarkerMatch: "new",
  markerUnit: null,
  markerAnalyteKey: null,
  duplicateOf: null,
  biomarkerId: null,
  matchKind: null,
  suggestions: [
    {
      biomarkerId: "bm-bili",
      name: "Bilirubin (Total)",
      unit: "µmol/L",
      matchKind: "similar",
    },
  ],
};

const lookup = (id: string) =>
  id === "bm-bili"
    ? { name: "Bilirubin (Total)", analyteKey: "bilirubin-total" }
    : id === "bm-alp"
      ? { name: "Alkaline Phosphatase", analyteKey: null }
      : null;

function render(row: OcrReviewRow, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <OcrRowEditor row={row} onChange={() => {}} markerLookup={lookup} />
    </I18nProvider>,
  );
}

describe("the scan review's marker choice (D1223)", () => {
  it("seeds the match and the suggestions, with nothing chosen", () => {
    const [row] = seedReviewRows([dto], null);
    expect(row).toMatchObject({
      biomarkerId: null,
      matchKind: null,
      chosenBiomarkerId: null,
      suggestions: dto.suggestions,
    });
  });

  it("reads a scan from before the fields existed as no match", () => {
    const legacy = { ...dto } as Partial<OcrExtractedRowDto>;
    delete legacy.biomarkerId;
    delete legacy.matchKind;
    delete legacy.suggestions;
    const [row] = seedReviewRows([legacy as OcrExtractedRowDto], null);
    expect(row.suggestions).toEqual([]);
    expect(row.biomarkerId).toBeNull();
  });

  it("offers the suggestions and a new marker, new by default", () => {
    const [row] = seedReviewRows([dto], null);
    const html = render(row);
    expect(html).toContain('data-slot="ocr-row-marker-choice"');
    expect(html).toContain("Bilirubin (Total) (µmol/L)");
    expect(html).toContain("A new biomarker");
    expect(html).toMatch(/<option value="" selected="">/);
  });

  it("names the matched marker and how it was found", () => {
    const [row] = seedReviewRows(
      [
        {
          ...dto,
          analyte: "Alk.P",
          biomarkerId: "bm-alp",
          matchKind: "catalog",
          suggestions: [],
          biomarkerMatch: "existing",
          markerUnit: "U/L",
        },
      ],
      null,
    );
    const html = render(row);
    expect(html).toContain("Links to existing Alkaline Phosphatase");
    expect(html).toContain("recognized as a common abbreviation");
    expect(html).not.toContain('data-slot="ocr-row-marker-choice"');
    expect(render(row, "de")).toContain("als übliche Abkürzung erkannt");
  });

  it("files a chosen row under the marker, judged in its unit", () => {
    const [row] = seedReviewRows([dto], null);
    const chosen = chooseMarker(
      row,
      dto.suggestions[0],
      (id) => lookup(id)?.analyteKey ?? null,
    );
    expect(chosen).toMatchObject({
      chosenBiomarkerId: "bm-bili",
      biomarkerMatch: "existing",
      markerUnit: "µmol/L",
      markerAnalyteKey: "bilirubin-total",
    });
    expect(toCommitRow(chosen)).toMatchObject({ biomarkerId: "bm-bili" });

    const back = chooseMarker(chosen, null, () => null);
    expect(back).toMatchObject({
      chosenBiomarkerId: null,
      biomarkerMatch: "new",
      markerUnit: null,
    });
    expect(toCommitRow(back)).not.toHaveProperty("biomarkerId");
  });

  it("sends no marker for an automatic match", () => {
    const [row] = seedReviewRows(
      [{ ...dto, biomarkerId: "bm-alp", matchKind: "alias", suggestions: [] }],
      null,
    );
    expect(toCommitRow(row)).not.toHaveProperty("biomarkerId");
  });
});
