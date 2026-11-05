import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";

import type { OcrReviewRow } from "../ocr-review-types";
import { OcrRowEditor } from "../ocr-row-editor";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

const baseRow: OcrReviewRow = {
  key: "LDL-0",
  analyte: "LDL",
  value: 2.4,
  valueText: null,
  unit: "mmol/L",
  referenceLow: 0,
  referenceHigh: 3,
  referenceText: null,
  takenAt: null,
  confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
  biomarkerMatch: "existing",
  markerUnit: "mmol/L",
  markerAnalyteKey: null,
  duplicateOf: null,
  biomarkerId: "bm-ldl",
  matchKind: "name",
  suggestions: [],
  chosenBiomarkerId: null,
  confirmed: true,
};

function render(
  errors: Parameters<typeof OcrRowEditor>[0]["errors"],
  locale: "en" | "de" = "en",
  row: OcrReviewRow = baseRow,
): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <OcrRowEditor row={row} onChange={() => {}} errors={errors} />
    </I18nProvider>,
  );
}

describe("<OcrRowEditor> required-field marking", () => {
  it("shows no error state before a save was attempted", () => {
    const html = render(undefined);
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
  });

  it("marks the missing date, states why, and links the message to the field", () => {
    const html = render({ date: true });
    const invalid = html.match(/<input[^>]*aria-invalid="true"[^>]*>/g) ?? [];
    expect(invalid).toHaveLength(1);
    const describedBy = invalid[0]?.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain("Add the sample date.");
    expect(html).toContain('role="alert"');
    // The bordered wrapper is what the eye sees.
    expect(html).toContain("border-destructive");
  });

  it("marks only the fields that are wrong", () => {
    const html = render({ unit: true });
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(html).toContain("Add a unit.");
    expect(html).not.toContain("Add the sample date.");
  });

  it("marks a blank qualitative result", () => {
    const html = render({ valueText: true }, "en", {
      ...baseRow,
      value: null,
      valueText: "",
      unit: null,
    });
    expect(html).toContain("Add a result.");
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
  });

  it("carries a visible required marker on the fields a row needs", () => {
    const html = render(undefined);
    // Value, unit and date on a numeric row.
    expect(html.match(/text-destructive"[^>]*> \*</g)).toHaveLength(3);
  });

  it("speaks German too", () => {
    expect(render({ date: true }, "de")).toContain("Bitte ein Datum angeben.");
  });
});

describe("<OcrRowEditor> layout", () => {
  it("lays out from the width of its container, not the window", () => {
    const html = render(undefined);
    expect(html).toContain('class="@container"');
    // Two columns only once the container is wide; stacked below that.
    expect(html).toContain("@3xl:grid-cols-");
  });

  it("sizes the field grid from its own container, never from the window", () => {
    const numeric = render(undefined);
    expect(numeric).toContain("@md:grid-cols-3");
    expect(numeric).not.toMatch(/(?<![@\w-])sm:grid-cols/);

    // A qualitative result spans the grid's columns; the span has to follow
    // the same query as the columns, or it would open a column of its own.
    const qualitative = render(undefined, "en", {
      ...baseRow,
      value: null,
      valueText: "negative",
      unit: null,
    });
    expect(qualitative).toContain("@md:col-span-3");
    expect(qualitative).not.toMatch(/(?<![@\w-])sm:col-span/);
  });

  it("keeps every field of the row, however the columns fall", () => {
    const html = render(undefined);
    for (const id of ["-val", "-unit", "-date", "-lo", "-hi", "-refText"]) {
      expect(html, `field ${id}`).toContain(`${id}"`);
    }
  });
});

describe("<OcrRowEditor> range beside a text result", () => {
  const text: OcrReviewRow = {
    ...baseRow,
    value: null,
    valueText: "SEE NOTE",
    unit: null,
    referenceLow: 10,
    referenceHigh: 20,
    referenceText: "10 - 20",
  };

  it("offers the range for review when the row mints a new marker", () => {
    const html = render(undefined, "en", { ...text, biomarkerMatch: "new" });
    for (const id of ["-lo", "-hi", "-refText"]) {
      expect(html, `field ${id}`).toContain(`${id}"`);
    }
    expect(html).toContain("Reference range taken from the scan");
  });

  it("does not ask to verify a range a new text marker never had", () => {
    const html = render(undefined, "en", {
      ...text,
      biomarkerMatch: "new",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
    });
    expect(html).not.toContain("Verify the reference range");
  });

  it("leaves it out when the row goes to an existing marker", () => {
    const html = render(undefined, "en", text);
    for (const id of ["-lo", "-hi", "-refText"]) {
      expect(html, `field ${id}`).not.toContain(`${id}"`);
    }
  });
});

describe("<OcrRowEditor> unit differs from the marker's", () => {
  const mismatched: OcrReviewRow = {
    ...baseRow,
    takenAt: "2026-06-10",
    unit: "mg/dL",
    markerUnit: "mmol/L",
  };

  it("says so before any save attempt, in calm wording", () => {
    const html = render(undefined, "en", mismatched);
    expect(html).toContain("Tracked in mmol/L; this report says mg/dL");
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
  });

  it("marks the unit field and names the marker's unit once a save was refused", () => {
    const html = render({ unitMismatch: true }, "en", mismatched);
    const invalid = html.match(/<input[^>]*aria-invalid="true"[^>]*>/g) ?? [];
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatch(/id="[^"]*-unit"/);
    expect(html).toContain("This marker is tracked in mmol/L.");
  });

  it("shows nothing when the units agree, however they are spelled", () => {
    const html = render(undefined, "en", { ...mismatched, unit: "mmol/l" });
    expect(html).not.toContain("Tracked in");
  });

  it("shows nothing for a new marker, which adopts the row's unit", () => {
    const html = render(undefined, "en", { ...mismatched, markerUnit: null });
    expect(html).not.toContain("Tracked in");
  });

  it("speaks German too", () => {
    const html = render(undefined, "de", mismatched);
    expect(html).toContain("Geführt in mmol/L; dieser Befund nennt mg/dL");
  });
});

describe("<OcrRowEditor> unit differs but converts", () => {
  const converts: OcrReviewRow = {
    ...baseRow,
    analyte: "Glucose",
    value: 5.6,
    takenAt: "2026-06-10",
    unit: "mmol/L",
    markerUnit: "mg/dL",
    markerAnalyteKey: "fasting-glucose",
  };

  it("says what Save will store and what the report stated, not that it is blocked", () => {
    const html = render(undefined, "en", converts);
    expect(html).toContain('data-slot="ocr-row-converted-badge"');
    // The converted value keeps the precision of the printed 5.6.
    expect(html).toContain("Saved as 101 mg/dL, converted from 5.6 mmol/L");
    expect(html).not.toContain("Tracked in");
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("wraps the sentence instead of cutting off the printed value", () => {
    const html = render(undefined, "en", converts);
    const badge =
      /<span[^>]*data-slot="ocr-row-converted-badge"[^>]*>([\s\S]*?)<\/span><\/span>/.exec(
        html,
      );
    expect(badge).not.toBeNull();
    const tag = badge![0].slice(0, badge![0].indexOf(">"));
    expect(tag).toContain("whitespace-normal");
    expect(badge![0]).not.toContain("truncate");
  });

  it("speaks German too", () => {
    const html = render(undefined, "de", converts);
    expect(html).toContain("umgerechnet aus 5,6 mmol/L");
  });

  it("shows nothing when the units agree", () => {
    const html = render(undefined, "en", { ...converts, unit: "mg/dL" });
    expect(html).not.toContain("ocr-row-converted-badge");
  });

  it("still says it is blocked when the analyte is not known", () => {
    const html = render(undefined, "en", {
      ...converts,
      markerAnalyteKey: null,
    });
    expect(html).toContain("Tracked in mg/dL; this report says mmol/L");
    expect(html).not.toContain("ocr-row-converted-badge");
  });
});
