"use client";

import { ChartDayCaption, useCoarsePointer } from "@/components/day/chart-day";
import { dayAnchor } from "@/components/day/chart-day-links";
import { OPEN_DAY_CELL, useHeatmapDay } from "@/components/day/heatmap-day";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { ChartDataTable } from "./chart-data-table";
import { useState, useMemo, useEffect, useRef } from "react";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
import { heatmapDays } from "@/lib/charts/heatmap-days";
import { moodLabelKeyForScore } from "@/lib/mood/labels";

/**
 * v1.8.5 — mood calendar heatmap.
 *
 * Forked from `compliance-heatmap.tsx`: same SVG cell-grid, Monday-aligned
 * columns, month markers, tap-to-pin tooltip, and `stretch` adaptive cell
 * sizing. The one swap is `getColor` — instead of an expected/taken
 * compliance map, each cell is coloured by its daily-mean mood score band
 * (matching the `mood-chart.tsx` VALUE_BANDS: 1–2 red, 2–3 orange, 3–5
 * green). One cell per calendar day; days with no entry render in the
 * neutral `--secondary` fill.
 */

interface MoodHeatmapCell {
  /** YYYY-MM-DD day key. */
  date: string;
  /** Daily-mean mood score 1..5. */
  score: number;
  /** Number of entries that fed the mean. */
  samples: number;
}

interface MoodHeatmapProps {
  /** Per-day cells keyed by YYYY-MM-DD. */
  cells: Record<string, MoodHeatmapCell>;
  days?: number;
  stretch?: boolean;
}

const CELL_SIZE = 18;
const GAP = 3;
const CELL_FLOOR_PX = 14;
// v1.15.3 — cell-ceiling for the stretch branch. A short window (few covered
// weeks → only ~5 columns) drove the adaptive `containerWidth / weeks` cell to
// fill a wide card; since the grid is square the SVG height blew up to ~3× the
// neighbouring tiles. Capping the cell keeps the grid dense + left-aligned so
// the calendar holds the tile-height rhythm. Mirrors `compliance-heatmap.tsx`.
const CELL_CEIL_PX = 22;
const HEADER_PX = 18;

/**
 * The grid's height in the stretch layout, as CSS, so it is known before the
 * grid has measured anything — on the server, in the loading skeleton, and in
 * the first client frame alike.
 *
 * The stretch cell is the container width shared out across the weeks,
 * clamped to the floor and the ceiling; the grid is the month header plus
 * seven cells and six gaps. The same rule `MoodHeatmap` applies in JavaScript
 * once it has measured, written here in container-query units so the box is
 * the right height from the first paint and nothing below it moves when the
 * measurement lands. Read against the nearest `container-type: inline-size`
 * ancestor, which `MoodHeatmapBody` provides.
 */
export function moodHeatmapStretchHeight(weeks: number): string {
  const w = Math.max(1, weeks);
  const cell = `clamp(${CELL_FLOOR_PX}px, calc((100cqw - ${(w - 1) * GAP}px) / ${w}), ${CELL_CEIL_PX}px)`;
  return `calc(${HEADER_PX + 6 * GAP}px + 7 * ${cell})`;
}

/** Monday-aligned columns a window of `days` spans, as the grid lays it out. */
export function moodHeatmapWeeks(days: number, timeZone: string): number {
  const dates = heatmapDays(new Date(), timeZone, days);
  const firstDow = dates[0]?.dow ?? 0;
  return Math.floor((dates.length - 1 + firstDow) / 7) + 1;
}

/**
 * The size container + the reserved box the grid paints into. Shared by the
 * heatmap and its skeleton so the two can never disagree about the height.
 */
export function MoodHeatmapBody({
  weeks,
  children,
}: {
  weeks: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ containerType: "inline-size" }} className="w-full">
      <div
        data-slot="mood-heatmap-body"
        style={{ height: moodHeatmapStretchHeight(weeks) }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The loading shape of the stretched heatmap, at exactly the height the
 * painted heatmap takes: the reserved grid box, the legend line, the day
 * caption and the data-table toggle. `days` is the window when it is already
 * known; without it the shape assumes a window short enough to reach the cell
 * ceiling, which every window under a quarter year does on any width.
 */
export function MoodHeatmapSkeleton({ days = 84 }: { days?: number }) {
  const timeZone = useDisplayTimezone();
  const coarse = useCoarsePointer();
  return (
    <div
      data-slot="mood-heatmap-skeleton"
      aria-hidden="true"
      className="w-full"
    >
      <MoodHeatmapBody weeks={moodHeatmapWeeks(days, timeZone)}>
        <div className="bg-muted/50 h-full w-full animate-pulse rounded-md motion-reduce:animate-none" />
      </MoodHeatmapBody>
      <div className="mt-2 h-4" />
      <ChartDayCaption coarse={coarse} mark="cell" rug={false} />
      <div className="border-border mt-3 border-t pt-3">
        <div className="min-h-11" />
      </div>
    </div>
  );
}

/**
 * Mood score band → Dracula colour. Mirrors `mood-chart.tsx` VALUE_BANDS
 * (1–2 red, 2–3 orange, 3–5 green) and the green/orange thresholds in
 * `mood-aggregates.ts`. No score (no entry that day) → neutral fill.
 */
function getColor(score: number | null): string {
  if (score == null) return "var(--secondary)";
  if (score < 2) return "var(--dracula-red)";
  if (score < 3) return "var(--dracula-orange)";
  if (score < 3.5) return "var(--dracula-yellow)";
  return "var(--dracula-green)";
}

export function MoodHeatmap({
  cells: cellData,
  days = 90,
  stretch = false,
}: MoodHeatmapProps) {
  const { t } = useTranslations();
  const timeZone = useDisplayTimezone();
  // Day keys are calendar dates ("YYYY-MM-DD"), read as such in every zone.
  // A noon-UTC instant formatted in the reader's zone was a day late from
  // UTC+12 to UTC+14.
  const formatDay = useCalendarDate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  // v1.42 — the cells are doors to their days, the same doors every chart
  // has: a click (fine pointer), the pinned tooltip's button (touch), a
  // dashed outline on the open day, and the data table for the keyboard.
  const heatmapDay = useHeatmapDay(containerRef);

  const WEEKDAY_LABELS = [
    t("charts.weekdays.mon"),
    "",
    t("charts.weekdays.wed"),
    "",
    t("charts.weekdays.fri"),
    "",
    t("charts.weekdays.sun"),
  ];

  useEffect(() => {
    if (!stretch) return;
    const element = containerRef.current;
    if (!element) return;

    const updateWidth = () => {
      setContainerWidth(element.clientWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [stretch]);

  const { cells, weeks, monthMarkers } = useMemo(() => {
    const MONTH_LABELS = [
      t("charts.months.jan"),
      t("charts.months.feb"),
      t("charts.months.mar"),
      t("charts.months.apr"),
      t("charts.months.may"),
      t("charts.months.jun"),
      t("charts.months.jul"),
      t("charts.months.aug"),
      t("charts.months.sep"),
      t("charts.months.oct"),
      t("charts.months.nov"),
      t("charts.months.dec"),
    ];
    const cellList: Array<{
      dateKey: string;
      col: number;
      row: number;
      color: string;
      cell: MoodHeatmapCell | null;
    }> = [];

    const dates = heatmapDays(new Date(), timeZone, days);
    const firstDow = dates[0]?.dow ?? 0;

    let col = 0;
    const markers: Array<{ col: number; label: string }> = [];
    let lastMonth = -1;

    for (let i = 0; i < dates.length; i++) {
      const { dateKey, dow, month } = dates[i];
      const currentCol = Math.floor((i + firstDow) / 7);
      const row = dow;
      const cell = cellData[dateKey] ?? null;

      if (month !== lastMonth) {
        markers.push({ col: currentCol, label: MONTH_LABELS[month] });
        lastMonth = month;
      }

      cellList.push({
        dateKey,
        col: currentCol,
        row,
        color: getColor(cell?.score ?? null),
        cell,
      });

      col = Math.max(col, currentCol);
    }

    return { cells: cellList, weeks: col + 1, monthMarkers: markers };
  }, [cellData, days, t, timeZone]);

  const loggedDays = cells.filter((cell) => cell.cell !== null).length;
  const summaryLabel =
    cells.length === 0 || loggedDays === 0
      ? t("charts.a11y.moodHeatmapEmpty")
      : t("charts.a11y.moodHeatmap", {
          start: formatDay(cells[0].dateKey),
          end: formatDay(cells[cells.length - 1].dateKey),
          days: loggedDays,
        });

  const labelWidth = stretch ? 0 : 76;
  const headerHeight = HEADER_PX;
  const cellSize =
    stretch && containerWidth > 0
      ? Math.min(
          CELL_CEIL_PX,
          Math.max(
            CELL_FLOOR_PX,
            (containerWidth - labelWidth - Math.max(0, weeks - 1) * GAP) /
              Math.max(weeks, 1),
          ),
        )
      : CELL_SIZE;
  const step = cellSize + GAP;
  const svgWidth = labelWidth + weeks * cellSize + Math.max(0, weeks - 1) * GAP;
  const svgHeight = headerHeight + 7 * cellSize + 6 * GAP;

  // Per-day text for the pointer tooltip; the data table below the grid
  // prints the same score with the same label (M2).
  const describeCell = (cell: (typeof cells)[number]): string => {
    if (!cell.cell) {
      return `${formatDay(cell.dateKey)}: ${t("insights.mood.heatmapNoEntry")}`;
    }
    const labelKey = moodLabelKeyForScore(Math.round(cell.cell.score));
    const moodLabel = labelKey ? t(labelKey) : "";
    return `${formatDay(cell.dateKey)}: ${cell.cell.score.toFixed(1)}${moodLabel ? ` · ${moodLabel}` : ""}`;
  };
  // Only the logged days go into the data table; the empty-tinted cells
  // are already covered by the aggregate summary on the SVG, so a rotor
  // user hears the days that carry a value rather than a wall of "no entry".
  const loggedCells = cells.filter((cell) => cell.cell !== null);

  return (
    <div className={`relative ${stretch ? "w-full" : ""}`} ref={containerRef}>
      <StretchFrame stretch={stretch} weeks={weeks}>
        <div
          className={
            stretch
              ? "w-full overflow-x-auto sm:w-full sm:overflow-visible"
              : "overflow-x-auto"
          }
        >
          <svg
            width={svgWidth}
            height={svgHeight}
            role="img"
            aria-label={summaryLabel}
            // v1.15.3 — `max-w-full` (not `w-full`) so a short window keeps its
            // natural, square, left-aligned grid rather than CSS-stretching a few
            // capped columns into wide rectangles. Mirrors `compliance-heatmap`.
            className={stretch ? "block max-w-full" : "block"}
            {...heatmapDay.svgProps}
          >
            {monthMarkers.map((m, i) => (
              <text
                key={i}
                x={labelWidth + m.col * step}
                y={11}
                className="fill-muted-foreground"
                fontSize={10}
              >
                {m.label}
              </text>
            ))}

            {!stretch &&
              WEEKDAY_LABELS.map(
                (label, i) =>
                  label && (
                    <text
                      key={i}
                      x={labelWidth - 6}
                      y={headerHeight + i * step + cellSize * 0.65}
                      textAnchor="end"
                      className="fill-muted-foreground"
                      fontSize={10}
                    >
                      {label}
                    </text>
                  ),
              )}

            {cells.map((cell) => (
              <rect
                key={cell.dateKey}
                x={labelWidth + cell.col * step}
                y={headerHeight + cell.row * step}
                width={cellSize}
                height={cellSize}
                rx={2}
                fill={cell.color}
                // v1.19.1 — populated days render at full saturation so the
                // mood band reads clearly; only the no-entry cells stay the
                // quiet `--secondary` empty-state tint.
                fillOpacity={1}
                // 2026-07-17 a11y audit (M2) — the per-day values reach
                // assistive tech through the data table below the grid, not
                // through the rects: a cell subtree nested under the SVG's
                // `role="img"` is pruned from the a11y tree, and per-cell tab
                // stops would flood the keyboard order on a year-long grid.
                // The rects stay a pure pointer affordance.
                {...heatmapDay.cellProps({
                  dateKey: cell.dateKey,
                  hasEntry: cell.cell !== null,
                  describe: () => describeCell(cell),
                })}
              />
            ))}
            {cells
              .filter((cell) => cell.dateKey === heatmapDay.openKey)
              .map((cell) => (
                <rect
                  key={`open-${cell.dateKey}`}
                  data-slot="heatmap-open-day"
                  x={labelWidth + cell.col * step - 1.5}
                  y={headerHeight + cell.row * step - 1.5}
                  width={cellSize + 3}
                  height={cellSize + 3}
                  rx={3}
                  pointerEvents="none"
                  {...OPEN_DAY_CELL}
                />
              ))}
          </svg>
        </div>
      </StretchFrame>

      {heatmapDay.tooltipNode}

      <div
        className="text-muted-foreground mt-2 flex flex-wrap items-center gap-3 text-xs"
        style={{ marginLeft: stretch ? 0 : labelWidth }}
      >
        {[
          {
            color: "var(--dracula-green)",
            label: t("insights.mood.legendGreat"),
          },
          {
            color: "var(--dracula-yellow)",
            label: t("insights.mood.legendGood"),
          },
          {
            color: "var(--dracula-orange)",
            label: t("insights.mood.legendOkay"),
          },
          { color: "var(--dracula-red)", label: t("insights.mood.legendLow") },
        ].map(({ color, label }) => (
          <span key={label} className="flex items-center gap-1">
            <div
              className="h-3 w-3 rounded-sm"
              style={{ backgroundColor: color }}
            />
            {label}
          </span>
        ))}
      </div>
      {loggedCells.length > 0 ? (
        <>
          <ChartDayCaption coarse={heatmapDay.coarse} mark="cell" rug={false} />
          {/* The keyboard and screen-reader way to each logged day's value,
              and to the day itself. */}
          <ChartDataTable
            points={loggedCells.map((cell) => ({
              date: cell.dateKey,
              timestamp: dayAnchor(cell.dateKey),
              score: cell.cell?.score,
            }))}
            columns={[{ key: "score", label: t("charts.moodScore") }]}
            formatValue={(value) => {
              const labelKey = moodLabelKeyForScore(Math.round(value));
              return labelKey
                ? `${value.toFixed(1)} · ${t(labelKey)}`
                : value.toFixed(1);
            }}
            formatDate={(date) => formatDay(dateOnlyKey(date))}
            bucket="day"
            metricLabel={t("insights.mood.heatmapTitle")}
            dayLinks
          />
        </>
      ) : null}
    </div>
  );
}

/** The stretch layout paints into the reserved box; the fixed one sizes itself. */
function StretchFrame({
  stretch,
  weeks,
  children,
}: {
  stretch: boolean;
  weeks: number;
  children: React.ReactNode;
}) {
  if (!stretch) return <>{children}</>;
  return <MoodHeatmapBody weeks={weeks}>{children}</MoodHeatmapBody>;
}
