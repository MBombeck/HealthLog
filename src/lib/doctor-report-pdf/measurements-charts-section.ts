import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { convertGlucose, resolveGlucoseUnit } from "../glucose";
import { DOCTOR_REPORT_TYPE_LABEL_KEYS } from "../doctor-report/type-label-keys";
import {
  getBmiClassificationKey,
  getBpClassificationKey,
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
} as const;

const DEFAULT_GLUCOSE_RANGES = {
  FASTING: { min: 70, max: 99 },
  POSTPRANDIAL: { min: 70, max: 140 },
  RANDOM: { min: 70, max: 140 },
  BEDTIME: { min: 90, max: 150 },
} as const;

const GLUCOSE_CONTEXTS: Array<keyof typeof GLUCOSE_LABEL_KEYS> = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
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
    vitalTypes,
  } = context;
  let y = state.y;

  // Vitals heading — keep it with the start of its table.
  y = ensureSpace(y, 6 + 18);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(t("doctorReport.vitalsTitle"), margin, y);
  y += 6;

  const vitalRows: string[][] = [];

  for (const type of vitalTypes) {
    const s = data.stats[type];
    if (!s) continue;
    const unit = unitFor(type);
    // SLEEP_DURATION stats are per-night asleep totals in MINUTES (the data
    // layer reconstructs them for exactly this row); the vitals unit is hours
    // (`h`), so convert to keep value and unit consistent — the same hours
    // value the FHIR sleep Observation emits.
    const conv =
      type === "SLEEP_DURATION" ? (v: number) => v / 60 : (v: number) => v;
    vitalRows.push([
      t(DOCTOR_REPORT_TYPE_LABEL_KEYS[type] ?? ""),
      `${num(conv(s.latest))} ${unit}`.trim(),
      `${num(conv(s.avg))} ${unit}`.trim(),
      num(conv(s.min)),
      num(conv(s.max)),
      String(s.count),
    ]);
  }

  // Per-context glucose rows. Values stored canonically in mg/dL — convert to
  // the user's display unit. Reference ranges come from the server-side
  // `getEffectiveRange()` (already baked into `data.glucoseRanges`).
  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  for (const ctx of GLUCOSE_CONTEXTS) {
    const s = data.glucoseStats?.[ctx];
    if (!s) continue;
    const conv = (v: number) => convertGlucose(v, glucoseUnit);
    vitalRows.push([
      t(GLUCOSE_LABEL_KEYS[ctx]),
      `${num(conv(s.latest))} ${glucoseUnit}`.trim(),
      `${num(conv(s.avg))} ${glucoseUnit}`.trim(),
      num(conv(s.min)),
      num(conv(s.max)),
      String(s.count),
    ]);
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

  // v1.18.0 — clinical glucose panel (TIR / GMI / eA1C / mean / CV%). The
  // server already computes this (`data.glucoseClinical`) by the one
  // literature-locked engine the insights panel + coach consume, and zeroes it
  // when the glucose module is off (readingCount === 0). Render it whenever the
  // window carries glucose readings so the PDF surfaces the same numbers the
  // app shows. A `pct` helper turns the engine's 0–1 fractions into percent.
  const clinical = data.glucoseClinical;
  if (clinical && clinical.readingCount > 0 && clinical.distribution) {
    const pct = (fraction: number) => `${num(fraction * 100)} %`;
    const clinicalRows: string[][] = [];
    const dist = clinical.distribution;
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirInRange"),
      pct(dist.tir),
    ]);
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirLow"),
      pct(dist.tbrLevel1),
    ]);
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirVeryLow"),
      pct(dist.tbrLevel2),
    ]);
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirHigh"),
      pct(dist.tarLevel1),
    ]);
    clinicalRows.push([
      t("doctorReport.glucoseClinical.tirVeryHigh"),
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
    if (chartTypes.length > 0) {
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
        const label = t(DOCTOR_REPORT_TYPE_LABEL_KEYS[type] ?? "");
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
