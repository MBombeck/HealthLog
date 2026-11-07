import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import en from "../../../../messages/en.json";

vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/api-fetch")>()),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

import { BiomarkerForm } from "../biomarker-form";
import { LabUnitInput } from "../lab-unit-input";
import type { OcrReviewRow } from "../ocr-review-types";
import { OcrRowEditor } from "../ocr-row-editor";

/**
 * The explicit "no unit" choice for a ratio or an index. It is offered next to
 * every lab unit field a person fills in, it shows as chosen when the unit is
 * the UCUM unity `"1"`, and it never reads an empty unit as that choice.
 */

function render(node: React.ReactNode): string {
  // The marker form reads the biomarker list for its panel suggestions.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const NONE = en.labs.unit.none;

function noneBox(html: string): string {
  const box = html.match(/<button[^>]*role="checkbox"[^>]*>/)?.[0];
  if (!box) throw new Error("no checkbox rendered");
  return box;
}

describe("<LabUnitInput>", () => {
  it("offers the choice and leaves it unticked for an empty unit", () => {
    const html = render(
      <LabUnitInput id="u" value="" onChange={() => {}} required />,
    );
    expect(html).toContain(NONE);
    expect(html).toContain(en.labs.unit.noneHint);
    expect(noneBox(html)).toContain('aria-checked="false"');
    expect(html).toMatch(/<input[^>]*id="u"[^>]*required/);
  });

  it("shows the unity as the ticked choice, not as a typed 1", () => {
    const html = render(
      <LabUnitInput id="u" value="1" onChange={() => {}} required />,
    );
    expect(noneBox(html)).toContain('aria-checked="true"');
    const input = html.match(/<input[^>]*id="u"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('value=""');
    expect(input).toContain("disabled");
    expect(input).not.toContain("required");
  });

  it("leaves a real unit as it is", () => {
    const html = render(
      <LabUnitInput id="u" value="mg/dL" onChange={() => {}} />,
    );
    expect(noneBox(html)).toContain('aria-checked="false"');
    expect(html).toContain('value="mg/dL"');
  });

  it("is a plain field where no unit makes no sense", () => {
    const html = render(
      <LabUnitInput id="u" value="1" onChange={() => {}} allowNoUnit={false} />,
    );
    expect(html).not.toContain(NONE);
    expect(html).toContain('value="1"');
  });
});

describe("the no-unit choice on the lab forms", () => {
  it("is offered when a marker is defined", () => {
    const html = render(<BiomarkerForm />);
    expect(html).toContain(NONE);
  });

  it("is offered on a scanned report's row", () => {
    const row: OcrReviewRow = {
      key: "INR-0",
      analyte: "INR",
      value: 1.1,
      valueText: null,
      unit: null,
      referenceLow: 0.8,
      referenceHigh: 1.2,
      referenceText: null,
      takenAt: null,
      confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
      biomarkerMatch: "new",
      markerUnit: null,
      markerAnalyteKey: null,
      duplicateOf: null,
      biomarkerId: null,
      matchKind: null,
      suggestions: [],
      chosenBiomarkerId: null,
      confirmed: true,
    };
    const html = render(<OcrRowEditor row={row} onChange={() => {}} />);
    expect(html).toContain(NONE);
  });

  it("names a marker without a unit in words where a scanned row disagrees", () => {
    const row: OcrReviewRow = {
      key: "INR-1",
      analyte: "INR",
      value: 1.1,
      valueText: null,
      unit: "s",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      takenAt: null,
      confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
      biomarkerMatch: "existing",
      markerUnit: "1",
      markerAnalyteKey: null,
      duplicateOf: null,
      biomarkerId: "bm-inr",
      matchKind: "name",
      suggestions: [],
      chosenBiomarkerId: null,
      confirmed: true,
    };
    const html = render(
      <OcrRowEditor
        row={row}
        onChange={() => {}}
        errors={{ unitMismatch: true }}
      />,
    );
    expect(html).toContain(en.labs.ocr.errorUnitMismatchNoUnit);
    expect(html).toContain("Tracked without a unit; this report says s");
    expect(html).not.toContain("tracked in 1");
  });
});
