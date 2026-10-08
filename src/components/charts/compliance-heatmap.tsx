"use client";

import { ChartDayCaption } from "@/components/day/chart-day";
import { dayAnchor } from "@/components/day/chart-day-links";
import { OPEN_DAY_CELL, useHeatmapDay } from "@/components/day/heatmap-day";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { ChartDataTable } from "./chart-data-table";
import { useState, useMemo, useEffect, useRef } from "react";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
import { heatmapDays } from "@/lib/charts/heatmap-days";

interface DailyData {
  expected: number;
  taken: number;
  skipped: number;
  onTime?: number;
  late?: number;
  veryLate?: number;
}

interface ComplianceHeatmapProps {
  dailyCompliance: Record<string, DailyData>;
  days?: number;
  stretch?: boolean;
}

const CELL_SIZE = 18;
const GAP = 3;
// v1.4.27 MB7 / CF-10 — cell-floor so the static heatmap never paints
// below the touch-friendly 14 px square on narrow viewports. The
// stretch branch computes an adaptive size; both branches clamp here.
const CELL_FLOOR_PX = 14;
// v1.15.3 — cell-ceiling for the stretch branch. With a short window (a
// single medication / few covered weeks → only ~5 columns) the adaptive
// `containerWidth / weeks` cell ballooned to fill a wide card, and since the
// grid is square the SVG height (`7 * cellSize + 6 * GAP`) blew up to ~3× the
// neighbouring tiles. Capping the cell keeps the grid dense + left-aligned
// (extra width is whitespace) so the heatmap holds the tile-height rhythm:
// height ≈ 18 + 7·22 + 6·3 = 190 px, in line with the surrounding tiles.
const CELL_CEIL_PX = 22;

function getColor(data: DailyData): string {
  if (data.expected === 0) return "var(--secondary)";

  const taken = data.taken;
  if (taken === 0) return "var(--dracula-red)";

  // When timing data is available, use it for color selection
  const hasTimingData =
    data.onTime !== undefined ||
    data.late !== undefined ||
    data.veryLate !== undefined;

  if (hasTimingData) {
    const veryLate = data.veryLate ?? 0;
    const late = data.late ?? 0;
    const missed = Math.max(0, data.expected - taken - data.skipped);

    // v1.4.34 IW-C — the v1.4.33 `looksClassifierBug` fallthrough is
    // gone because the root cause is fixed: `classifyIntakeTiming` now
    // routes proactive logs into the `early` bucket (counted as
    // compliant by the API) instead of flushing them to `very_late`.
    // Any missed doses → red
    if (missed > 0) return "var(--dracula-red)";
    // Any very late → deep orange
    if (veryLate > 0) return "var(--dracula-orange)";
    // Any late → yellow
    if (late > 0) return "var(--dracula-yellow)";
    // All on time (incl. early) → green
    return "var(--dracula-green)";
  }

  // Fallback: rate-based coloring when no timing data is supplied.
  const rate = (taken / data.expected) * 100;
  if (rate >= 100) return "var(--dracula-green)";
  if (rate >= 50) return "var(--dracula-yellow)";
  if (rate > 0) return "var(--dracula-orange)";
  return "var(--dracula-red)";
}

export function ComplianceHeatmap({
  dailyCompliance,
  days = 90,
  stretch = false,
}: ComplianceHeatmapProps) {
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
      data: DailyData;
    }> = [];

    // Oldest to newest, one entry per local day in the user's zone.
    const dates = heatmapDays(new Date(), timeZone, days);
    const firstDow = dates[0]?.dow ?? 0;

    let col = 0;
    const markers: Array<{ col: number; label: string }> = [];
    let lastMonth = -1;

    for (let i = 0; i < dates.length; i++) {
      const { dateKey, dow, month } = dates[i];
      const currentCol = Math.floor((i + firstDow) / 7);
      const row = dow;
      const data = dailyCompliance[dateKey] ?? {
        expected: 0,
        taken: 0,
        skipped: 0,
      };

      // Track month boundaries
      if (month !== lastMonth) {
        markers.push({ col: currentCol, label: MONTH_LABELS[month] });
        lastMonth = month;
      }

      cellList.push({
        dateKey,
        col: currentCol,
        row,
        color: getColor(data),
        data,
      });

      col = Math.max(col, currentCol);
    }

    return { cells: cellList, weeks: col + 1, monthMarkers: markers };
  }, [dailyCompliance, days, t, timeZone]);

  const activeDays = cells.filter((cell) => cell.data.expected > 0).length;
  const summaryLabel =
    cells.length === 0 || activeDays === 0
      ? t("charts.a11y.complianceHeatmapEmpty")
      : t("charts.a11y.complianceHeatmap", {
          start: formatDay(cells[0].dateKey),
          end: formatDay(cells[cells.length - 1].dateKey),
          days: activeDays,
        });

  const labelWidth = stretch ? 0 : 76;
  const headerHeight = 18;
  // v1.4.27 MB7 / CF-10 — clamp the stretch-branch adaptive cell to the
  // 14 px floor so the heatmap stays tap-friendly when the container
  // narrows. Static (non-stretch) instances use the canonical 18 px.
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
  // carries each active day's rate (M2).
  const describeCell = (cell: (typeof cells)[number]): string => {
    const rate =
      cell.data.expected > 0
        ? Math.min(
            100,
            Math.round((cell.data.taken / cell.data.expected) * 100),
          )
        : 0;
    const hasTimingData =
      cell.data.onTime !== undefined ||
      cell.data.late !== undefined ||
      cell.data.veryLate !== undefined;
    const timingInfo = hasTimingData
      ? ` | ${cell.data.onTime ?? 0} ${t("charts.heatmapOnTime")}, ${cell.data.late ?? 0} ${t("charts.heatmapLate")}, ${cell.data.veryLate ?? 0} ${t("charts.heatmapVeryLate")}`
      : "";
    return `${formatDay(cell.dateKey)}: ${cell.data.taken}/${cell.data.expected} (${rate}%)${timingInfo}`;
  };
  // Only days that carried a scheduled or taken dose go into the data
  // table; empty days are covered by the aggregate summary on the SVG.
  const activeCells = cells.filter(
    (cell) => cell.data.expected > 0 || cell.data.taken > 0,
  );

  return (
    <div className={`relative ${stretch ? "w-full" : ""}`} ref={containerRef}>
      {/* v1.4.27 MB7 / CF-10 — `overflow-x-auto` on `<sm` so the heatmap
          horizontal-scrolls inside its card instead of compressing the
          cells below the touch floor. The stretch branch already
          paints to container width on `>=sm`, so the scroll branch
          only kicks in for the non-stretch (static 18 px cell) case
          when the parent column is narrower than `weeks * 21 px`. */}
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
          // natural, square, left-aligned grid (the capped cells already size
          // off `containerWidth`, so a full window still fills the row) rather
          // than CSS-stretching ~5 columns of capped cells into wide rectangles.
          className={stretch ? "block max-w-full" : "block"}
          {...heatmapDay.svgProps}
        >
          {/* Month labels */}
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

          {/* Weekday labels */}
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

          {/* Cells — v1.4.27 MB7 / CF-10: tap-to-pin tooltip in
              parallel with the existing hover affordance. Mouse + pen
              users keep `onPointerEnter` / `onPointerLeave`; touch
              users tap the cell to pin and tap outside (or another
              cell) to move/clear. `pointerType === "touch"` discriminates
              so a hover dismiss never wipes a pinned tooltip. */}
          {cells.map((cell) => (
            <rect
              key={cell.dateKey}
              x={labelWidth + cell.col * step}
              y={headerHeight + cell.row * step}
              width={cellSize}
              height={cellSize}
              rx={2}
              fill={cell.color}
              // 2026-07-17 a11y audit (M2) — the per-day values reach
              // assistive tech through the data table below the grid, not
              // through the rects: a cell subtree nested under the SVG's
              // `role="img"` is pruned from the a11y tree, and per-cell tab
              // stops would flood the keyboard order on a year-long grid.
              // The rects stay a pure pointer affordance.
              {...heatmapDay.cellProps({
                dateKey: cell.dateKey,
                hasEntry: cell.data.expected > 0 || cell.data.taken > 0,
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

      {heatmapDay.tooltipNode}

      {/* Legend */}
      <div
        className="text-muted-foreground mt-2 flex flex-wrap items-center gap-3 text-xs"
        style={{ marginLeft: stretch ? 0 : labelWidth }}
      >
        {[
          { color: "var(--dracula-green)", label: t("charts.legendOnTime") },
          { color: "var(--dracula-yellow)", label: t("charts.legendLate") },
          { color: "var(--dracula-orange)", label: t("charts.legendVeryLate") },
          { color: "var(--dracula-red)", label: t("charts.legendMissed") },
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
      {activeCells.length > 0 ? (
        <>
          <ChartDayCaption coarse={heatmapDay.coarse} mark="cell" rug={false} />
          {/* The keyboard and screen-reader way to each active day's doses,
              and to the day itself. */}
          <ChartDataTable
            points={activeCells.map((cell) => ({
              date: cell.dateKey,
              timestamp: dayAnchor(cell.dateKey),
              rate:
                cell.data.expected > 0
                  ? Math.min(
                      100,
                      Math.round((cell.data.taken / cell.data.expected) * 100),
                    )
                  : undefined,
            }))}
            columns={[{ key: "rate", label: t("medications.compliance") }]}
            formatValue={(value) => `${value} %`}
            formatDate={(date) => formatDay(dateOnlyKey(date))}
            bucket="day"
            metricLabel={t("insights.medicationCompliance")}
            dayLinks
          />
        </>
      ) : null}
    </div>
  );
}
