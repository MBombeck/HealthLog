import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { adherenceRatePercent } from "../doctor-report-data";
import {
  pdfCursorState,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

const MOOD_LABEL_KEYS: Record<number, string> = {
  1: "doctorReport.moodAwful",
  2: "doctorReport.moodBad",
  3: "doctorReport.moodNeutral",
  4: "doctorReport.moodGood",
  5: "doctorReport.moodGreat",
};

/** v1.10.0 — display-label key per persisted wellness-score type. */
const WELLNESS_SCORE_LABEL_KEYS: Record<string, string> = {
  RECOVERY_SCORE: "doctorReport.wellnessRecovery",
  STRESS_SCORE: "doctorReport.wellnessStress",
  STRAIN_SCORE: "doctorReport.wellnessStrain",
};

/**
 * Rough autoTable height estimate (mm) used by the page-break guards so a
 * heading + its table do not orphan. The grid theme at fontSize 9 +
 * cellPadding 3 renders header + each body row at ~9 mm. Deliberately a
 * conservative over-estimate — a slightly early break is harmless, a missed
 * one tears the module.
 */
function estimateTableHeight(rowCount: number): number {
  const HEADER_MM = 9;
  const ROW_MM = 9;
  return HEADER_MM + rowCount * ROW_MM;
}

export function buildMedicationMoodWellnessSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const {
    doc,
    data,
    t,
    num,
    fmtDate,
    margin,
    pageWidth,
    tableBottomMargin,
    ensureSpace,
  } = context;
  let y = state.y;

  const complianceEntries = Object.entries(data.compliance);
  if (complianceEntries.length > 0) {
    // Keep the heading with the table header + first row (~6 mm heading +
    // ~9 mm header + ~9 mm row).
    y = ensureSpace(
      y,
      6 + estimateTableHeight(Math.min(complianceEntries.length, 1)),
    );

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.complianceTitle"), margin, y);
    y += 6;

    const compRows = complianceEntries.map(([name, c]) => {
      // v1.17 W1a — `total` is the ledger rate denominator (taken + missed,
      // deliberate skips excluded), so `taken / total` matches the app's
      // detail-page adherence %. The column is labelled "Expected" rather
      // than "Total" so the row stays internally coherent: Taken + Missed =
      // Expected, with Skipped shown alongside as informational.
      // Integer percent via the canonical rounding — matches the in-app card.
      const ratePct = adherenceRatePercent(c.taken, c.total);
      const rate = ratePct !== null ? `${num(ratePct, 0)}%` : "—";
      return [
        name,
        String(c.taken),
        String(c.skipped),
        String(c.missed),
        String(c.total),
        rate,
      ];
    });

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.colMedication"),
          t("doctorReport.colTaken"),
          t("doctorReport.colSkipped"),
          t("doctorReport.colMissed"),
          t("doctorReport.colExpected"),
          t("doctorReport.colComplianceRate"),
        ],
      ],
      body: compRows,
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

  // v1.4.25 W4d — GLP-1 therapy section. Only renders when the data
  // aggregator emitted a non-null `glp1` block (user has at least one
  // active GLP-1 medication and the compliance toggle is on). Lists
  // current drug + dose, full titration history, weight curve over
  // the report window, side-effect frequency, and compliance %.
  if (data.glp1) {
    // Keep the GLP-1 heading with its first content line.
    y = ensureSpace(y, 6 + 6 + 5);

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.glp1Title"), margin, y);
    y += 6;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    if (
      data.glp1.weightDeltaKg !== null &&
      data.glp1.weightStartKg !== null &&
      data.glp1.weightEndKg !== null
    ) {
      doc.text(
        t("doctorReport.glp1WeightSummary", {
          start: num(data.glp1.weightStartKg, 1),
          end: num(data.glp1.weightEndKg, 1),
          delta: num(data.glp1.weightDeltaKg, 1),
        }),
        margin,
        y,
      );
      y += 6;
    }

    for (const med of data.glp1.medications) {
      // Keep the med name with at least its first detail line.
      y = ensureSpace(y, 5 + 5);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(med.name, margin, y);
      y += 5;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      if (med.currentDose) {
        doc.text(
          t("doctorReport.glp1CurrentDose", {
            value: num(med.currentDose.value, 2),
            unit: med.currentDose.unit,
            since: fmtDate(med.currentDose.since),
          }),
          margin,
          y,
        );
        y += 5;
      }
      const glp1Rate = adherenceRatePercent(
        med.compliance.taken,
        med.compliance.total,
      );
      if (glp1Rate !== null) {
        doc.text(
          t("doctorReport.glp1Compliance", {
            taken: med.compliance.taken,
            total: med.compliance.total,
            rate: num(glp1Rate, 0),
          }),
          margin,
          y,
        );
        y += 5;
      }
      if (med.doseHistory.length > 0) {
        const historyRows = med.doseHistory.map((dc) => [
          fmtDate(dc.effectiveFrom),
          `${num(dc.value, 2)} ${dc.unit}`,
          dc.note ?? "",
        ]);
        // A titration history reads as one block — break before it if the
        // whole table would not fit, and tell autoTable not to split a row.
        y = ensureSpace(y, estimateTableHeight(historyRows.length));
        autoTable(doc, {
          startY: y,
          head: [
            [
              t("doctorReport.colGlp1Date"),
              t("doctorReport.colGlp1Dose"),
              t("doctorReport.colGlp1Note"),
            ],
          ],
          body: historyRows,
          theme: "grid",
          rowPageBreak: "avoid",
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
            .finalY + 6;
      }
    }

    if (data.glp1.sideEffects.length > 0) {
      const seRows = data.glp1.sideEffects.map((s) => [s.tag, String(s.count)]);
      // Keep the heading with the table; the side-effect tally reads as one
      // block.
      y = ensureSpace(y, 5 + estimateTableHeight(seRows.length));
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(t("doctorReport.glp1SideEffectsTitle"), margin, y);
      y += 5;
      autoTable(doc, {
        startY: y,
        head: [
          [t("doctorReport.colGlp1SideEffect"), t("doctorReport.colCount")],
        ],
        body: seRows,
        theme: "grid",
        rowPageBreak: "avoid",
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
  }

  if (data.mood) {
    const moodRowCount = Object.keys(data.mood.distribution).length;
    // Keep the heading + summary line with the start of the distribution
    // table.
    y = ensureSpace(y, 6 + 6 + estimateTableHeight(Math.min(moodRowCount, 1)));

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.moodTitle"), margin, y);
    y += 6;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(
      t("doctorReport.moodSummary", {
        avg: num(data.mood.avg, 1),
        count: data.mood.count,
        min: num(data.mood.min, 0),
        max: num(data.mood.max, 0),
      }),
      margin,
      y,
    );
    y += 6;

    const distRows = Object.entries(data.mood.distribution).map(
      ([score, count]) => [
        t(MOOD_LABEL_KEYS[Number(score)] ?? "doctorReport.moodNeutral"),
        String(count),
        data.mood && data.mood.count > 0
          ? `${num((count / data.mood.count) * 100, 1)}%`
          : "0%",
      ],
    );

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.colMood"),
          t("doctorReport.colCount"),
          t("doctorReport.colShare"),
        ],
      ],
      body: distRows,
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

  // v1.10.0 — wellness summary. The server-derived nightly scores
  // (recovery / stress / strain) are 0–100 DESCRIPTIVE composites, NOT
  // clinical vitals — they render in their own clearly-labelled section,
  // separate from the vitals table, with a "descriptive, not a clinical
  // assessment" disclaimer so a physician never mistakes a band for a
  // finding. Skipped entirely when the aggregator emitted no scores.
  if (data.wellnessScores && data.wellnessScores.length > 0) {
    const scoreRows = data.wellnessScores.map((s) => [
      t(WELLNESS_SCORE_LABEL_KEYS[s.type] ?? "doctorReport.wellnessTitle"),
      String(s.latest),
      String(s.avg),
      String(s.min),
      String(s.max),
      String(s.count),
    ]);

    // Keep the heading + disclaimer with the first table row.
    y = ensureSpace(y, 6 + 6 + 6 + estimateTableHeight(1));

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.wellnessTitle"), margin, y);
    y += 6;

    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");
    const wellnessDisclaimer = doc.splitTextToSize(
      t("doctorReport.wellnessDisclaimer"),
      pageWidth - margin * 2,
    );
    for (const line of wellnessDisclaimer) {
      doc.text(line, margin, y);
      y += 4;
    }
    y += 2;
    doc.setFont("helvetica", "normal");

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.colParameter"),
          t("doctorReport.colCurrent"),
          t("doctorReport.colAvgPeriod"),
          t("doctorReport.colMin"),
          t("doctorReport.colMax"),
          t("doctorReport.colN"),
        ],
      ],
      body: scoreRows,
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

  // v1.15.0 — cycle / reproductive-health section. Privacy default OFF: the
  // aggregator only populates `data.cycle` when the cycle section toggle is
  // explicitly ON AND the user has an observed cycle. Statistics only (no
  // free-text notes). Skipped entirely otherwise.
  if (data.cycle) {
    const cyc = data.cycle;
    y = ensureSpace(y, 6 + 6 + estimateTableHeight(1));

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.cycleTitle"), margin, y);
    y += 6;

    // Summary line: LMP, avg length ± variability, avg period, phase.
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const summaryBits: string[] = [];
    if (cyc.lastPeriodStart) {
      summaryBits.push(
        `${t("doctorReport.cycleLmp")}: ${fmtDate(`${cyc.lastPeriodStart}T12:00:00.000Z`)}`,
      );
    }
    if (cyc.averageCycleLengthDays !== null) {
      const varSuffix =
        cyc.cycleLengthVariabilityDays !== null
          ? ` (± ${num(cyc.cycleLengthVariabilityDays, 1)})`
          : "";
      summaryBits.push(
        `${t("doctorReport.cycleAvgLength")}: ${num(cyc.averageCycleLengthDays, 1)} ${t("doctorReport.cycleDays")}${varSuffix}`,
      );
    }
    if (cyc.averagePeriodLengthDays !== null) {
      summaryBits.push(
        `${t("doctorReport.cycleAvgPeriod")}: ${num(cyc.averagePeriodLengthDays, 1)} ${t("doctorReport.cycleDays")}`,
      );
    }
    if (cyc.currentPhase) {
      summaryBits.push(
        `${t("doctorReport.cyclePhase")}: ${t(`doctorReport.cyclePhases.${cyc.currentPhase}`)}`,
      );
    }
    for (const line of doc.splitTextToSize(
      summaryBits.join("  •  "),
      pageWidth - margin * 2,
    )) {
      doc.text(line, margin, y);
      y += 4.5;
    }
    y += 2;

    if (cyc.recentCycles.length > 0) {
      const cycleRows = cyc.recentCycles.map((c) => [
        fmtDate(`${c.startDate}T12:00:00.000Z`),
        c.lengthDays !== null ? String(c.lengthDays) : "—",
        c.periodLengthDays !== null ? String(c.periodLengthDays) : "—",
      ]);
      autoTable(doc, {
        startY: y,
        head: [
          [
            t("doctorReport.cycleColStart"),
            t("doctorReport.cycleColLength"),
            t("doctorReport.cycleColPeriod"),
          ],
        ],
        body: cycleRows,
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
  }

  return pdfCursorState(doc, y);
}
