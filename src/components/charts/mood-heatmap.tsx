"use client";

import { openDay } from "@/components/day/day-layer-controller";
import { isOpenableDay } from "@/components/day/day-url";
import { useTodayKey } from "@/components/day/use-today-key";
import { useCalendarDate } from "@/hooks/use-calendar-date";
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
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
    pinned?: boolean;
    /** v1.42 — the day a pinned (touch) tooltip offers to open. */
    day?: string;
  } | null>(null);
  // v1.42 — a click opens the day on a fine pointer; a tap pins the tooltip,
  // which then offers the day. The pointer type of the press decides.
  const lastPointer = useRef<string>("mouse");
  const today = useTodayKey();

  useEffect(() => {
    if (!tooltip?.pinned) return;
    const handlePointer = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(event.target as Node)) {
        setTooltip(null);
      }
    };
    document.addEventListener("pointerdown", handlePointer, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointer, true);
    };
  }, [tooltip?.pinned]);

  // 2026-07-17 a11y audit (M2) — Escape dismisses any open tooltip
  // (pinned touch tooltip or keyboard-focus tooltip), matching 1.4.13's
  // "dismissible" requirement.
  useEffect(() => {
    if (!tooltip) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTooltip(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [tooltip]);

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
  const headerHeight = 18;
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

  // Per-day text alternative, shared by the pointer tooltip and the
  // visually-hidden day list below the grid (M2). One source of truth so
  // the sr-only list never drifts from what a pointer user reads.
  const describeCell = (cell: (typeof cells)[number]): string => {
    if (!cell.cell) {
      return `${formatDay(cell.dateKey)}: ${t("insights.mood.heatmapNoEntry")}`;
    }
    const labelKey = moodLabelKeyForScore(Math.round(cell.cell.score));
    const moodLabel = labelKey ? t(labelKey) : "";
    return `${formatDay(cell.dateKey)}: ${cell.cell.score.toFixed(1)}${moodLabel ? ` · ${moodLabel}` : ""}`;
  };
  // Only the logged days go into the sr-only list; the empty-tinted cells
  // are already covered by the aggregate summary on the SVG, so a rotor
  // user hears the days that carry a value rather than a wall of "no entry".
  const loggedCells = cells.filter((cell) => cell.cell !== null);

  return (
    <div className={`relative ${stretch ? "w-full" : ""}`} ref={containerRef}>
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
          onMouseLeave={() =>
            setTooltip((prev) => (prev?.pinned ? prev : null))
          }
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

          {cells.map((cell) => {
            const buildText = (): string => describeCell(cell);
            return (
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
                className="cursor-pointer"
                data-day={cell.dateKey}
                // 2026-07-17 a11y audit (M2) — the per-day values reach
                // assistive tech through the visually-hidden day list below
                // the grid, not through the rects: a cell subtree nested
                // under the SVG's `role="img"` is pruned from the a11y tree,
                // and per-cell tab stops would flood the keyboard order on a
                // year-long grid. The rects stay a pure pointer affordance.
                onPointerEnter={(e) => {
                  if (e.pointerType === "touch") return;
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY,
                    text: buildText(),
                  });
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === "touch") return;
                  setTooltip((prev) => (prev?.pinned ? prev : null));
                }}
                onPointerDown={(e) => {
                  lastPointer.current = e.pointerType;
                  if (e.pointerType !== "touch") return;
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY,
                    text: buildText(),
                    pinned: true,
                    day:
                      cell.cell !== null && isOpenableDay(cell.dateKey, today)
                        ? cell.dateKey
                        : undefined,
                  });
                }}
                onClick={() => {
                  if (lastPointer.current === "touch") return;
                  if (cell.cell === null) return;
                  if (!isOpenableDay(cell.dateKey, today)) return;
                  setTooltip(null);
                  openDay(cell.dateKey, { trigger: containerRef.current });
                }}
              />
            );
          })}
        </svg>
      </div>

      {/* 2026-07-17 a11y audit (M2) — visually-hidden per-day list. The SVG
          carries an aggregate `role="img"` summary; this list is the
          keyboard/screen-reader path to the same granular values the pointer
          tooltip shows, without adding a tab stop per cell. */}
      {loggedCells.length > 0 && (
        <ul className="sr-only" data-slot="mood-heatmap-day-list">
          {loggedCells.map((cell) => (
            <li key={cell.dateKey}>{describeCell(cell)}</li>
          ))}
        </ul>
      )}

      {tooltip && (
        <div
          data-slot="mood-heatmap-tooltip"
          className={`bg-popover text-popover-foreground border-border fixed z-50 rounded-md border px-2 py-1 text-xs shadow-md ${
            tooltip.day ? "pointer-events-auto" : "pointer-events-none"
          }`}
          // Clamp the left edge so a tap near the right border doesn't push
          // the pinned label off-screen on a narrow viewport.
          style={{
            left:
              typeof window !== "undefined"
                ? Math.min(tooltip.x + 10, window.innerWidth - 180 - 8)
                : tooltip.x + 10,
            top: tooltip.y - 30,
          }}
        >
          {tooltip.text}
          {tooltip.day ? (
            <button
              type="button"
              data-slot="heatmap-open-day"
              onClick={() => {
                const day = tooltip.day;
                setTooltip(null);
                if (day) openDay(day, { trigger: containerRef.current });
              }}
              className="bg-muted hover:bg-muted/80 focus-visible:ring-ring/50 mt-1.5 flex min-h-11 w-full items-center justify-center rounded-md px-3 text-sm font-medium focus-visible:ring-[3px] focus-visible:outline-none"
            >
              {t("day.openDay")}
            </button>
          ) : null}
        </div>
      )}

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
    </div>
  );
}
