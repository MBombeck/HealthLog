import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import {
  classifyReferenceRange,
  formatReferenceRange,
} from "../labs/reference-range";
import {
  pdfCursorState,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

export function buildClinicalRecordsNotesSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const {
    doc,
    data,
    t,
    num,
    fmtDate,
    aiSummary,
    margin,
    pageWidth,
    contentMaxY,
    tableBottomMargin,
    ensureSpace,
  } = context;
  let y = state.y;

  // v1.17.1 — structured lab-results section. Populated when the `labs`
  // toggle is ON (default) and the user recorded at least one result in the
  // window. One row per analyte (latest reading), with the lab's reference
  // range and a NEUTRAL in/out-of-range marker — informative, never an
  // alarming red. The marker is a quiet glyph (↓ / ↑ / —), not a colour, so
  // the clinical PDF stays calm.
  if (data.labResults && data.labResults.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.labsTitle"), margin, y);
    y += 6;

    const rangeText = (low: number | null, high: number | null): string =>
      formatReferenceRange(low, high, num, { emptyText: "—" });
    // Quiet, non-colour status glyph. In-range reads as a neutral dash so
    // the table is not a field of warning marks; out-of-range reads as a
    // direction arrow the clinician can scan, with no alarm tint.
    const statusGlyph = (
      value: number,
      low: number | null,
      high: number | null,
    ): string => {
      switch (classifyReferenceRange(value, low, high)) {
        case "unknown":
          return "";
        case "below":
          return "↓";
        case "above":
          return "↑";
        default:
          return "—";
      }
    };

    const labRows = data.labResults.map((lr) => {
      // v1.18.9 — a qualitative reading (`value === null`) prints its result
      // text in the value column and has no numeric range / status glyph.
      const isQualitative = lr.value === null;
      return [
        lr.panel ? `${lr.analyte} (${lr.panel})` : lr.analyte,
        isQualitative
          ? (lr.valueText ?? "")
          : `${num(lr.value as number)} ${lr.unit}`.trim(),
        isQualitative ? "—" : rangeText(lr.referenceLow, lr.referenceHigh),
        isQualitative
          ? ""
          : statusGlyph(lr.value as number, lr.referenceLow, lr.referenceHigh),
        fmtDate(lr.takenAt),
      ];
    });

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.labsColAnalyte"),
          t("doctorReport.labsColValue"),
          t("doctorReport.labsColReference"),
          t("doctorReport.labsColStatus"),
          t("doctorReport.labsColDate"),
        ],
      ],
      body: labRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.18.1 P4 — illness / condition episodes overlapping the window. Present
  // only when the illness module is on AND the window held an episode (the
  // aggregator gates `data.illnessEpisodes`). Labels + lifecycle + dates only;
  // the encrypted note is never read. A purely retrospective, factual table —
  // no colour, no severity tint — matching the clinical-document register.
  if (data.illnessEpisodes && data.illnessEpisodes.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.illnessTitle"), margin, y);
    y += 6;

    const illnessRows = data.illnessEpisodes.map((ep) => [
      ep.label,
      t(`illness.type.${ep.type}`),
      t(`illness.lifecycle.${ep.lifecycle}`),
      fmtDate(ep.onsetAt),
      ep.resolvedAt ? fmtDate(ep.resolvedAt) : t("doctorReport.illnessOngoing"),
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.illnessColCondition"),
          t("doctorReport.illnessColType"),
          t("doctorReport.illnessColLifecycle"),
          t("doctorReport.illnessColOnset"),
          t("doctorReport.illnessColResolved"),
        ],
      ],
      body: illnessRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.27.x — structured allergy / intolerance records. Reference data
  // (not time-windowed) the aggregator populates when the `allergies`
  // toggle is ON (default) and rows exist. Stored fields only — substance,
  // category, kind, severity, reaction, status — in the same calm factual
  // table register as the illness section; no colour, no severity tint.
  if (data.allergies && data.allergies.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.allergiesTitle"), margin, y);
    y += 6;

    const allergyRows = data.allergies.map((al) => [
      al.substance,
      t(`records.allergies.category.${al.category}`),
      t(`records.allergies.type.${al.type}`),
      al.severity ? t(`records.allergies.severity.${al.severity}`) : "—",
      // A reaction that WAS recorded but could not be decrypted renders an
      // honest marker, never a blank "—" that reads as "no reaction recorded".
      al.reactionUnreadable
        ? t("doctorReport.reactionUnreadable")
        : (al.reaction ?? "—"),
      t(`records.allergies.status.${al.status}`),
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.allergiesColSubstance"),
          t("doctorReport.allergiesColCategory"),
          t("doctorReport.allergiesColKind"),
          t("doctorReport.allergiesColSeverity"),
          t("doctorReport.allergiesColReaction"),
          t("doctorReport.allergiesColStatus"),
        ],
      ],
      body: allergyRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.27.x — structured family-history records. Reference data the
  // aggregator populates when the `familyHistory` toggle is ON (default)
  // and rows exist. Relationship + condition + age at onset only — the
  // free-text note never reaches this surface.
  if (data.familyHistory && data.familyHistory.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.familyHistoryTitle"), margin, y);
    y += 6;

    const familyRows = data.familyHistory.map((fh) => [
      t(`records.family.relationship.${fh.relationship}`),
      fh.condition,
      fh.ageAtOnset !== null ? String(fh.ageAtOnset) : "—",
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.familyHistoryColRelationship"),
          t("doctorReport.familyHistoryColCondition"),
          t("doctorReport.familyHistoryColAgeAtOnset"),
        ],
      ],
      body: familyRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.7.0 — optional AI summary. OUT of the clinical PDF by default;
  // rendered ONLY when the user explicitly opted in. Clearly labelled and
  // flagged as not clinically validated so a physician never mistakes it
  // for a machine-generated diagnosis.
  const aiText = typeof aiSummary === "string" ? aiSummary.trim() : "";
  if (aiText.length > 0) {
    // Keep the heading + the first disclaimer line together.
    y = ensureSpace(y, 5 + 4 + 4.5);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(120, 80, 0);
    doc.text(t("doctorReport.aiSummaryTitle"), margin, y);
    y += 5;
    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(150, 110, 40);
    const disclaimer = doc.splitTextToSize(
      t("doctorReport.aiSummaryDisclaimer"),
      pageWidth - 2 * margin,
    );
    for (const line of disclaimer) {
      if (y + 4 > contentMaxY) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += 4;
    }
    y += 2;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(60, 60, 60);
    const wrapped = doc.splitTextToSize(aiText, pageWidth - 2 * margin);
    for (const line of wrapped) {
      if (y + 4.5 > contentMaxY) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += 4.5;
    }
    y += 4;
  }

  return pdfCursorState(doc, y);
}
