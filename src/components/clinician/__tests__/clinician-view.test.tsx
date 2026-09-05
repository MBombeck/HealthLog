/**
 * v1.11.0 (Epic C, C5) — clinician-view presentation.
 *
 * Asserts the load-bearing rendering properties: the fenced wellness card
 * carries the descriptive "not a clinical assessment / not a diagnosis"
 * disclaimer, the provenance header renders, and the view holds no app chrome.
 */
import type React from "react";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ClinicianView } from "../clinician-view";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
import { ALL_LEAF_IDS } from "@/lib/report-selection/catalogue";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";

function makeReport(
  overrides: Partial<DoctorReportData> = {},
): DoctorReportData {
  return {
    period: {
      days: 30,
      since: "2026-01-01",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-31T00:00:00.000Z",
    },
    patient: {
      username: "tester",
      dateOfBirth: null,
      gender: null,
      heightCm: null,
    },
    practiceName: null,
    measurements: {},
    stats: {
      WEIGHT: { avg: 80, min: 78, max: 82, count: 12, latest: 79 },
    },
    glucoseStats: {},
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], {
      now: new Date("2026-01-31T00:00:00.000Z"),
    }),
    glucoseUnit: "mg/dL",
    bmi: 24.5,
    compliance: {},
    medications: [],
    wellnessScores: [
      {
        type: "RECOVERY_SCORE",
        latest: 72,
        avg: 68,
        min: 50,
        max: 90,
        count: 20,
        latestAt: "2026-01-30T00:00:00.000Z",
      },
    ],
    ...overrides,
  } as DoctorReportData;
}

function render(
  report: DoctorReportData,
  extra?: Partial<
    Pick<
      React.ComponentProps<typeof ClinicianView>,
      | "documents"
      | "token"
      | "locale"
      | "selection"
      | "timeFormat"
      | "dateFormat"
    >
  >,
) {
  const { t } = getServerTranslator("en");
  return renderToStaticMarkup(
    <ClinicianView
      t={(k, v) => t(k, v)}
      label="Cardiology clinic"
      expiresAt="2026-03-01T00:00:00.000Z"
      report={report}
      selection={selectionFromLeaves(ALL_LEAF_IDS)}
      timeFormat="AUTO"
      dateFormat="AUTO"
      {...extra}
    />,
  );
}

describe("<ClinicianView>", () => {
  it("renders selected anamnesis and allergy facts with the PDF vocabulary", () => {
    const html = render(
      makeReport({
        allergies: [
          {
            substance: "Penicillin",
            category: "MEDICATION",
            type: "ALLERGY",
            severity: "SEVERE",
            status: "ACTIVE",
            reaction: "Hives",
            reactionUnreadable: false,
          },
        ],
        anamnesis: {
          conditions: "Hypertension",
          conditionsUnreadable: false,
          smokingStatus: "FORMER",
          alcoholPattern: "OCCASIONAL",
          shiftSchedule: "ROTATING",
          unreadableFacts: [],
        },
      }),
    );
    expect(html).toContain("Health profile");
    expect(html).toContain("Hypertension");
    expect(html).toContain("Former smoker");
    expect(html).toContain("Occasional");
    expect(html).toContain("Rotating shifts");
    expect(html).toContain("Penicillin");
    expect(html).toContain("Hives");
  });

  it("labels absent anamnesis facts without inventing negative values", () => {
    const html = render(
      makeReport({
        anamnesis: {
          conditions: null,
          conditionsUnreadable: false,
          smokingStatus: null,
          alcoholPattern: null,
          shiftSchedule: null,
          unreadableFacts: [],
        },
      }),
    );
    expect(html).toContain("Health profile");
    expect(html.match(/Not recorded/g)).toHaveLength(4);
    expect(html).not.toContain("Never smoker");
    expect(html).not.toContain("No alcohol");
    expect(html).not.toContain("No shift work");
  });

  it("does not render anamnesis carried outside the frozen selection", () => {
    const html = render(
      makeReport({
        anamnesis: {
          conditions: "Must stay private",
          conditionsUnreadable: false,
          smokingStatus: "CURRENT",
          alcoholPattern: "MOST_DAYS",
          shiftSchedule: "FIXED_SHIFT",
          unreadableFacts: [],
        },
      }),
      { selection: selectionFromLeaves(["PULSE"]) },
    );
    expect(html).not.toContain("Health profile");
    expect(html).not.toContain("Must stay private");
    expect(html).not.toContain("Current smoker");
  });

  it("names both windows when a lab's report and the saved band disagree", () => {
    // Two windows that disagree about the same number, and a card showing one
    // of them is a partial answer. The PDF settles this with a footnote under
    // the table; inline, both fit on the line.
    const html = render(
      makeReport({
        labResults: [
          {
            panel: null,
            analyte: "Potassium",
            value: 5.2,
            valueText: null,
            unit: "mmol/L",
            referenceLow: 3.9,
            referenceHigh: 5.4,
            catalogReferenceLow: 3.5,
            catalogReferenceHigh: 5,
            sourceReferenceText: null,
            referenceOrigin: "source",
            referenceDivergesFromCatalog: true,
            takenAt: "2026-01-20T09:00:00.000Z",
            count: 1,
          },
        ],
      }),
    );
    expect(html).toContain("Potassium");
    expect(html).toContain("Reference 3.9–5.4");
    expect(html).toContain("saved range 3.5–5");
  });

  it("renders the fenced wellness card with the descriptive disclaimer", () => {
    const html = render(makeReport());
    expect(html).toContain("Wellness scores");
    expect(html).toContain("not a clinical assessment");
    expect(html).toContain("not a diagnosis");
    expect(html).toContain("Recovery score");
  });

  it("renders the provenance header treating values as patient-reported", () => {
    const html = render(makeReport());
    expect(html).toContain("Shared health record");
    expect(html).toContain("patient-reported");
    expect(html).toContain("Cardiology clinic");
  });

  it("renders clinical vitals from the scoped report", () => {
    const html = render(makeReport());
    // The measurement rows are grouped the way the selection panel groups
    // them, so the page reads in the same order as the PDF.
    expect(html).toContain("Body measurements");
    // The measurement-type enum renders as the SAME localised label the rest
    // of the app uses, not the raw enum string and not a second vocabulary.
    //
    // Asserted against element TEXT rather than against the whole markup: each
    // card now carries a `data-leaf` attribute naming the catalogue leaves it
    // speaks for, so the enum constant is legitimately in the document as
    // machine metadata. What must never happen is a reader seeing it.
    expect(html).toContain(">Weight<");
    expect(html).not.toContain(">WEIGHT<");
  });

  it("omits the wellness card when there are no scores", () => {
    const html = render(makeReport({ wellnessScores: [] }));
    expect(html).not.toContain("Wellness scores");
  });

  it("carries no app chrome (no nav / coach landmarks)", () => {
    const html = render(makeReport());
    expect(html).not.toContain('data-slot="sidebar"');
    expect(html).not.toContain("coach");
  });

  it("renders no document section when the frozen set is empty", () => {
    const html = render(makeReport(), { documents: [], token: "hls_abc" });
    expect(html).not.toContain("Documents</h2>");
  });

  it("renders Class A inline: image → <img>, PDF → <iframe>, both at the serve route", () => {
    const html = render(makeReport(), {
      token: "hls_tok",
      documents: [
        {
          id: "img-1",
          title: "Skin photo",
          kind: "IMAGING",
          documentDate: "2026-01-10",
          byteSize: 20480,
          mimeType: "image/jpeg",
          servingClass: "inline",
        },
        {
          id: "pdf-1",
          title: "Blood panel",
          kind: "LAB_RESULT",
          documentDate: "2026-01-12",
          byteSize: 51200,
          mimeType: "application/pdf",
          servingClass: "inline",
        },
      ],
    });
    // Section header present.
    expect(html).toContain("Documents");
    // Image → <img> pointed at the token-scoped serve route.
    expect(html).toContain('src="/c/hls_tok/d/img-1"');
    expect(html).toContain("<img");
    // PDF → <iframe> pointed at the same route family.
    expect(html).toContain('src="/c/hls_tok/d/pdf-1"');
    expect(html).toContain("<iframe");
    // Titles render as escaped text.
    expect(html).toContain("Skin photo");
    expect(html).toContain("Blood panel");
  });

  it("renders Class B as a download link with no inline preview frame", () => {
    const html = render(makeReport(), {
      token: "hls_tok",
      documents: [
        {
          id: "doc-b",
          title: "Referral letter",
          kind: "REFERRAL",
          documentDate: null,
          byteSize: 8192,
          mimeType: "application/msword",
          servingClass: "attachment",
        },
      ],
    });
    // A download anchor at the serve route.
    expect(html).toContain('href="/c/hls_tok/d/doc-b"');
    expect(html).toContain("Download");
    // No inline preview for an attachment-class document.
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain('<img src="/c/hls_tok/d/doc-b"');
    expect(html).toContain("Referral letter");
  });
});

/**
 * Issue #922 — a share link shows the OWNER's record, so it is spelled the
 * owner's way. The page passed neither the owner's hour cycle nor their date
 * order, while the PDF one route over already read the hour cycle off the
 * owner row — so the same record could carry two different spellings
 * depending on which button the practice pressed.
 */
describe("<ClinicianView> renders in the owner's date order", () => {
  // 2026-03-01: day, month and year are mutually distinguishable, so the
  // assertion reads the ORDER rather than a coincidence of equal fields.
  const CASES = [
    { dateFormat: "DMY" as const, expected: "01.03.2026" },
    { dateFormat: "MDY" as const, expected: "03/01/2026" },
    { dateFormat: "YMD" as const, expected: "2026-03-01" },
  ];

  for (const { dateFormat, expected } of CASES) {
    it(`spells the expiry ${expected} under ${dateFormat}`, () => {
      const { t } = getServerTranslator("en");
      const html = renderToStaticMarkup(
        <ClinicianView
          t={(k, v) => t(k, v)}
          label="Cardiology clinic"
          expiresAt="2026-03-01T12:00:00.000Z"
          report={makeReport()}
          selection={selectionFromLeaves(ALL_LEAF_IDS)}
          timezone="UTC"
          timeFormat="AUTO"
          dateFormat={dateFormat}
        />,
      );
      expect(html).toContain(expected);
    });
  }

  it("follows the viewer locale under AUTO", () => {
    const { t } = getServerTranslator("en");
    const html = renderToStaticMarkup(
      <ClinicianView
        t={(k, v) => t(k, v)}
        label="Cardiology clinic"
        expiresAt="2026-03-01T12:00:00.000Z"
        report={makeReport()}
        selection={selectionFromLeaves(ALL_LEAF_IDS)}
        timezone="UTC"
        timeFormat="AUTO"
        dateFormat="AUTO"
      />,
    );
    expect(html).toContain("03/01/2026");
  });
});
