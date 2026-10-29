"use client";

/**
 * Lab markers on the timeline (#1299): their rows under the value lines,
 * their readings in the selection bar and the phone chronicle, and their
 * table for a screen reader.
 *
 * A lab line is its readings, one point each on the day of the draw, never a
 * mean. Each row has its own scale, which holds the reference range as well
 * as the points, and the range is painted behind them as the labs page
 * paints it: a faint band with dashed edges, in the row's own colour. A
 * reading outside its range is a triangle pointing the way it left (up above
 * the range, down below it) and says so in words wherever it is written out,
 * so the colour is never the only sign. The numbers read through the labs
 * page's own formatter, so a reading keeps every digit it was stored with.
 */
import { useCallback } from "react";
import Link from "next/link";

import { useLabNumber } from "@/components/labs/use-lab-format";
import { InlineAction } from "@/components/ui/inline-action";
import type {
  TimelineBucket,
  TimelineLabPoint,
  TimelineLabSeries,
} from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { useTranslations } from "@/lib/i18n/context";

import type { ChronicleEntry } from "./chronicle-model";
import { TIMELINE_LAB_RANGE_KEY } from "./label-keys";
import {
  bucketAfter,
  dayKey,
  dayNumber,
  formatDayMonth,
  formatDayMonthYear,
} from "./timeline-dates";
import { seriesNameLines, type TimelineLayout } from "./timeline-geometry";

/** "18 ng/mL", every digit the reading holds, in the reader's locale. */
export type LabValueText = (
  value: number,
  sourceValue: number | null,
  unit: string,
) => string;

export function useLabValueText(): LabValueText {
  const labNumber = useLabNumber();
  return useCallback(
    (value, sourceValue, unit) =>
      `${labNumber(value, sourceValue)} ${unit}`.trim(),
    [labNumber],
  );
}

/** "below range" / "above range", or null for a reading in range. */
export function useLabVerdict(): (
  status: TimelineLabPoint["rangeStatus"],
) => string | null {
  const { t } = useTranslations();
  return useCallback(
    (status) =>
      status === "below" || status === "above"
        ? t(TIMELINE_LAB_RANGE_KEY[status])
        : null,
    [t],
  );
}

/** "Reference 30–400 ng/mL", or null without a range. */
export function useLabReference(): (
  point: Pick<TimelineLabPoint, "referenceLow" | "referenceHigh">,
  unit: string,
) => string | null {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  return useCallback(
    (point, unit) => {
      const range = formatReferenceRange(
        point.referenceLow,
        point.referenceHigh,
        (v) => labNumber(v),
      );
      return range
        ? t("timeline.labs.reference", { range: `${range} ${unit}`.trim() })
        : null;
    },
    [t, labNumber],
  );
}

/** The readings of every lab line whose day lies in `[from, to]`. */
export function labReadingsIn(
  labSeries: readonly TimelineLabSeries[],
  from: string,
  to: string,
): Array<{ key: string; unit: string; point: TimelineLabPoint }> {
  return labSeries.flatMap((s) =>
    s.points
      .filter((p) => p.date >= from && p.date <= to)
      .map((point) => ({ key: s.key, unit: s.unit, point })),
  );
}

/* ─── The rows on the chart ───────────────────────────────────────────────── */

/** Where a row's name and latest value start, as on the value lines. */
const TEXT_X = 16;

/**
 * A reading's mark: a dot in range (or without one), a triangle pointing up
 * above it and down below it. Every mark takes the row's `currentColor`.
 */
export function LabPointGlyph({
  x,
  y,
  status,
}: {
  x: number;
  y: number;
  status: TimelineLabPoint["rangeStatus"];
}) {
  if (status === "above" || status === "below") {
    const d =
      status === "above"
        ? `M${x} ${y - 4.5}L${x + 4.5} ${y + 3.5}L${x - 4.5} ${y + 3.5}Z`
        : `M${x} ${y + 4.5}L${x + 4.5} ${y - 3.5}L${x - 4.5} ${y - 3.5}Z`;
    return (
      <path
        d={d}
        data-slot="timeline-lab-point"
        data-status={status}
        fill="currentColor"
        stroke="var(--card)"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    );
  }
  return (
    <circle
      data-slot="timeline-lab-point"
      data-status={status}
      cx={x}
      cy={y}
      r={3.25}
      fill="currentColor"
      stroke="var(--card)"
      strokeWidth={1.2}
    />
  );
}

export function LabLines({
  layout,
  selectedBucket,
  bucket,
  seriesLabel,
  seriesColor,
  valueText,
}: {
  layout: Pick<
    TimelineLayout,
    "labSeries" | "series" | "seriesTop" | "scale" | "width"
  >;
  /** The first day of the selected bucket: its readings are ringed. */
  selectedBucket: string | null;
  bucket: TimelineBucket;
  seriesLabel: (key: string) => string;
  seriesColor: (key: string) => string;
  valueText: LabValueText;
}) {
  const { t } = useTranslations();
  const { scale, width } = layout;
  const rows = layout.labSeries;
  const selectedTo = selectedBucket
    ? dayKey(dayNumber(bucketAfter(selectedBucket, bucket)) - 1)
    : null;
  const nameLines = (key: string) =>
    seriesNameLines(seriesLabel(key), scale.x0 - 12 - TEXT_X, 13);
  return (
    <>
      {/* The hairline above the rows, when no value line drew it already. */}
      {layout.series.length === 0 && rows.length > 0 && (
        <line
          x1={0}
          x2={width}
          y1={layout.seriesTop - 18}
          y2={layout.seriesTop - 18}
          stroke="var(--border)"
        />
      )}
      {rows.map((row) => {
        const color = seriesColor(row.key);
        const lines = nameLines(row.key);
        return (
          <g
            key={row.key}
            data-lab-series={row.key}
            data-color={color}
            color={color}
          >
            {row.band && (
              <g data-slot="timeline-lab-band">
                {row.band.top !== null && row.band.bottom !== null && (
                  <rect
                    x={scale.x0}
                    y={row.band.top}
                    width={Math.max(0, scale.x1 - scale.x0)}
                    height={Math.max(0, row.band.bottom - row.band.top)}
                    fill="currentColor"
                    fillOpacity={0.1}
                    data-slot="timeline-lab-band-fill"
                  />
                )}
                {[row.band.top, row.band.bottom].map((edge, i) =>
                  edge === null ? null : (
                    <line
                      key={i}
                      data-slot="timeline-lab-band-edge"
                      x1={scale.x0}
                      x2={scale.x1}
                      y1={edge}
                      y2={edge}
                      stroke="currentColor"
                      strokeOpacity={0.4}
                      strokeDasharray="4 4"
                    />
                  ),
                )}
              </g>
            )}
            <line
              data-slot="timeline-series-swatch"
              x1={1.5}
              x2={10.5}
              y1={row.top + 8}
              y2={row.top + 8}
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
            />
            <text
              data-slot="timeline-series-name"
              x={TEXT_X}
              y={row.top + 12}
              fontSize={13}
              fontWeight={500}
              fill="var(--foreground)"
            >
              {lines.map((line, i) => (
                <tspan key={i} x={TEXT_X} dy={i === 0 ? 0 : 15}>
                  {line}
                </tspan>
              ))}
            </text>
            <text
              x={TEXT_X}
              y={row.top + 30 + (lines.length - 1) * 15}
              fontSize={12}
              fill="var(--muted-foreground)"
            >
              {row.latest === null
                ? t("timeline.values.noneInWindow")
                : valueText(row.latest.value, row.latest.sourceValue, row.unit)}
            </text>
            {row.path && (
              <path
                d={row.path}
                data-slot="timeline-lab-line"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.2}
                strokeOpacity={0.6}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {row.points.map((point) => (
              <g
                key={point.id}
                data-slot="timeline-lab-mark"
                data-id={point.id}
                data-date={point.date}
              >
                <LabPointGlyph
                  x={point.x}
                  y={point.y}
                  status={point.rangeStatus}
                />
              </g>
            ))}
            {selectedBucket !== null &&
              selectedTo !== null &&
              row.points
                .filter(
                  (point) =>
                    point.date >= selectedBucket && point.date <= selectedTo,
                )
                .map((point) => (
                  <circle
                    key={`selected-${point.id}`}
                    data-slot="timeline-series-selected"
                    cx={point.x}
                    cy={point.y}
                    r={6}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  />
                ))}
          </g>
        );
      })}
    </>
  );
}

/* ─── Written out ─────────────────────────────────────────────────────────── */

/**
 * Lab readings as a line of their own under the means: "● Ferritin 18 ng/mL,
 * below range, 12 Feb." with the report it came from as a link. Each reading
 * is one unit that wraps only between units, like a means line.
 */
export function LabReadingsLine({
  readings,
  label,
  seriesColor,
  valueText,
  showDate,
  links = true,
  intl,
}: {
  readings: ReturnType<typeof labReadingsIn>;
  label: (key: string) => string;
  seriesColor: (key: string) => string;
  valueText: LabValueText;
  /** The day beside each reading: where a line covers more than one day. */
  showDate: boolean;
  /**
   * The report as a link. Off inside a row that is itself a button (a link
   * cannot sit inside one); the day the row opens names the report.
   */
  links?: boolean;
  intl: string;
}) {
  const { t } = useTranslations();
  const verdict = useLabVerdict();
  return readings.map(({ key, unit, point }, i) => {
    const words = [
      `${label(key)} ${valueText(point.value, point.sourceValue, unit)}`,
      verdict(point.rangeStatus),
      showDate ? formatDayMonth(point.date, intl) : null,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      <span
        key={`${key}:${point.id}`}
        data-slot="timeline-lab-reading"
        data-series={key}
        data-status={point.rangeStatus}
        className="inline-flex max-w-full min-w-0 items-center gap-1 whitespace-nowrap"
      >
        {i > 0 ? <span className="sr-only">, </span> : null}
        <span
          data-slot="timeline-series-dot"
          className="size-2 shrink-0 rounded-full"
          style={{ background: seriesColor(key) }}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{words}</span>
        {links && point.report ? (
          <InlineAction asChild tone="muted" size="xs">
            <Link
              href={point.report.href}
              data-slot="timeline-lab-report"
              onClick={(event) => event.stopPropagation()}
            >
              {point.report.title
                ? t("timeline.labs.report", { title: point.report.title })
                : t("timeline.labs.reportUntitled")}
            </Link>
          </InlineAction>
        ) : null}
      </span>
    );
  });
}

/**
 * A lab day's row in the phone chronicle lists the chosen lab lines'
 * readings of that day under its names. The row is a button that opens the
 * day, so the report is named there, not linked here.
 */
export function ChronicleLabReadings({
  entry,
  labSeries,
  seriesColor,
  className,
}: {
  entry: ChronicleEntry;
  labSeries: readonly TimelineLabSeries[];
  seriesColor: (key: string) => string;
  /** The row's means-line classes, so both read alike. */
  className: string;
}) {
  const { locale } = useTranslations();
  const valueText = useLabValueText();
  if (
    entry.kind !== "item" ||
    entry.item.kind !== "labDay" ||
    entry.role === "end"
  ) {
    return null;
  }
  const readings = labReadingsIn(labSeries, entry.date, entry.date);
  if (readings.length === 0) return null;
  return (
    <span className={className} data-slot="timeline-chronicle-labs">
      <LabReadingsLine
        readings={readings}
        label={(key) => labSeries.find((s) => s.key === key)?.name ?? key}
        seriesColor={seriesColor}
        valueText={valueText}
        showDate={false}
        links={false}
        intl={resolveIntlLocale(locale)}
      />
    </span>
  );
}

/**
 * A lab line with readings left out because their unit does not convert into
 * the marker's says so, once, under the chart (and over the phone list):
 * nothing is dropped without a word.
 */
export function LabExcludedNote({
  labSeries,
  label,
  block = false,
}: {
  labSeries: readonly TimelineLabSeries[];
  label: (key: string) => string;
  /** A line of its own (the phone list), not runs inside the legend. */
  block?: boolean;
}) {
  const { tCount } = useTranslations();
  const lines = labSeries.filter((s) => s.excluded > 0);
  if (lines.length === 0) return null;
  const notes = lines.map((s) => (
    <span
      key={s.key}
      data-slot="timeline-lab-excluded"
      data-series={s.key}
      className="inline-flex items-center gap-1.5"
    >
      {tCount("timeline.labs.excluded", s.excluded, { name: label(s.key) })}
    </span>
  ));
  return block ? (
    <div
      className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1.5 text-xs"
      data-slot="timeline-mobile-lab-note"
    >
      {notes}
    </div>
  ) : (
    notes
  );
}

/**
 * The lab lines as a table, for a screen reader: one row per reading, its
 * marker, day, value, verdict, range and report. Visually hidden by a
 * wrapper, as the other chart tables are.
 */
export function LabSeriesTable({
  labSeries,
  window,
  label,
  valueText,
  intl,
}: {
  labSeries: readonly TimelineLabSeries[];
  window: { from: string; to: string };
  label: (key: string) => string;
  valueText: LabValueText;
  intl: string;
}) {
  const { t } = useTranslations();
  const verdict = useLabVerdict();
  const reference = useLabReference();
  const rows = labReadingsIn(labSeries, window.from, window.to).sort((a, b) =>
    a.point.date < b.point.date ? 1 : -1,
  );
  if (rows.length === 0) return null;
  return (
    <div className="sr-only" data-slot="timeline-lab-table-frame">
      <table data-slot="timeline-lab-table">
        <caption>{t("timeline.table.labsCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("timeline.table.marker")}</th>
            <th scope="col">{t("timeline.table.date")}</th>
            <th scope="col">{t("timeline.table.value")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, unit, point }) => (
            <tr key={point.id}>
              <th scope="row">{label(key)}</th>
              <td>{formatDayMonthYear(point.date, intl)}</td>
              <td>
                {[
                  valueText(point.value, point.sourceValue, unit),
                  verdict(point.rangeStatus),
                  reference(point, unit),
                  point.report
                    ? point.report.title
                      ? t("timeline.labs.report", {
                          title: point.report.title,
                        })
                      : t("timeline.labs.reportUntitled")
                    : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
