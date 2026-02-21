"use client";

import { useState, useMemo, useEffect, useRef } from "react";

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
const WEEKDAY_LABELS = ["Mo", "", "Mi", "", "Fr", "", "So"];
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mär",
  "Apr",
  "Mai",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Okt",
  "Nov",
  "Dez",
];

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

    // Any missed doses → red
    if (missed > 0) return "var(--dracula-red)";
    // Any very late → deep orange
    if (veryLate > 0) return "var(--dracula-orange)";
    // Any late → yellow
    if (late > 0) return "var(--dracula-yellow)";
    // All on time → green
    return "var(--dracula-green)";
  }

  // Fallback: rate-based coloring (no timing data)
  const rate = (taken / data.expected) * 100;
  if (rate >= 100) return "var(--dracula-green)";
  if (rate >= 50) return "var(--dracula-yellow)";
  if (rate > 0) return "var(--dracula-orange)";
  return "var(--dracula-red)";
}

function formatDateDE(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

export function ComplianceHeatmap({
  dailyCompliance,
  days = 90,
  stretch = false,
}: ComplianceHeatmapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

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
    const now = new Date();
    const cellList: Array<{
      dateKey: string;
      col: number;
      row: number;
      color: string;
      data: DailyData;
    }> = [];

    // Build array of dates from oldest to newest
    const dates: Date[] = [];
    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      dates.push(date);
    }

    // Start from the first date, align to Monday
    const firstDate = dates[0];
    const firstDow = (firstDate.getDay() + 6) % 7; // Monday = 0

    let col = 0;
    const markers: Array<{ col: number; label: string }> = [];
    let lastMonth = -1;

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const dow = (date.getDay() + 6) % 7; // Monday = 0
      const currentCol = Math.floor((i + firstDow) / 7);
      const row = dow;
      const dateKey = date.toISOString().slice(0, 10);
      const data = dailyCompliance[dateKey] ?? {
        expected: 0,
        taken: 0,
        skipped: 0,
      };

      // Track month boundaries
      const month = date.getMonth();
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
  }, [dailyCompliance, days]);

  const labelWidth = stretch ? 0 : 76;
  const headerHeight = 18;
  const cellSize =
    stretch && containerWidth > 0
      ? Math.max(
          8,
          (containerWidth - labelWidth - Math.max(0, weeks - 1) * GAP) /
            Math.max(weeks, 1),
        )
      : CELL_SIZE;
  const step = cellSize + GAP;
  const svgWidth = labelWidth + weeks * cellSize + Math.max(0, weeks - 1) * GAP;
  const svgHeight = headerHeight + 7 * cellSize + 6 * GAP;

  return (
    <div
      className={`relative ${stretch ? "w-full" : ""}`}
      ref={containerRef}
    >
      <div className={stretch ? "w-full" : "overflow-x-auto"}>
        <svg
          width={svgWidth}
          height={svgHeight}
          className={stretch ? "block w-full" : "block"}
          onMouseLeave={() => setTooltip(null)}
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

          {/* Cells */}
          {cells.map((cell) => (
            <rect
              key={cell.dateKey}
              x={labelWidth + cell.col * step}
              y={headerHeight + cell.row * step}
              width={cellSize}
              height={cellSize}
              rx={2}
              fill={cell.color}
              className="cursor-pointer"
              onMouseEnter={(e) => {
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
                  ? ` | ${cell.data.onTime ?? 0} pünktlich, ${cell.data.late ?? 0} spät, ${cell.data.veryLate ?? 0} sehr spät`
                  : "";
                setTooltip({
                  x: e.clientX,
                  y: e.clientY,
                  text: `${formatDateDE(cell.dateKey)}: ${cell.data.taken}/${cell.data.expected} (${rate}%)${timingInfo}`,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          ))}
        </svg>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="bg-popover text-popover-foreground border-border pointer-events-none fixed z-50 rounded-md border px-2 py-1 text-xs shadow-md"
          style={{ left: tooltip.x + 10, top: tooltip.y - 30 }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Legend */}
      <div
        className="text-muted-foreground mt-2 flex flex-wrap items-center gap-3 text-xs"
        style={{ marginLeft: stretch ? 0 : labelWidth }}
      >
        {[
          { color: "var(--dracula-green)", label: "Pünktlich" },
          { color: "var(--dracula-yellow)", label: "Spät" },
          { color: "var(--dracula-orange)", label: "Sehr spät" },
          { color: "var(--dracula-red)", label: "Verpasst" },
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
