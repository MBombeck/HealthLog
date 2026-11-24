/**
 * The seizure-diary section of the doctor-report PDF (#1368).
 *
 * Renders `data.seizureDiary` in the order the clinical brief lays out: the
 * summary, the type × month table, a monthly stacked-bar chart with the
 * scheduled medications' starts, stops and dose changes as numbered markers,
 * the duration and rescue tables, suspected triggers, the overlays the record
 * backs, and the event appendix. Plain calm type, no colour coding of
 * severity, and nothing that reads as a verdict: the footer says what a diary
 * is (a record of what was seen, likely an undercount).
 *
 * Every figure arrives server-derived; the renderer only lays it out.
 */
import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import { ilae2017LabelKey, ilaeLabelKey } from "@/lib/seizures/ilae";
import type {
  SeizureReportSection,
  SeizureReportType,
} from "@/lib/seizures/report-types";

import { PDF_FONT_FAMILY } from "./fonts";
import {
  pdfCursorState,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

/** Rows in the event appendix before it is cut. */
export const SEIZURE_REPORT_EVENT_CAP = 200;

/** Greys for the stacked bars, one per type; no colour carries meaning. */
const BAR_SHADES: ReadonlyArray<[number, number, number]> = [
  [70, 70, 70],
  [130, 130, 130],
  [180, 180, 180],
  [100, 100, 100],
  [155, 155, 155],
  [205, 205, 205],
];

const TABLE_STYLES = {
  theme: "grid" as const,
  styles: {
    font: PDF_FONT_FAMILY,
    fontSize: 8.5,
    cellPadding: 2.5,
    textColor: [30, 30, 30] as [number, number, number],
    lineColor: [200, 200, 200] as [number, number, number],
    lineWidth: 0.3,
  },
  headStyles: {
    fillColor: [245, 245, 245] as [number, number, number],
    textColor: [30, 30, 30] as [number, number, number],
    fontStyle: "bold" as const,
  },
  alternateRowStyles: {
    fillColor: [252, 252, 252] as [number, number, number],
  },
};

function lastY(doc: jsPDF): number {
  return (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY;
}

/** "1:45" or "12 min" style: minutes and seconds under an hour. */
export function formatSeizureDuration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")} h`;
}

/** The drawing state one section render shares between its parts. */
interface Pen {
  ctx: DoctorReportPdfRenderContext;
  section: SeizureReportSection;
  y: number;
  tableMargin: { left: number; right: number; top: number; bottom: number };
  typeById: Map<string | null, SeizureReportType>;
  typeName: (type: SeizureReportType | undefined) => string;
  heading: (key: string) => void;
  paragraph: (text: string, size?: number) => void;
}

function makePen(
  ctx: DoctorReportPdfRenderContext,
  section: SeizureReportSection,
  y: number,
): Pen {
  const { doc, t, margin, pageWidth, tableBottomMargin, ensureSpace } = ctx;
  const pen: Pen = {
    ctx,
    section,
    y,
    tableMargin: {
      left: margin,
      right: margin,
      top: margin,
      bottom: tableBottomMargin,
    },
    typeById: new Map(section.types.map((ty) => [ty.id, ty])),
    typeName: (type) => {
      if (!type || type.id === null) return t("seizures.report.untyped");
      const label = type.label ?? t("seizures.type.unreadable");
      if (!type.ilaeType) return label;
      return `${label} (${t(ilaeLabelKey(type.ilaeType))})`;
    },
    heading: (key) => {
      pen.y = ensureSpace(pen.y, 14);
      doc.setFontSize(10.5);
      doc.setFont(PDF_FONT_FAMILY, "bold");
      doc.setTextColor(30, 30, 30);
      doc.text(t(key), margin, pen.y);
      pen.y += 4;
    },
    paragraph: (text, size = 9) => {
      doc.setFontSize(size);
      doc.setFont(PDF_FONT_FAMILY, "normal");
      doc.setTextColor(60, 60, 60);
      const lines = doc.splitTextToSize(text, pageWidth - margin * 2);
      pen.y = ensureSpace(pen.y, lines.length * 4.2 + 2);
      doc.text(lines, margin, pen.y);
      pen.y += lines.length * 4.2 + 2;
    },
  };
  return pen;
}

/** Title and summary. */
function drawSummary(p: Pen): void {
  const { doc, t, num, margin, fmtDate } = p.ctx;
  const section = p.section;
  const { tableMargin } = p;
  doc.setFontSize(14);
  doc.setFont(PDF_FONT_FAMILY, "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(t("seizures.report.title"), margin, p.y);
  p.y += 6;

  const s = section.summary;
  const rule = t("seizures.report.ruleText", {
    count: section.rule.count,
    hours: section.rule.windowHours,
  });
  const summaryRows: Array<[string, string]> = [
    // When the diary began inside the period, the figures count from then,
    // and the report says so before the first of them.
    ...(s.diaryFrom
      ? ([[t("seizures.report.diarySince"), fmtDate(s.diaryFrom)]] as Array<
          [string, string]
        >)
      : []),
    [t("seizures.report.recorded"), String(s.seizures)],
    [t("seizures.report.seizureDays"), String(s.seizureDays)],
    [t("seizures.report.seizureFreeDays"), String(s.seizureFreeDays)],
    [t("seizures.report.per28Days"), num(s.per28Days, 1)],
    [
      t("seizures.report.longestFree"),
      t("seizures.report.daysValue", { count: s.longestFreeDays }),
    ],
    [
      t("seizures.report.daysSinceLast"),
      s.daysSinceLast === null
        ? "—"
        : t("seizures.report.daysValue", { count: s.daysSinceLast }),
    ],
    [t("seizures.report.convulsive"), String(s.convulsive)],
    [t("seizures.report.fromSleep"), String(s.fromSleep)],
    [
      t("seizures.report.clusters", { rule }),
      `${s.clusterEpisodes} · ${t("seizures.report.niceClusters")}: ${s.niceClusterEpisodes}`,
    ],
    [t("seizures.report.rescueDoses"), String(s.rescueDoses)],
    [
      t("seizures.report.emergencies"),
      t("seizures.report.emergencyValue", {
        ems: s.emsCalled,
        ed: s.edVisits,
        admitted: s.admissions,
      }),
    ],
    [t("seizures.report.suspected"), String(s.suspected)],
  ];
  autoTable(doc, {
    startY: p.y,
    body: summaryRows,
    ...TABLE_STYLES,
    columnStyles: { 0: { cellWidth: 95 } },
    margin: tableMargin,
  });
  p.y = lastY(doc) + 6;
}

/** Type × month. */
function drawMonthly(p: Pen): void {
  const { doc, t } = p.ctx;
  const section = p.section;
  const { heading, paragraph, typeName, typeById, tableMargin } = p;
  if (section.months.length > 0 && section.monthly.length > 0) {
    heading("seizures.report.monthlyTitle");
    const monthLabel = (m: string) => m.slice(2).replace("-", "/");
    const rows = section.monthly.map((row) => [
      typeName(typeById.get(row.typeId)),
      ...row.counts.map((c, i) => (c > 0 ? `${c} (${row.days[i]})` : "–")),
      String(row.total),
    ]);
    rows.push([
      t("seizures.report.total"),
      ...section.monthlyTotal.counts.map((c, i) =>
        c > 0 ? `${c} (${section.monthlyTotal.days[i]})` : "–",
      ),
      String(section.monthlyTotal.total),
    ]);
    // Wide periods split into chunks of twelve months so the table fits.
    for (let from = 0; from < section.months.length; from += 12) {
      const slice = section.months.slice(from, from + 12);
      autoTable(doc, {
        startY: p.y,
        head: [
          [
            t("seizures.report.type"),
            ...slice.map(monthLabel),
            ...(from + 12 >= section.months.length
              ? [t("seizures.report.total")]
              : []),
          ],
        ],
        body: rows.map((r) => [
          r[0],
          ...r.slice(1 + from, 1 + from + slice.length),
          ...(from + 12 >= section.months.length ? [r[r.length - 1]] : []),
        ]),
        ...TABLE_STYLES,
        styles: { ...TABLE_STYLES.styles, fontSize: 7.5, cellPadding: 1.8 },
        margin: tableMargin,
      });
      p.y = lastY(doc) + 3;
    }
    paragraph(t("seizures.report.monthlyNote"), 8);
  }
}

/** Monthly chart with medication markers. */
function drawChart(p: Pen): void {
  const { doc, t, fmtDate, margin, pageWidth, ensureSpace, includeCharts } =
    p.ctx;
  const section = p.section;
  const { heading, paragraph, typeName, typeById } = p;
  if (includeCharts && section.months.length > 1) {
    p.y = ensureSpace(p.y, 62);
    heading("seizures.report.chartTitle");
    const chartX = margin + 8;
    const chartW = pageWidth - margin * 2 - 8;
    const chartH = 40;
    const top = p.y + 2;
    const bottom = top + chartH;
    const max = Math.max(1, ...section.monthlyTotal.counts);
    const slot = chartW / section.months.length;
    const barW = Math.max(1.5, slot * 0.6);
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.2);
    doc.line(chartX, bottom, chartX + chartW, bottom);
    doc.setFontSize(7);
    doc.setFont(PDF_FONT_FAMILY, "normal");
    doc.setTextColor(90, 90, 90);
    doc.text(String(max), chartX - 2, top + 2, { align: "right" });
    doc.text("0", chartX - 2, bottom, { align: "right" });
    section.months.forEach((month, i) => {
      let stack = bottom;
      section.monthly.forEach((row, r) => {
        const value = row.counts[i];
        if (!value) return;
        const h = (value / max) * chartH;
        const [cr, cg, cb] = BAR_SHADES[r % BAR_SHADES.length];
        doc.setFillColor(cr, cg, cb);
        doc.rect(
          chartX + i * slot + (slot - barW) / 2,
          stack - h,
          barW,
          h,
          "F",
        );
        stack -= h;
      });
      if (section.months.length <= 18 || i % 3 === 0) {
        doc.text(
          month.slice(2).replace("-", "/"),
          chartX + i * slot + slot / 2,
          bottom + 3.5,
          {
            align: "center",
          },
        );
      }
    });
    // Markers: a dashed line per month that holds one, numbered.
    const markerMonths = new Map<string, number[]>();
    section.markers.forEach((m, idx) => {
      const list = markerMonths.get(m.date.slice(0, 7)) ?? [];
      list.push(idx + 1);
      markerMonths.set(m.date.slice(0, 7), list);
    });
    doc.setDrawColor(60, 60, 60);
    doc.setLineDashPattern([0.8, 0.8], 0);
    for (const [month, numbers] of markerMonths) {
      const i = section.months.indexOf(month);
      if (i < 0) continue;
      const x = chartX + i * slot + slot / 2;
      doc.line(x, top - 1, x, bottom);
      doc.text(numbers.join(","), x, top - 2, { align: "center" });
    }
    doc.setLineDashPattern([], 0);
    p.y = bottom + 7;

    // Legend: the types' shades, then the numbered markers.
    doc.setFontSize(7.5);
    let lx = margin;
    section.monthly.forEach((row, r) => {
      const [cr, cg, cb] = BAR_SHADES[r % BAR_SHADES.length];
      const label = typeName(typeById.get(row.typeId));
      const w = doc.getTextWidth(label) + 8;
      if (lx + w > pageWidth - margin) {
        lx = margin;
        p.y += 4;
      }
      doc.setFillColor(cr, cg, cb);
      doc.rect(lx, p.y - 2.4, 3, 3, "F");
      doc.text(label, lx + 4, p.y);
      lx += w;
    });
    p.y += 5;
  }
  if (section.markers.length > 0) {
    const lines = section.markers.map((m, i) =>
      t(`seizures.report.marker.${m.kind}`, {
        n: i + 1,
        date: fmtDate(`${m.date}T12:00:00.000Z`),
        name: m.medicationName,
        dose: m.dose ?? "",
      }),
    );
    paragraph(`${t("seizures.report.markersTitle")} ${lines.join("; ")}.`, 8);
    paragraph(t("seizures.report.markersNote"), 8);
  }
}

/** Durations. */
function drawDurations(p: Pen): void {
  const { doc, t } = p.ctx;
  const section = p.section;
  const { heading, paragraph, typeName, typeById, tableMargin } = p;
  if (section.durations.length > 0) {
    heading("seizures.report.durationTitle");
    autoTable(doc, {
      startY: p.y,
      head: [
        [
          t("seizures.report.type"),
          t("seizures.report.timed"),
          t("seizures.report.median"),
          t("seizures.report.max"),
          t("seizures.report.overT1"),
          t("seizures.report.prolonged"),
        ],
      ],
      body: section.durations.map((d) => [
        typeName(typeById.get(d.typeId)),
        String(d.timed),
        formatSeizureDuration(d.medianSec),
        formatSeizureDuration(d.maxSec),
        d.t1Sec === null
          ? "—"
          : `${d.overT1} (${formatSeizureDuration(d.t1Sec)})`,
        String(d.prolonged),
      ]),
      ...TABLE_STYLES,
      margin: tableMargin,
    });
    p.y = lastY(doc) + 3;
    paragraph(t("seizures.report.durationNote"), 8);
  }
}

/** Rescue medication. */
function drawRescue(p: Pen): void {
  const { doc, t, dateTime } = p.ctx;
  const section = p.section;
  const { heading, tableMargin } = p;
  if (section.rescue.length > 0) {
    heading("seizures.report.rescueTitle");
    autoTable(doc, {
      startY: p.y,
      head: [
        [
          t("seizures.report.date"),
          t("seizures.report.drug"),
          t("seizures.report.dose"),
          t("seizures.report.route"),
          t("seizures.report.minutesFromOnset"),
          t("seizures.report.effect"),
        ],
      ],
      body: section.rescue.map((r) => [
        dateTime(new Date(r.givenAt)),
        r.medicationName,
        r.dose ?? "—",
        r.route ? t(`seizures.route.${r.route}`) : "—",
        r.minutesFromOnset === null ? "—" : String(r.minutesFromOnset),
        t(`seizures.effect.${r.effect}`),
      ]),
      ...TABLE_STYLES,
      margin: tableMargin,
    });
    p.y = lastY(doc) + 6;
  }
}

/** Suspected triggers. */
function drawTriggers(p: Pen): void {
  const { t } = p.ctx;
  const section = p.section;
  const { heading, paragraph } = p;
  if (section.triggers.length > 0) {
    heading("seizures.report.triggersTitle");
    paragraph(
      section.triggers
        .map((tr) => `${t(`seizures.trigger.${tr.trigger}`)}: ${tr.count}`)
        .join(", "),
    );
    paragraph(t("seizures.report.triggersNote"), 8);
  }
}

/** Overlays. */
function drawOverlays(p: Pen): void {
  const { t, num } = p.ctx;
  const section = p.section;
  const { heading, paragraph } = p;
  const o = section.overlays;
  if (o.missedDose || o.cycle || o.sleep || o.illness) {
    heading("seizures.report.overlaysTitle");
    if (o.missedDose) {
      paragraph(
        t("seizures.report.overlayMissedDose", {
          followed: o.missedDose.followed,
          of: o.missedDose.of,
        }),
      );
    }
    if (o.illness) {
      paragraph(
        t("seizures.report.overlayIllness", {
          during: o.illness.during,
          episodes: o.illness.episodes,
        }),
      );
    }
    if (o.sleep) {
      paragraph(
        t("seizures.report.overlaySleep", {
          before: num(o.sleep.beforeSeizureDays / 60, 1),
          other: num(o.sleep.otherNights / 60, 1),
          nightsBefore: o.sleep.nightsBefore,
          nightsOther: o.sleep.nightsOther,
        }),
      );
    }
    if (o.cycle) {
      const counted = o.cycle.byCycleDay
        .map((c, i) => (c > 0 ? `${i + 1}: ${c}` : null))
        .filter((v): v is string => v !== null);
      if (counted.length > 0) {
        paragraph(
          t("seizures.report.overlayCycleDays", { list: counted.join(", ") }),
        );
      }
      if (o.cycle.c1Ratio !== null || o.cycle.c2Ratio !== null) {
        paragraph(
          t("seizures.report.overlayCycleRatio", {
            cycles: o.cycle.cycles,
            c1: o.cycle.c1Ratio === null ? "—" : num(o.cycle.c1Ratio, 1),
            c2: o.cycle.c2Ratio === null ? "—" : num(o.cycle.c2Ratio, 1),
          }),
        );
      } else {
        paragraph(
          t("seizures.report.overlayCycleTooFew", { cycles: o.cycle.cycles }),
          8,
        );
      }
    }
    paragraph(t("seizures.report.overlaysNote"), 8);
  }
}

/** Event appendix. */
function drawEvents(p: Pen): void {
  const { doc, t, dateTime } = p.ctx;
  const section = p.section;
  const { heading, paragraph, typeName, typeById, tableMargin } = p;
  const listed = section.events.slice(-SEIZURE_REPORT_EVENT_CAP);
  if (listed.length > 0) {
    heading("seizures.report.eventsTitle");
    autoTable(doc, {
      startY: p.y,
      head: [
        [
          t("seizures.report.date"),
          t("seizures.report.type"),
          t("seizures.report.duration"),
          t("seizures.report.sleep"),
          t("seizures.report.rescueShort"),
          t("seizures.report.injury"),
          t("seizures.report.note"),
        ],
      ],
      body: listed.map((e) => [
        dateTime(new Date(e.onsetAt)) +
          (e.count > 1 ? ` (×${e.count})` : "") +
          (e.suspected ? ` ${t("seizures.report.suspectedMark")}` : ""),
        typeName(typeById.get(e.typeId)) +
          (e.ilaeType && e.ilaeType !== typeById.get(e.typeId)?.ilaeType
            ? ` / ${t(ilaeLabelKey(e.ilaeType))}`
            : ""),
        formatSeizureDuration(e.durationSec) + (e.estimated ? " ~" : ""),
        t(`seizures.sleepState.${e.sleepState}`),
        e.rescue ? "•" : "",
        e.injury ? "•" : "",
        e.note ?? "",
      ]),
      ...TABLE_STYLES,
      styles: { ...TABLE_STYLES.styles, fontSize: 7.5, cellPadding: 1.8 },
      columnStyles: { 6: { cellWidth: 45 } },
      margin: tableMargin,
    });
    p.y = lastY(doc) + 3;
    if (section.events.length > listed.length) {
      paragraph(t("seizures.report.eventsTruncated"), 8);
    }
  }
}

/** Classification note and footer. */
function drawFooter(p: Pen): void {
  const { t } = p.ctx;
  const section = p.section;
  const { paragraph } = p;
  const legacy = section.types
    .filter((ty) => ty.ilaeType && ilae2017LabelKey(ty.ilaeType))
    .map(
      (ty) =>
        `${t(ilaeLabelKey(ty.ilaeType!))} = ${t(ilae2017LabelKey(ty.ilaeType!)!)}`,
    );
  if (legacy.length > 0) {
    paragraph(
      `${t("seizures.report.classificationNote")} ${[...new Set(legacy)].join("; ")}.`,
      8,
    );
  }
  paragraph(t("seizures.report.footer"), 8);
  p.y += 4;
}

export function buildSeizureSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const section = context.data.seizureDiary;
  if (!section) return state;
  const pen = makePen(context, section, context.ensureSpace(state.y, 6 + 30));
  drawSummary(pen);
  drawMonthly(pen);
  drawChart(pen);
  drawDurations(pen);
  drawRescue(pen);
  drawTriggers(pen);
  drawOverlays(pen);
  drawEvents(pen);
  drawFooter(pen);
  return pdfCursorState(context.doc, pen.y);
}
