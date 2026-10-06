"use client";

/**
 * v1.39.4 — one table of values a Coach turn read.
 *
 * A title row (title, then the meta line when the caller passes one, with
 * copy and the caller's toolbar beside it) above the table, so the controls
 * stay on screen however wide the table scrolls; the table keeps the title
 * as a visually hidden caption. Numbers are right-aligned in tabular
 * figures, a period without a reading shows as "—" and is announced as "no
 * reading". Twelve rows show — the latest twelve periods of a time series,
 * still oldest first, and the first twelve rows of any other table; a
 * "Show all (n)" button opens every row in a scrolling region whose header
 * row stays put.
 *
 * Periods are calendar days (or the Monday of a week, or a month), so they
 * are spelled by the UTC-pinned bucket formatters: the label names the day
 * the server keyed, in the reader's date order, whatever their zone.
 */
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import { COACH_RESULT_UI_KEYS } from "@/lib/ai/coach/dialog-keys";
import type {
  CoachResultCell,
  CoachResultColumn,
  CoachResultTable as CoachResultTableData,
} from "@/lib/ai/coach/types";
import type { ClipboardGrid } from "@/lib/insights/coach-result-clipboard";
import { cn } from "@/lib/utils";

import { CopyTableButton } from "./copy-table-button";

/** Rows shown before "Show all". */
export const RESULT_TABLE_PREVIEW_ROWS = 12;

export interface CoachResultTableProps {
  result: CoachResultTableData;
  /** A meta line for this table (where it came from), shown under the title. */
  method?: ReactNode;
  /** Controls shown beside the copy button (the chart/table toggle). */
  toolbar?: ReactNode;
}

type CellFormatter = (
  cell: CoachResultCell,
  column: CoachResultColumn,
) => string | null;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

function isNumeric(column: CoachResultColumn): boolean {
  return column.kind === "number" || column.kind === "count";
}

/**
 * The formatter a table's cells go through, for the screen and the
 * clipboard alike. `grouped` adds thousands separators to counts on screen;
 * the clipboard leaves them out so a spreadsheet reads a number.
 */
function useCellFormatter(): (grouped: boolean) => CellFormatter {
  const { locale } = useTranslations();
  const dateFormat = useDateFormatPreference();
  return useMemo(() => {
    const fmt = makeBucketLabelFormatters(locale, dateFormat);
    const month = new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return (grouped: boolean): CellFormatter =>
      (cell, column) => {
        if (cell === null) return null;
        if (typeof cell === "number") {
          if (column.kind === "count") {
            return grouped ? fmt.integer(cell) : fmt.number(cell, 0);
          }
          return fmt.number(cell, column.decimals ?? 1);
        }
        if (column.kind === "period") {
          if (DAY_KEY.test(cell)) {
            return fmt.date(new Date(`${cell}T12:00:00Z`));
          }
          if (MONTH_KEY.test(cell)) {
            return month.format(new Date(`${cell}-01T12:00:00Z`));
          }
        }
        return cell;
      };
  }, [locale, dateFormat]);
}

/**
 * The rows shown before "Show all". A time series is chronological and the
 * latest periods are what the answer is about, so it previews its last
 * twelve (still oldest first); any other table previews its first twelve.
 */
function previewRows(
  result: Pick<CoachResultTableData, "shape" | "rows">,
): CoachResultCell[][] {
  return result.shape === "timeSeries"
    ? result.rows.slice(-RESULT_TABLE_PREVIEW_ROWS)
    : result.rows.slice(0, RESULT_TABLE_PREVIEW_ROWS);
}

function headingText(column: CoachResultColumn): string {
  return column.unit ? `${column.label} (${column.unit})` : column.label;
}

export function CoachResultTable({
  result,
  method,
  toolbar,
}: CoachResultTableProps) {
  const { t } = useTranslations();
  const formatter = useCellFormatter();
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const regionId = useId();

  const format = useMemo(() => formatter(true), [formatter]);
  const hasMore = result.rows.length > RESULT_TABLE_PREVIEW_ROWS;
  const rows = expanded ? result.rows : previewRows(result);

  const grid = useCallback((): ClipboardGrid => {
    const plain = formatter(false);
    return {
      header: result.columns.map(headingText),
      rows: result.rows.map((row) =>
        result.columns.map((column, index) =>
          plain(row[index] ?? null, column),
        ),
      ),
      alignRight: result.columns.map(isNumeric),
    };
  }, [formatter, result.columns, result.rows]);

  const noReading = t(COACH_RESULT_UI_KEYS.noReading);

  return (
    <div
      data-slot="coach-result-table"
      data-ref={result.ref}
      className="bg-card w-full min-w-0 rounded-lg border"
    >
      <div
        data-slot="coach-result-table-header"
        className="flex items-start justify-between gap-3 px-3 pt-2 pb-1 text-sm"
      >
        <div className="min-w-0 flex-1 pt-1.5">
          <p id={titleId} className="text-foreground font-medium">
            {result.title}
          </p>
          {method ? (
            <p className="text-muted-foreground text-xs">{method}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <CopyTableButton grid={grid} caption={result.title} />
          {toolbar}
        </div>
      </div>
      <div
        id={regionId}
        data-slot="coach-result-table-scroll"
        // The region scrolls sideways on a narrow screen even when collapsed,
        // so it is always reachable from the keyboard.
        role="region"
        tabIndex={0}
        aria-labelledby={titleId}
        className={cn(
          "focus-visible:ring-input-focus overflow-x-auto rounded-b-lg outline-none focus-visible:ring-2",
          expanded && "max-h-96 overflow-y-auto overscroll-contain",
        )}
      >
        <table className="w-full text-sm">
          <caption className="sr-only">
            {result.title}
            {method ? <>. {method}</> : null}
          </caption>
          <TableHeader className="bg-card sticky top-0 z-10">
            <TableRow className="hover:bg-transparent">
              {result.columns.map((column) => (
                <TableHead
                  key={column.key}
                  scope="col"
                  className={cn("h-9 px-3", isNumeric(column) && "text-right")}
                >
                  {column.label}
                  {column.unit ? (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      ({column.unit})
                    </span>
                  ) : null}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIndex) => (
              <TableRow key={`${String(row[0])}-${rowIndex}`}>
                {result.columns.map((column, index) => {
                  const text = format(row[index] ?? null, column);
                  return (
                    <TableCell
                      key={column.key}
                      className={cn(
                        "px-3 py-1.5",
                        isNumeric(column) && "text-right tabular-nums",
                      )}
                    >
                      {text === null ? (
                        <>
                          <span
                            className="text-muted-foreground"
                            aria-hidden="true"
                          >
                            —
                          </span>
                          <span className="sr-only">{noReading}</span>
                        </>
                      ) : (
                        text
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </table>
      </div>
      {hasMore || result.truncated ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5">
          {result.truncated ? (
            <p className="text-muted-foreground text-xs">
              {t(COACH_RESULT_UI_KEYS.truncated, {
                shown: result.rows.length,
                total: result.rowCount,
              })}
            </p>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 sm:min-h-9"
              aria-expanded={expanded}
              aria-controls={regionId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded
                ? t(COACH_RESULT_UI_KEYS.showFewer)
                : t(COACH_RESULT_UI_KEYS.showAll, {
                    count: result.rows.length,
                  })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
