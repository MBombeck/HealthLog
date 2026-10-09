"use client";

/**
 * The timeline's lanes and value lines, as one hand-drawn SVG (v1.42, #613).
 *
 * Recharts draws every value chart in the app and stays there; it cannot lay
 * periods and events out in lanes on a shared time axis, so this one surface
 * is plain SVG, like the mood and intake heatmaps. Nothing is decided here:
 * `timeline-geometry.ts` places every mark and label, this file paints them.
 *
 * Reading it without sight or without a mouse:
 *   - The drawing itself is `aria-hidden`. A visually hidden table beside it
 *     lists every entry with its lane, start and end, and a one-line summary
 *     names the window and the lanes.
 *   - The chart is one tab stop. Left and right move the selection by a day,
 *     a month or a year with the zoom; Home and End jump to the oldest data
 *     and to today; Enter opens the selected day. The selection bar under the
 *     chart announces each move.
 *   - A pointer selects with a click and opens the day with a double click.
 *
 * The width comes from a ResizeObserver, so a docked day panel that narrows
 * the card re-runs the layout: labels that no longer fit are left out, never
 * overlapped.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  CalendarHeart,
  FileText,
  Flag,
  FlaskConical,
  Pill,
  Shield,
  Stethoscope,
  Syringe,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import type {
  TimelineBucket,
  TimelineLaneKey,
  TimelineResponse,
  TimelineZoom,
} from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";

import {
  bucketAfter,
  bucketStart,
  formatAtPrecision,
  formatBucket,
  formatMonthShort,
  formatMonthYear,
  dayNumber,
} from "./timeline-dates";
import {
  AXIS_HEIGHT,
  LANE_COLOR,
  dateAtPointer,
  estimateTextWidth,
  fitText,
  gridTicks,
  isSpan,
  todayLabelFits,
  wrapToWidth,
  layoutTimeline,
  stepSelection,
  zoomShape,
  type PlacedPoint,
  type PlacedSpan,
  type TimeWindow,
} from "./timeline-geometry";
import {
  formatSeriesValue,
  type MeanPart,
  type SeriesValueFormat,
} from "./series-format";

/** Where a value line's name and latest value start, right of its swatch. */
const SERIES_TEXT_X = 16;

export const LANE_ICON: Readonly<Record<TimelineLaneKey, LucideIcon>> = {
  life: Flag,
  illness: Thermometer,
  allergies: Shield,
  medications: Pill,
  vaccinations: Syringe,
  visits: Stethoscope,
  labs: FlaskConical,
  documents: FileText,
  cycle: CalendarHeart,
};

export interface TimelineChartProps {
  timeline: TimelineResponse;
  window: TimeWindow;
  zoom: TimelineZoom;
  today: string;
  selected: string | null;
  hiddenLanes: ReadonlySet<TimelineLaneKey>;
  seriesLabel: (key: string) => string;
  /** The colour of a value line (`series-colors.ts`), as a token string. */
  seriesColor: (key: string) => string;
  /** How a value reads (`useSeriesValueFormat`). */
  seriesFormat: SeriesValueFormat;
  onSelect: (date: string) => void;
  onOpenDay: (date: string) => void;
}

/** Observed content width of an element, 0 until measured. */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? el.clientWidth);
      setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function TimelineChart({
  timeline,
  window,
  zoom,
  today,
  selected,
  hiddenLanes,
  seriesLabel,
  seriesColor,
  seriesFormat,
  onSelect,
  onOpenDay,
}: TimelineChartProps) {
  const { t, locale } = useTranslations();
  const fmt = seriesFormat;
  const intl = resolveIntlLocale(locale);
  const { ref, width } = useElementWidth<HTMLDivElement>();

  const lanes = useMemo(
    () => timeline.lanes.filter((l) => !hiddenLanes.has(l.key)),
    [timeline.lanes, hiddenLanes],
  );
  const layout = useMemo(
    () =>
      width > 0
        ? layoutTimeline({
            width,
            window,
            lanes,
            series: timeline.series,
            bucket: timeline.bucket,
            startMissing: t("timeline.startMissing"),
            today,
          })
        : null,
    [width, window, lanes, timeline.series, timeline.bucket, t, today],
  );

  const floor = timeline.range.dataFrom ?? window.from;
  const shape = zoomShape(zoom, window);

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    const current = selected ?? today;
    let next: string | null = null;
    if (event.key === "ArrowLeft")
      next = stepSelection(current, -1, shape, today, floor);
    else if (event.key === "ArrowRight")
      next = stepSelection(current, 1, shape, today, floor);
    else if (event.key === "Home") next = floor;
    else if (event.key === "End") next = today;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenDay(current);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      onSelect(next);
    }
  }

  function pointerDate(event: React.MouseEvent<SVGSVGElement>): string | null {
    if (!layout) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < layout.scale.x0) return null;
    return dateAtPointer(layout, x, y);
  }

  const summary = t("timeline.chartLabel", {
    from: formatMonthYear(window.from, intl),
    to: formatMonthYear(window.to, intl),
  });

  return (
    <div className="space-y-3">
      <div
        ref={ref}
        role="group"
        aria-roledescription={t("timeline.title")}
        aria-label={summary}
        aria-describedby="timeline-chart-help"
        tabIndex={0}
        onKeyDown={handleKey}
        data-slot="timeline-chart"
        data-width={width}
        className="focus-visible:ring-ring/50 rounded-lg outline-none focus-visible:ring-2"
      >
        <p id="timeline-chart-help" className="sr-only">
          {t("timeline.keyboardHint")}
        </p>
        {layout ? (
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden="true"
            className="block select-none"
            onClick={(e) => {
              const date = pointerDate(e);
              if (date) onSelect(date);
            }}
            onDoubleClick={(e) => {
              const date = pointerDate(e);
              if (date) onOpenDay(date);
            }}
          >
            <ChartBody
              layout={layout}
              window={window}
              zoom={shape}
              today={today}
              selected={selected}
              dataFrom={timeline.range.dataFrom}
              bucket={timeline.bucket}
              seriesLabel={seriesLabel}
              seriesColor={seriesColor}
              intl={intl}
              t={t}
              fmt={fmt}
            />
          </svg>
        ) : (
          <div className="h-64" />
        )}
      </div>
      <TimelineTable
        timeline={timeline}
        hiddenLanes={hiddenLanes}
        intl={intl}
      />
      <SeriesTable
        timeline={timeline}
        window={window}
        seriesLabel={seriesLabel}
        fmt={fmt}
        intl={intl}
      />
    </div>
  );
}

interface ChartBodyProps {
  layout: NonNullable<ReturnType<typeof layoutTimeline>>;
  window: TimeWindow;
  zoom: Exclude<TimelineZoom, "range">;
  today: string;
  selected: string | null;
  dataFrom: string | null;
  bucket: TimelineBucket;
  seriesLabel: (key: string) => string;
  seriesColor: (key: string) => string;
  intl: string;
  t: ReturnType<typeof useTranslations>["t"];
  fmt: SeriesValueFormat;
}

function ChartBody({
  layout,
  window,
  zoom,
  today,
  selected,
  dataFrom,
  bucket,
  seriesLabel,
  seriesColor,
  intl,
  t,
  fmt,
}: ChartBodyProps) {
  const { scale, height, width } = layout;
  const todayInWindow = today >= window.from && today <= window.to;
  const todayX = scale.xMid(today);
  const todayLabel = t("timeline.today");
  const todayLabelWidth = estimateTextWidth(todayLabel, 11);
  const ticks = gridTicks(window, zoom, scale, {
    year: (k) => k.slice(0, 4),
    monthShort: (k) => formatMonthShort(k, intl),
    monthYear: (k) => formatMonthYear(k, intl),
  });
  const showTodayLabel =
    todayInWindow && todayLabelFits(ticks, todayX, todayLabelWidth, scale.x0);
  const noDataUntil =
    dataFrom && dataFrom > window.from && dataFrom <= window.to
      ? scale.x(dataFrom)
      : null;
  // The bucket that holds the selected day: its point on every line is
  // ringed in the line's colour, so the selection reads on each scale.
  const selectedBucket =
    selected && selected >= window.from && selected <= window.to
      ? bucketStart(selected, bucket)
      : null;

  return (
    <g fontFamily="inherit">
      <defs>
        <linearGradient id="timeline-fade">
          <stop offset="0" stopColor="var(--card)" />
          <stop offset="1" stopColor="var(--card)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {noDataUntil !== null && (
        <g data-slot="timeline-no-data">
          <rect
            x={scale.x0}
            y={AXIS_HEIGHT}
            width={Math.max(0, noDataUntil - scale.x0)}
            height={height - AXIS_HEIGHT}
            fill="var(--muted)"
            opacity={0.4}
          />
          {wrapToWidth(
            t("timeline.noDataYet"),
            noDataUntil - scale.x0 - 12,
          ).map((line, i, lines) => (
            <text
              key={line}
              x={scale.x0 + 8}
              y={height - 8 - (lines.length - 1 - i) * 13}
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {line}
            </text>
          ))}
        </g>
      )}

      {/* Grid and axis labels. */}
      {ticks.map((tick) => (
        <g key={tick.key}>
          <line
            x1={tick.x}
            x2={tick.x}
            y1={tick.major ? AXIS_HEIGHT - 6 : AXIS_HEIGHT}
            y2={height}
            stroke="var(--border)"
            strokeOpacity={tick.major ? 0.9 : 0.45}
          />
          {tick.label && (
            <text
              x={tick.x + 6}
              y={14}
              fontSize={12}
              fontWeight={500}
              fill="var(--muted-foreground)"
            >
              {tick.label}
            </text>
          )}
        </g>
      ))}

      {/* Lanes. */}
      {layout.lanes.map((lane, index) => {
        const Icon = LANE_ICON[lane.key];
        const color = LANE_COLOR[lane.key];
        return (
          <g key={lane.key} data-lane={lane.key}>
            {index > 0 && (
              <line
                x1={0}
                x2={width}
                y1={lane.top}
                y2={lane.top}
                stroke="var(--border)"
                strokeOpacity={0.6}
              />
            )}
            <Icon
              x={0}
              y={lane.top + 7}
              width={16}
              height={16}
              color="var(--muted-foreground)"
              strokeWidth={2}
            />
            <text
              x={24}
              y={lane.top + 19}
              fontSize={13}
              fontWeight={500}
              fill="var(--foreground)"
            >
              {fitText(t(`timeline.lanes.${lane.key}`), scale.x0 - 30, 13)}
            </text>
            {lane.spans.map((span) => (
              <SpanMark
                key={span.item.id}
                span={span}
                color={color}
                x0={scale.x0}
                intl={intl}
                t={t}
              />
            ))}
            {lane.points.map((point) => (
              <PointMark
                key={point.item.id}
                point={point}
                color={color}
                intl={intl}
              />
            ))}
            {lane.labels.map((label) => (
              <text
                key={`label-${label.itemId}`}
                x={label.x}
                y={label.y}
                fontSize={11}
                fill={
                  label.strong ? "var(--foreground)" : "var(--muted-foreground)"
                }
              >
                {label.text}
              </text>
            ))}
          </g>
        );
      })}

      {/* Value lines: one scale each, each in its own colour (the colour
          its type carries in the measurement list). The colour names the
          line, never a judgement of its values. */}
      <SeriesLines
        layout={layout}
        width={width}
        selectedBucket={selectedBucket}
        bucket={bucket}
        seriesLabel={seriesLabel}
        seriesColor={seriesColor}
        intl={intl}
        t={t}
        fmt={fmt}
      />

      {/* Today. */}
      {todayInWindow && (
        <g data-slot="timeline-today">
          <line
            x1={todayX}
            x2={todayX}
            y1={AXIS_HEIGHT - 6}
            y2={height}
            stroke="var(--muted-foreground)"
            strokeDasharray="2 3"
          />
          {showTodayLabel && (
            <text
              x={todayX - 4}
              y={14}
              textAnchor="end"
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {todayLabel}
            </text>
          )}
        </g>
      )}

      {/* Selection. */}
      {selected && selected >= window.from && selected <= window.to && (
        <g data-slot="timeline-selection" data-date={selected}>
          <line
            x1={scale.xMid(selected)}
            x2={scale.xMid(selected)}
            y1={AXIS_HEIGHT - 6}
            y2={height}
            stroke="var(--foreground)"
            strokeWidth={1.2}
            strokeOpacity={0.8}
          />
          <circle
            cx={scale.xMid(selected)}
            cy={AXIS_HEIGHT - 6}
            r={3.5}
            fill="var(--foreground)"
          />
        </g>
      )}
    </g>
  );
}

/**
 * The value lines under the lanes, each in its own colour: the swatch beside
 * the name, the line, the dashed bridge over a gap, the points (hollow where
 * a mean rests on one or two readings) and the ring on the selected bucket.
 * Every mark of a line inherits one `color` from its group, so they cannot
 * drift apart.
 */
export function SeriesLines({
  layout,
  width,
  selectedBucket,
  bucket,
  seriesLabel,
  seriesColor,
  intl,
  t,
  fmt,
}: {
  layout: NonNullable<ReturnType<typeof layoutTimeline>>;
  width: number;
  selectedBucket: string | null;
  bucket: TimelineBucket;
  seriesLabel: (key: string) => string;
  seriesColor: (key: string) => string;
  intl: string;
  t: ReturnType<typeof useTranslations>["t"];
  fmt: SeriesValueFormat;
}) {
  const { tCount } = useTranslations();
  const { scale, seriesTop } = layout;
  return (
    <>
      {layout.series.length > 0 && (
        <line
          x1={0}
          x2={width}
          y1={seriesTop - 18}
          y2={seriesTop - 18}
          stroke="var(--border)"
        />
      )}
      {layout.series.map((series) => {
        const color = seriesColor(series.key);
        return (
          <g
            key={series.key}
            data-series={series.key}
            data-color={color}
            color={color}
          >
            <line
              data-slot="timeline-series-swatch"
              x1={1.5}
              x2={10.5}
              y1={series.top + 8}
              y2={series.top + 8}
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
            />
            <text
              x={SERIES_TEXT_X}
              y={series.top + 12}
              fontSize={13}
              fontWeight={500}
              fill="var(--foreground)"
            >
              {fitText(
                seriesLabel(series.key),
                scale.x0 - 12 - SERIES_TEXT_X,
                13,
              )}
            </text>
            <text
              x={SERIES_TEXT_X}
              y={series.top + 30}
              fontSize={12}
              fill="var(--muted-foreground)"
            >
              {series.latest === null
                ? t("timeline.values.noneInWindow")
                : formatSeriesValue(
                    series.key,
                    series.latest,
                    series.unit,
                    fmt,
                  )}
            </text>
            {series.path && (
              <path
                d={series.path}
                data-slot="timeline-series-line"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {series.bridges && (
              <path
                d={series.bridges}
                data-slot="timeline-series-bridge"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.2}
                strokeOpacity={0.7}
                strokeDasharray="3 3"
                strokeLinecap="round"
              />
            )}
            {series.points.map((point) => (
              <circle
                key={point.t}
                data-slot="timeline-series-point"
                data-t={point.t}
                data-count={point.count}
                data-thin={point.thin ? "true" : "false"}
                cx={point.x}
                cy={point.y}
                r={point.thin ? 2.75 : 2.5}
                fill={point.thin ? "var(--card)" : "currentColor"}
                stroke="currentColor"
                strokeWidth={point.thin ? 1.4 : 0}
              >
                <title>
                  {`${seriesLabel(series.key)}, ${bucketText(point.t, bucket, intl, t)}: ${formatSeriesValue(series.key, point.mean, series.unit, fmt)}, ${tCount("timeline.values.readings", point.count)}`}
                </title>
              </circle>
            ))}
            {series.points
              .filter((point) => point.t === selectedBucket)
              .map((point) => (
                <circle
                  key={`selected-${point.t}`}
                  data-slot="timeline-series-selected"
                  cx={point.x}
                  cy={point.y}
                  r={5}
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

function spanTitle(
  span: PlacedSpan,
  intl: string,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  const { item } = span;
  const from = formatAtPrecision(item.start, item.precision, intl);
  const to = item.open
    ? t("timeline.selection.ongoing")
    : formatAtPrecision(item.end ?? item.start, item.precision, intl);
  const name = item.sub ? `${item.label} · ${item.sub}` : item.label;
  return `${name}: ${t("timeline.selection.range", { from, to })}`;
}

function SpanMark({
  span,
  color,
  x0,
  intl,
  t,
}: {
  span: PlacedSpan;
  color: string;
  x0: number;
  intl: string;
  t: ReturnType<typeof useTranslations>["t"];
}) {
  const { item, xStart, xEnd, y } = span;
  const title = spanTitle(span, intl, t);
  if (span.pause) {
    return (
      <g data-kind="pause">
        <title>{title}</title>
        <rect
          x={xStart}
          y={y - 4.5}
          width={xEnd - xStart}
          height={9}
          rx={2}
          fill="var(--card)"
          stroke={color}
          strokeDasharray="2 2"
        />
      </g>
    );
  }
  const thick = item.open ? 3 : 7;
  return (
    <g data-kind={item.kind} data-item={item.id}>
      <title>{title}</title>
      {!item.startKnown && (
        <line
          x1={Math.max(x0, xStart - 28)}
          x2={xStart}
          y1={y}
          y2={y}
          stroke={color}
          strokeWidth={3}
          strokeDasharray="3 4"
          opacity={0.6}
        />
      )}
      <rect
        x={xStart}
        y={y - thick / 2}
        width={Math.max(xEnd - xStart, 4)}
        height={thick}
        rx={thick / 2}
        fill={color}
        opacity={item.open ? 0.75 : 0.9}
      />
      {item.open && (
        <path
          d={`M${xEnd + 1} ${y - 4} l6 4 l-6 4z`}
          fill={color}
          opacity={0.75}
        />
      )}
      {span.clippedLeft && item.startKnown && (
        <rect
          x={x0}
          y={y - 4}
          width={22}
          height={8}
          fill="url(#timeline-fade)"
        />
      )}
    </g>
  );
}

function PointMark({
  point,
  color,
  intl,
}: {
  point: PlacedPoint;
  color: string;
  intl: string;
}) {
  const { x, y, item, shape } = point;
  const title = `${item.label}${item.sub ? ` · ${item.sub}` : ""}: ${formatAtPrecision(item.start, item.precision, intl)}`;
  let glyph: React.ReactNode;
  switch (shape) {
    case "diamond":
      glyph = (
        <rect
          x={x - 5}
          y={y - 5}
          width={10}
          height={10}
          transform={`rotate(45 ${x} ${y})`}
          fill="var(--card)"
          stroke={color}
          strokeWidth={1.6}
        />
      );
      break;
    case "square":
      glyph = (
        <rect
          x={x - 4.5}
          y={y - 4.5}
          width={9}
          height={9}
          rx={2}
          fill={color}
        />
      );
      break;
    case "tick":
      glyph = (
        <rect
          x={x - 1}
          y={y - 6}
          width={2}
          height={12}
          rx={1}
          fill={color}
          opacity={0.7}
        />
      );
      break;
    case "ring":
      glyph = (
        <circle
          cx={x}
          cy={y}
          r={3.5}
          fill="var(--card)"
          stroke={color}
          strokeWidth={1.6}
        />
      );
      break;
    case "doseMark":
      glyph = (
        <line
          x1={x}
          x2={x}
          y1={y - 6}
          y2={y + 6}
          stroke={color}
          strokeWidth={2}
        />
      );
      break;
    default:
      glyph = (
        <circle
          cx={x}
          cy={y}
          r={4}
          fill={color}
          stroke="var(--card)"
          strokeWidth={1.5}
        />
      );
  }
  return (
    <g data-kind={item.kind} data-item={item.id}>
      <title>{title}</title>
      {glyph}
    </g>
  );
}

/**
 * The chart as a table, for a screen reader: every entry with its lane and
 * dates. Visually hidden; the phone chronicle is the visible list form.
 */
function TimelineTable({
  timeline,
  hiddenLanes,
  intl,
}: {
  timeline: TimelineResponse;
  hiddenLanes: ReadonlySet<TimelineLaneKey>;
  intl: string;
}) {
  const { t } = useTranslations();
  const rows = timeline.lanes
    .filter((lane) => !hiddenLanes.has(lane.key))
    .flatMap((lane) => lane.items.map((item) => ({ lane: lane.key, item })))
    .sort((a, b) => dayNumber(b.item.start) - dayNumber(a.item.start));
  return (
    <table className="sr-only" data-slot="timeline-table">
      <caption>{t("timeline.table.caption")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("timeline.table.lane")}</th>
          <th scope="col">{t("timeline.table.entry")}</th>
          <th scope="col">{t("timeline.table.start")}</th>
          <th scope="col">{t("timeline.table.end")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ lane, item }) => (
          <tr key={`${lane}-${item.id}`}>
            <td>{t(`timeline.lanes.${lane}`)}</td>
            <td>
              {item.label}
              {item.sub ? ` · ${item.sub}` : ""}
              {!item.startKnown ? ` · ${t("timeline.startMissing")}` : ""}
            </td>
            <td>{formatAtPrecision(item.start, item.precision, intl)}</td>
            <td>
              {item.open
                ? t("timeline.selection.ongoing")
                : isSpan(item) && item.end
                  ? formatAtPrecision(item.end, item.precision, intl)
                  : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "Januar 2026", "Jan bis März 2026", "5. Jan. bis 11. Jan. 2026". */
export function bucketText(
  start: string,
  bucket: TimelineBucket,
  intl: string,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  const label = formatBucket(start, bucket, intl);
  return typeof label === "string"
    ? label
    : t("timeline.selection.range", label);
}

/**
 * The value lines as a table, for a screen reader: one row per bucket from
 * the first to the last with a reading in the window, one column per
 * series. A bucket without a reading says so; nothing is filled in.
 */
function SeriesTable({
  timeline,
  window,
  seriesLabel,
  fmt,
  intl,
}: {
  timeline: TimelineResponse;
  window: { from: string; to: string };
  seriesLabel: (key: string) => string;
  fmt: SeriesValueFormat;
  intl: string;
}) {
  const { t, tCount } = useTranslations();
  const { bucket, series } = timeline;
  const inWindow = (start: string) =>
    start <= window.to && bucketAfter(start, bucket) > window.from;
  const starts = series
    .flatMap((s) => s.points.map((p) => p.t))
    .filter(inWindow)
    .sort();
  if (starts.length === 0) return null;
  const rows: string[] = [];
  for (
    let start = bucketStart(starts[0], bucket);
    start <= starts[starts.length - 1];
    start = bucketAfter(start, bucket)
  ) {
    rows.push(start);
  }
  const byKey = new Map(
    series.map((s) => [s.key, new Map(s.points.map((p) => [p.t, p]))]),
  );
  return (
    <table className="sr-only" data-slot="timeline-series-table">
      <caption>{t("timeline.table.seriesCaption")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("timeline.table.period")}</th>
          {series.map((s) => (
            <th key={s.key} scope="col">
              {seriesLabel(s.key)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.reverse().map((start) => (
          <tr key={start} data-bucket={start}>
            <th scope="row">{bucketText(start, bucket, intl, t)}</th>
            {series.map((s) => {
              const point = byKey.get(s.key)?.get(start);
              return (
                <td key={s.key}>
                  {point
                    ? `${formatSeriesValue(s.key, point.mean, s.unit, fmt)}, ${tCount("timeline.values.readings", point.count)}`
                    : t("timeline.values.noValue")}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A means line with each value marked by its line's colour: "● 129/82 mmHg
 * · ● 82,6 kg". The dot is decoration; the text reads the same without it.
 */
export function MeanPartsLine({
  parts,
  seriesColor,
}: {
  parts: readonly MeanPart[];
  seriesColor: (key: string) => string;
}) {
  return parts.map((part, i) => (
    <span key={part.key} data-series={part.key}>
      {i > 0 ? " · " : null}
      <span
        data-slot="timeline-series-dot"
        className="mr-1 inline-block size-2 rounded-full align-middle"
        style={{ background: seriesColor(part.key) }}
        aria-hidden="true"
      />
      {part.text}
    </span>
  ));
}

/** Inline style for a lane colour dot in HTML (chips, chronicle rails). */
export function laneDotStyle(lane: TimelineLaneKey): React.CSSProperties {
  return { background: LANE_COLOR[lane] };
}
