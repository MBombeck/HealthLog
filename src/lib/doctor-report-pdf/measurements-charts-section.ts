import type { jsPDF } from "jspdf";
import { GLUCOSE_CONTEXT_BUCKETS } from "@/lib/glucose";
import autoTable from "jspdf-autotable";
import {
  convertGlucose,
  glucoseBandParams,
  resolveGlucoseUnit,
} from "../glucose";
import {
  reportStatFractionDigits,
  reportStatValue,
} from "../doctor-report/stat-display";
import type { MeasurementType } from "@/generated/prisma/client";
import { reportMeasurementLabelKey } from "../report-selection/catalogue";
import {
  getBmiClassificationKey,
  getBpClassificationKey,
  COMPACT_SPARKLINE_TYPES,
  SPARKLINE_TYPES,
} from "./clinical-summary";
import {
  pdfCursorState,
  type DoctorReportNumberFormatter,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

const GLUCOSE_LABEL_KEYS = {
  FASTING: "doctorReport.typeGlucoseFasting",
  POSTPRANDIAL: "doctorReport.typeGlucosePostprandial",
  RANDOM: "doctorReport.typeGlucoseRandom",
  BEDTIME: "doctorReport.typeGlucoseBedtime",
  // #943 — readings the source never tagged with a meal time.
  UNSPECIFIED: "doctorReport.typeGlucoseUnspecified",
} as const;

const DEFAULT_GLUCOSE_RANGES = {
  FASTING: { min: 70, max: 99 },
  POSTPRANDIAL: { min: 70, max: 140 },
  RANDOM: { min: 70, max: 140 },
  BEDTIME: { min: 90, max: 150 },
  // Same band as RANDOM: an untagged reading is a spot reading.
  UNSPECIFIED: { min: 70, max: 140 },
} as const;

const GLUCOSE_CONTEXTS: Array<keyof typeof GLUCOSE_LABEL_KEYS> = [
  ...GLUCOSE_CONTEXT_BUCKETS,
];

/** A single charted reading. */
type SparklinePoint = { value: number; measuredAt: string };

/** Label band (5 mm) + plot (16 mm) + axis-date line (4.5 mm) + trailing gap. */
const SPARKLINE_HEIGHT = 5 + 16 + 4.5 + 2;

/**
 * Draw a jsPDF-native trend sparkline (label + min/max ticks + polyline +
 * a time axis). Returns the new `y` cursor below the drawn chart. Vector-only
 * — uses `doc.lines()`, no raster image, no native canvas module.
 *
 * Each point carries its `measuredAt` so the x-axis is anchored in real time:
 * points are positioned by their timestamp across the report window, and the
 * first/last dates are printed under the baseline. Without the axis a reader
 * cannot tell whether the trend spans a week or a year.
 */
function drawSparkline(
  doc: jsPDF,
  opts: {
    x: number;
    y: number;
    width: number;
    label: string;
    points: SparklinePoint[];
    num: DoctorReportNumberFormatter;
    unit: string;
    dateShort: (iso: string) => string;
  },
): number {
  const { x, y, width, label, points, num, unit, dateShort } = opts;
  const chartHeight = 16;
  const labelHeight = 5;
  const axisLabelHeight = 4.5;

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(label, x, y + labelHeight - 1.5);

  // Loop, not `Math.min(...values)` — chart points can be sample-grain on
  // dense accounts and a spread call overflows the stack (v1.28.22 class).
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }
  const range = max - min || 1;

  const chartTop = y + labelHeight;
  const chartBottom = chartTop + chartHeight;
  // Reserve a right gutter for the min/max value labels.
  const gutter = 22;
  const chartWidth = width - gutter;

  // Baseline box.
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.2);
  doc.line(x, chartBottom, x + chartWidth, chartBottom);

  // X position is anchored in time: map each reading's timestamp across the
  // [first, last] span. When every timestamp collapses to one instant fall
  // back to even spacing so a same-day cluster still plots.
  const times = points.map((p) => new Date(p.measuredAt).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tSpan = tMax - tMin;
  const plotted = points.map((p, i) => {
    const frac =
      tSpan > 0
        ? (times[i] - tMin) / tSpan
        : points.length > 1
          ? i / (points.length - 1)
          : 0;
    return {
      px: x + frac * chartWidth,
      py: chartBottom - ((p.value - min) / range) * chartHeight,
    };
  });
  doc.setDrawColor(80, 110, 200);
  doc.setLineWidth(0.4);
  const deltas: [number, number][] = [];
  for (let i = 1; i < plotted.length; i++) {
    deltas.push([
      plotted[i].px - plotted[i - 1].px,
      plotted[i].py - plotted[i - 1].py,
    ]);
  }
  if (deltas.length > 0) {
    doc.lines(deltas, plotted[0].px, plotted[0].py);
  }

  // Min/max labels in the right gutter.
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  const unitSuffix = unit ? ` ${unit}` : "";
  doc.text(`${num(max, 1)}${unitSuffix}`, x + chartWidth + 2, chartTop + 2);
  doc.text(`${num(min, 1)}${unitSuffix}`, x + chartWidth + 2, chartBottom);

  // Time axis: first date left-aligned, last date right-aligned under the
  // baseline so the trend's span is unambiguous.
  const axisY = chartBottom + axisLabelHeight - 1;
  const startLabel = dateShort(points[0]!.measuredAt);
  const endLabel = dateShort(points[points.length - 1]!.measuredAt);
  doc.text(startLabel, x, axisY);
  if (endLabel !== startLabel) {
    doc.text(endLabel, x + chartWidth, axisY, { align: "right" });
  }

  return chartBottom + axisLabelHeight + 2;
}

/** A body row: either six cells, or a full-width group sub-heading. */
type VitalTableRow =
  | string[]
  | [{ content: string; colSpan: number; styles: Record<string, unknown> }];

/**
 * A full-width sub-heading row naming the group the rows under it belong to.
 * Bold on a light fill, no colour beyond the table's own greys — the heading
 * carries meaning, not decoration.
 */
function groupSubHeadRow(label: string): VitalTableRow {
  return [
    {
      content: label,
      colSpan: 6,
      styles: {
        fontStyle: "bold",
        fillColor: [242, 242, 242],
        textColor: [30, 30, 30],
      },
    },
  ];
}

/**
 * Per-context glucose rows. Values are stored canonically in mg/dL and print
 * in the owner's unit, in the precision their readings carry.
 */
function glucoseContextTableRows(
  context: DoctorReportPdfRenderContext,
  glucoseUnit: ReturnType<typeof resolveGlucoseUnit>,
): string[][] {
  const { data, t, num } = context;
  const rows: string[][] = [];
  for (const ctx of GLUCOSE_CONTEXTS) {
    const s = data.glucoseStats?.[ctx];
    if (!s) continue;
    const digits = reportStatFractionDigits("BLOOD_GLUCOSE", s, glucoseUnit);
    const show = (v: number) => num(convertGlucose(v, glucoseUnit), digits);
    rows.push([
      t(GLUCOSE_LABEL_KEYS[ctx]),
      `${show(s.latest)} ${glucoseUnit}`.trim(),
      `${show(s.avg)} ${glucoseUnit}`.trim(),
      show(s.min),
      show(s.max),
      String(s.count),
    ]);
  }
  return rows;
}

/**
 * A row's label. A screener total answered in a translation that has not
 * been validated carries a mark, which the line under the table explains.
 */
function vitalRowLabel(
  context: DoctorReportPdfRenderContext,
  type: string,
): string {
  const label = context.t(reportMeasurementLabelKey(type as MeasurementType));
  return context.data.screenerUnvalidatedTranslations?.[type]
    ? `${label} *`
    : label;
}

/** One line under the table per marked screener: how many, of how many. */
function drawScreenerTranslationNotes(
  context: DoctorReportPdfRenderContext,
  startY: number,
): number {
  const { doc, data, t, margin, pageWidth, ensureSpace } = context;
  const notes = Object.entries(data.screenerUnvalidatedTranslations ?? {})
    .filter(([type, count]) => count > 0 && data.stats[type])
    .map(([type, count]) =>
      t("doctorReport.screenerUnvalidated", {
        label: t(reportMeasurementLabelKey(type as MeasurementType)),
        count,
        total: data.stats[type].count,
      }),
    );
  if (notes.length === 0) return startY;
  let y = startY;
  doc.setFontSize(8);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(110, 110, 110);
  for (const note of notes) {
    for (const line of doc.splitTextToSize(
      `* ${note}`,
      pageWidth - 2 * margin,
    )) {
      y = ensureSpace(y, 4);
      doc.text(line, margin, y);
      y += 4;
    }
  }
  return y + 4;
}

export function buildMeasurementsChartsSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const {
    doc,
    data,
    t,
    num,
    dateShort,
    includeCharts,
    margin,
    pageWidth,
    contentMaxY,
    tableBottomMargin,
    ensureSpace,
    unitFor,
    vitalGroups,
  } = context;
  let y = state.y;

  // Vitals heading — keep it with the start of its table.
  y = ensureSpace(y, 6 + 18);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(t("doctorReport.vitalsTitle"), margin, y);
  y += 6;

  // One sub-headed block per selection group, in the same order the panel
  // shows them, carrying every selected leaf that has data. The aggregator has
  // already applied the selection, so a leaf missing from `data.stats` is a
  // leaf that was withheld or has no reading — the table cannot over-serve.
  const vitalRows: VitalTableRow[] = [];

  // Per-context glucose rows, in the owner's unit, under the glucose heading.
  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  const glucoseContextRows = glucoseContextTableRows(context, glucoseUnit);

  for (const group of vitalGroups) {
    const groupRows: string[][] = [];
    for (const type of group.types) {
      const s = data.stats[type];
      if (!s) continue;
      const unit = unitFor(type);
      // Sleep minutes print as hours and glucose in the owner's unit; the
      // clinician view reads the same helper, so the two cannot drift.
      // One precision per row, the one the readings carry (see
      // `reportStatFractionDigits`); the share page prints the same.
      const digits = reportStatFractionDigits(type, s, glucoseUnit);
      const show = (v: number) =>
        num(reportStatValue(type, v, glucoseUnit), digits);
      groupRows.push([
        vitalRowLabel(context, type),
        `${show(s.latest)} ${unit}`.trim(),
        `${show(s.avg)} ${unit}`.trim(),
        show(s.min),
        show(s.max),
        String(s.count),
      ]);
    }
    if (group.id === "glucose") groupRows.push(...glucoseContextRows);
    if (groupRows.length === 0) continue;
    vitalRows.push(groupSubHeadRow(t(group.labelKey)));
    vitalRows.push(...groupRows);
  }

  if (vitalRows.length > 0) {
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
      body: vitalRows,
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

  y = drawScreenerTranslationNotes(context, y);

  // v1.18.0 — clinical glucose panel (TIR / GMI / eA1C / mean / CV%). The
  // server already computes this (`data.glucoseClinical`) by the one
  // literature-locked engine the insights panel + coach consume, and zeroes it
  // when the glucose module is off (readingCount === 0). Render it whenever the
  // window carries glucose readings so the PDF surfaces the same numbers the
  // app shows. A `pct` helper turns the engine's 0–1 fractions into percent.
  const clinical = data.glucoseClinical;
  if (clinical && clinical.readingCount > 0 && clinical.distribution) {
    const pct = (fraction: number) => `${num(fraction * 100)} %`;
    // The band edges follow the reader's glucose unit, like every value in
    // the table beside them.
    const bands = glucoseBandParams(glucoseUnit, num);
    const clinicalRows: string[][] = [];
    const dist = clinical.distribution;
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirInRange", bands),
      pct(dist.tir),
    ]);
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirLow", bands),
      pct(dist.tbrLevel1),
    ]);
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirVeryLow", bands),
      pct(dist.tbrLevel2),
    ]);
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirHigh", bands),
      pct(dist.tarLevel1),
    ]);
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirVeryHigh", bands),
      pct(dist.tarLevel2),
    ]);
    if (clinical.meanMgdl !== null) {
      clinicalRows.push([
        t("doctorReport.glucoseClinical.mean"),
        `${num(convertGlucose(clinical.meanMgdl, glucoseUnit))} ${glucoseUnit}`.trim(),
      ]);
    }
    if (clinical.gmi !== null) {
      clinicalRows.push([
        t("doctorReport.glucoseClinical.gmi"),
        `${num(clinical.gmi)} %`,
      ]);
    }
    if (clinical.estimatedA1c !== null) {
      clinicalRows.push([
        t("doctorReport.glucoseClinical.eA1c"),
        `${num(clinical.estimatedA1c)} %`,
      ]);
    }
    if (clinical.variability !== null) {
      clinicalRows.push([
        t("doctorReport.glucoseClinical.cv"),
        `${num(clinical.variability.cv)} %`,
      ]);
    }

    // Keep the heading with the start of its table.
    y = ensureSpace(y, 6 + 14);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.glucoseClinical.title"), margin, y);
    y += 6;

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.glucoseClinical.colMetric"),
          t("doctorReport.glucoseClinical.colValue"),
        ],
      ],
      body: clinicalRows,
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
        .finalY + 4;

    // Spot-reading caveat when the engine flags the readings as sparse, so the
    // clinician reads the panel as a direction-of-travel, not a CGM AGP.
    if (clinical.isSpotEstimate) {
      doc.setFontSize(8);
      doc.setFont("helvetica", "italic");
      doc.setTextColor(110, 110, 110);
      const caveat = doc.splitTextToSize(
        t("doctorReport.glucoseClinical.spotCaveat"),
        pageWidth - 2 * margin,
      );
      for (const line of caveat) {
        y = ensureSpace(y, 4);
        doc.text(line, margin, y);
        y += 4;
      }
    }
    y += 4;
  }

  // v1.7.0 — jsPDF-native trend sparklines per primary vital. Vector
  // polylines drawn with `doc.lines()` — zero new dependency, no native
  // canvas module, isomorphic. Selection-gated via `includeCharts`.
  if (includeCharts) {
    const chartTypes = SPARKLINE_TYPES.filter(
      (type) => (data.measurements[type]?.length ?? 0) >= 2,
    );
    // v1.44 — the wearable series (sleep, both HRV statistics, steps) draw at
    // half width, two to a row: a clinician reads their direction, and four
    // full-width charts would push the medication blocks a page further.
    const compactTypes = COMPACT_SPARKLINE_TYPES.filter(
      (type) => (data.measurements[type]?.length ?? 0) >= 2,
    );
    if (chartTypes.length > 0 || compactTypes.length > 0) {
      // Keep the heading with at least the first chart.
      y = ensureSpace(y, 6 + SPARKLINE_HEIGHT + 4);
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 30, 30);
      doc.text(t("doctorReport.chartsTitle"), margin, y);
      y += 6;
      for (const type of chartTypes) {
        const series = data.measurements[type] ?? [];
        // A chart never tears across a page boundary — break before drawing
        // it whole.
        y = ensureSpace(y, SPARKLINE_HEIGHT + 4);
        const label = t(reportMeasurementLabelKey(type as MeasurementType));
        y = drawSparkline(doc, {
          x: margin,
          y,
          width: pageWidth - 2 * margin,
          label,
          points: series,
          num,
          unit: unitFor(type),
          dateShort: (iso) => dateShort(iso),
        });
        y += 4;
      }
      const columnGap = 6;
      const halfWidth = (pageWidth - 2 * margin - columnGap) / 2;
      for (let i = 0; i < compactTypes.length; i += 2) {
        y = ensureSpace(y, SPARKLINE_HEIGHT + 4);
        let rowBottom = y;
        for (const [column, type] of compactTypes.slice(i, i + 2).entries()) {
          // Plotted in the unit the table prints (sleep in hours, not the
          // stored minutes), so the min/max labels match the row above.
          const points = (data.measurements[type] ?? []).map((p) => ({
            measuredAt: p.measuredAt,
            value: reportStatValue(type, p.value, glucoseUnit),
          }));
          const bottom = drawSparkline(doc, {
            x: margin + column * (halfWidth + columnGap),
            y,
            width: halfWidth,
            label: t(reportMeasurementLabelKey(type)),
            points,
            num,
            unit: unitFor(type),
            dateShort: (iso) => dateShort(iso),
          });
          rowBottom = Math.max(rowBottom, bottom);
        }
        y = rowBottom + 4;
      }
      y += 2;
    }
  }

  const sysStat = data.stats.BLOOD_PRESSURE_SYS;
  const diaStat = data.stats.BLOOD_PRESSURE_DIA;
  if (sysStat && diaStat) {
    y = ensureSpace(y, 5 + 8);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.bpClassificationTitle"), margin, y);
    y += 5;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const bpClass = t(getBpClassificationKey(sysStat.avg, diaStat.avg));
    doc.text(
      `${t("doctorReport.avgBp")}: ${num(sysStat.avg, 0)}/${num(diaStat.avg, 0)} mmHg — ${t("doctorReport.classification")}: ${bpClass}`,
      margin,
      y,
    );
    y += 8;
  }

  if (data.bmi) {
    y = ensureSpace(y, 5 + 8);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.bmiTitle"), margin, y);
    y += 5;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(
      t("doctorReport.bmiRow", {
        bmi: num(data.bmi, 1),
        class: t(getBmiClassificationKey(data.bmi)),
      }),
      margin,
      y,
    );
    y += 8;
  }

  // Glucose classification — one line per logged context.
  const loggedGlucose = GLUCOSE_CONTEXTS.filter(
    (ctx) => data.glucoseStats?.[ctx],
  );
  if (loggedGlucose.length > 0) {
    y = ensureSpace(y, 5 + 5 + 3);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.glucoseClassificationTitle"), margin, y);
    y += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    for (const ctx of loggedGlucose) {
      const s = data.glucoseStats[ctx];
      if (!s) continue;
      const range = data.glucoseRanges?.[ctx] ?? DEFAULT_GLUCOSE_RANGES[ctx];
      const conv = (v: number) => convertGlucose(v, glucoseUnit);
      const inRange = s.avg >= range.min && s.avg <= range.max;
      const classKey = inRange
        ? "doctorReport.glucoseInTarget"
        : s.avg < range.min
          ? "doctorReport.glucoseBelowTarget"
          : "doctorReport.glucoseAboveTarget";
      if (y + 5 > contentMaxY) {
        doc.addPage();
        y = margin;
      }
      doc.text(
        t("doctorReport.glucoseRow", {
          label: t(GLUCOSE_LABEL_KEYS[ctx]),
          avg: num(conv(s.avg), 1),
          unit: glucoseUnit,
          rangeMin: num(conv(range.min)),
          rangeMax: num(conv(range.max)),
          class: t(classKey),
        }),
        margin,
        y,
      );
      y += 5;
    }
    y += 3;
  }

  return pdfCursorState(doc, y);
}
