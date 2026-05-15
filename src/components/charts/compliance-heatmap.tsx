"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useTranslations } from "@/lib/i18n/context";

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
  // v1.4.27 B7 / BL-P4-2 — parse the day-key against UTC so the
  // formatted tooltip label matches the dateKey computation below
  // (which uses `toISOString().slice(0, 10)`). Without the UTC
  // anchor an SSR server in a non-Berlin timezone could format the
  // tick a day off the dateKey it sits under.
  const d = new Date(dateStr + "T00:00:00Z");
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;
}

export function ComplianceHeatmap({
  dailyCompliance,
  days = 90,
  stretch = false,
}: ComplianceHeatmapProps) {
  const { t } = useTranslations();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
    /**
     * v1.4.27 MB7 / CF-10 — when `pinned` the tooltip stays mounted
     * across `onPointerLeave` so a touch user sees the per-cell
     * breakdown after lifting their finger. Mouse + pen users get the
     * existing hover-only experience because their interactions never
     * set `pinned`. A second tap on a different cell repositions the
     * tooltip; a tap outside any cell clears it (wired below).
     */
    pinned?: boolean;
  } | null>(null);

  // v1.4.27 MB7 / CF-10 — outside-click dismisses a pinned tooltip so a
  // touch user can clear the per-cell detail without scrolling the
  // pinned label off-screen. The listener is gated on `tooltip?.pinned`
  // so the non-touch hover flow never pays the indirection cost.
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

    // Start from the first date, align to Monday.
    //
    // v1.4.27 B7 / BL-P4-2 — read every weekday + month boundary off
    // the UTC accessor pair (`getUTCDay`, `getUTCMonth`) so the
    // computation matches the dateKey, which is also UTC-anchored
    // (`toISOString().slice(0, 10)`). Reading in server-tz here would
    // shift the Monday-alignment + month-marker placement when the
    // SSR pass runs on a server in a non-Berlin timezone.
    const firstDate = dates[0];
    const firstDow = (firstDate.getUTCDay() + 6) % 7; // Monday = 0

    let col = 0;
    const markers: Array<{ col: number; label: string }> = [];
    let lastMonth = -1;

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
      const currentCol = Math.floor((i + firstDow) / 7);
      const row = dow;
      const dateKey = date.toISOString().slice(0, 10);
      const data = dailyCompliance[dateKey] ?? {
        expected: 0,
        taken: 0,
        skipped: 0,
      };

      // Track month boundaries
      const month = date.getUTCMonth();
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
  }, [dailyCompliance, days, t]);

  const labelWidth = stretch ? 0 : 76;
  const headerHeight = 18;
  // v1.4.27 MB7 / CF-10 — clamp the stretch-branch adaptive cell to the
  // 14 px floor so the heatmap stays tap-friendly when the container
  // narrows. Static (non-stretch) instances use the canonical 18 px.
  const cellSize =
    stretch && containerWidth > 0
      ? Math.max(
          CELL_FLOOR_PX,
          (containerWidth - labelWidth - Math.max(0, weeks - 1) * GAP) /
            Math.max(weeks, 1),
        )
      : CELL_SIZE;
  const step = cellSize + GAP;
  const svgWidth = labelWidth + weeks * cellSize + Math.max(0, weeks - 1) * GAP;
  const svgHeight = headerHeight + 7 * cellSize + 6 * GAP;

  return (
    <div className={`relative ${stretch ? "w-full" : ""}`} ref={containerRef}>
      {/* v1.4.27 MB7 / CF-10 — `overflow-x-auto` on `<sm` so the heatmap
          horizontal-scrolls inside its card instead of compressing the
          cells below the touch floor. The stretch branch already
          paints to container width on `>=sm`, so the scroll branch
          only kicks in for the non-stretch (static 18 px cell) case
          when the parent column is narrower than `weeks * 21 px`. */}
      <div
        className={stretch ? "w-full sm:w-full overflow-x-auto sm:overflow-visible" : "overflow-x-auto"}
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          className={stretch ? "block w-full" : "block"}
          onMouseLeave={() => setTooltip((prev) => (prev?.pinned ? prev : null))}
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
          {cells.map((cell) => {
            const buildText = (): string => {
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
              return `${formatDateDE(cell.dateKey)}: ${cell.data.taken}/${cell.data.expected} (${rate}%)${timingInfo}`;
            };
            return (
              <rect
                key={cell.dateKey}
                x={labelWidth + cell.col * step}
                y={headerHeight + cell.row * step}
                width={cellSize}
                height={cellSize}
                rx={2}
                fill={cell.color}
                className="cursor-pointer"
                onPointerEnter={(e) => {
                  // Touch enter fires synthetically immediately before
                  // `pointerdown`; skip it so the pinned tooltip below
                  // takes precedence with its real coordinates.
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
                  if (e.pointerType !== "touch") return;
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY,
                    text: buildText(),
                    pinned: true,
                  });
                }}
              />
            );
          })}
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
    </div>
  );
}
