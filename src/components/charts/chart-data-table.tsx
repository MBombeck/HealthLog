"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { ChartBucketType } from "@/lib/charts/bucket-time-series";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";

/**
 * The data points behind the chart, as a table.
 *
 * A chart shows the shape and hides the numbers. A doctor's appointment needs
 * the numbers, and so does anyone moving readings into a spreadsheet. This
 * renders the series the chart just drew, row per point, column per metric.
 *
 * It takes the FINALISED array — the same expression Recharts is handed, after
 * the range slice, the week/month bucketing and the display scale — and it
 * takes the chart's own value and date formatters as props. Nothing is
 * re-derived here, so the table cannot disagree with the line above it or with
 * the tooltip: they are the same numbers put through the same formatter.
 *
 * Derived overlays (moving average, trend line, comparison period) are NOT
 * columns. They are drawn from the points rather than measured, and a table of
 * "the data points behind the chart" that carried them would be claiming more
 * than the chart recorded.
 *
 * Collapsed by default: the chart is the primary read, and a hundred rows
 * expanded under every metric page would bury everything below it. The point
 * count rides in the trigger so the size is legible without opening. Once open
 * the region scrolls in its own box rather than growing the page.
 *
 * No Collapsible primitive exists in the UI kit, so this follows the same
 * button + region disclosure the glucose panel uses: `aria-expanded` on the
 * trigger, `aria-controls` / `hidden` on the region.
 */

/**
 * Structurally the chart's own `ChartDataPoint`. Declared here rather than
 * imported so the table stays independent of the chart module (which is behind
 * a lazy boundary and would otherwise import in a cycle).
 */
export interface ChartTablePoint {
  date: string;
  timestamp: number;
  [key: string]: string | number | undefined | [number, number];
}

export interface ChartDataTableColumn {
  /** The point key to read — a `MeasurementType` string. */
  key: string;
  /** Resolved column label, from the chart's own series-label helper. */
  label: string;
}

export interface ChartDataTableProps {
  /** The finalised points, in the chart's own order (oldest first). */
  points: readonly ChartTablePoint[];
  columns: readonly ChartDataTableColumn[];
  /** Display unit for every column; appended to each header when present. */
  unit?: string | undefined;
  /** The chart's value formatter — the one its tooltip uses. */
  formatValue: (value: number) => string;
  /** The chart's date formatter — the one its axis and tooltip use. */
  formatDate: (date: Date) => string;
  /** The grain of one row, so the caption never implies a daily reading. */
  bucket: ChartBucketType;
  /** Metric name for the table caption. */
  metricLabel: string;
}

const BUCKET_CAPTION_KEY: Record<ChartBucketType, string> = {
  day: "charts.dataTable.captionDay",
  week: "charts.dataTable.captionWeek",
  month: "charts.dataTable.captionMonth",
};

export function ChartDataTable({
  points,
  columns,
  unit,
  formatValue,
  formatDate,
  bucket,
  metricLabel,
}: ChartDataTableProps) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const regionId = useId();

  if (points.length === 0 || columns.length === 0) return null;

  // Newest first, matching the measurement list — the two places the app
  // prints the same readings must not disagree on reading order.
  const rows = [...points].reverse();

  return (
    <div
      data-slot="chart-data-table"
      className="border-border mt-3 border-t pt-3"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        data-slot="chart-data-table-toggle"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-full items-center justify-between gap-2 rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span>{t("charts.dataTable.toggle", { count: points.length })}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 transition-transform", open && "rotate-180")}
        />
      </button>

      <div
        id={regionId}
        hidden={!open}
        data-slot="chart-data-table-region"
        className="max-h-96 overflow-y-auto overscroll-contain pt-2"
      >
        <Table>
          <TableCaption className="mt-2 text-left text-xs">
            {t(BUCKET_CAPTION_KEY[bucket], { metric: metricLabel })}
            {/* Name the statistic where it is not the plain mean of the
                readings: a day of pulse is the mean of its hours' means. */}
            {columns
              .filter((column) => usesHourlyMeanDay(column.key))
              .map((column) => (
                <span
                  key={column.key}
                  data-slot="chart-data-table-statistic"
                  className="mt-1 block"
                >
                  {t("charts.dataTable.hourlyMeanNote", {
                    metric: column.label,
                  })}
                </span>
              ))}
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">
                {t("charts.dataTable.columnDate")}
              </TableHead>
              {columns.map((column) => (
                <TableHead key={column.key} scope="col" className="text-right">
                  {unit ? `${column.label} (${unit})` : column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((point) => (
              <TableRow key={point.timestamp} data-slot="chart-data-table-row">
                {/* The date is the row's header, so a screen reader reads
                    "12 July, systolic 128" rather than a bare number. */}
                <TableHead
                  scope="row"
                  className="text-foreground h-auto p-2 font-normal"
                >
                  {formatDate(new Date(point.timestamp))}
                </TableHead>
                {columns.map((column) => {
                  const value = point[column.key];
                  const numeric =
                    typeof value === "number" && Number.isFinite(value)
                      ? value
                      : null;
                  return (
                    <TableCell
                      key={column.key}
                      className="text-foreground text-right tabular-nums"
                    >
                      {numeric === null ? (
                        <>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">
                            {t("charts.dataTable.noValue")}
                          </span>
                        </>
                      ) : (
                        formatValue(numeric)
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
