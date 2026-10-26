"use client";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DayLink, DayLinkAt } from "@/components/day/day-link";
import { formatDateOrRelative } from "@/lib/format";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { rawDisplayFractionDigits } from "@/lib/measurements/display-transform";
import { SortableHead } from "@/components/data-list";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { measurementUnitLabel } from "@/lib/measurements/unit-label";

import { MEASUREMENT_TYPE_COLORS as TYPE_COLORS } from "../measurement-list-meta";

import { DayDrillDown, SleepNightCaption } from "./day-drill-down";
import {
  MeasurementRowActions,
  rowState,
  typeLabel,
  type MeasurementRowContext,
} from "./row-actions";
import {
  formatMeasurementSource,
  sourceBadgeClass,
  truncateComment,
  type Measurement,
} from "./list-model";
import type { MeasurementListData } from "./use-measurement-list-data";
import type { MeasurementListFilters } from "./use-measurement-list-filters";

/** The desktop table: one row per reading, day or night, sortable columns. */
export function MeasurementTable({
  measurements,
  rows,
  filters,
  list,
}: {
  measurements: Measurement[];
  rows: MeasurementRowContext;
  filters: MeasurementListFilters;
  list: MeasurementListData;
}) {
  const { t } = useTranslations();
  const { canManage } = rows;
  const { sortBy, sortDir, toggleSort } = filters;
  const { selectAll, pageIds, onToggleSelectAll } = list;
  return (
    <div
      // `measurement-rows` marks the READ rows, not the list frame:
      // the filter rail above renders next to the loading
      // silhouettes as well, so it proves nothing about the data
      // having arrived. This wrapper exists only in the resolved,
      // non-empty branch, and the mobile list below carries the
      // same marker so a wait on it holds at any viewport.
      data-slot="measurement-rows"
      className="bg-card border-border hidden overflow-hidden rounded-lg border md:block"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10 pl-4">
              {/* Select all on the page. Bulk delete is the owner's alone,
                  so a delegate gets no selection column. */}
              {canManage && (
                <Checkbox
                  checked={
                    selectAll === "all"
                      ? true
                      : selectAll === "some"
                        ? "indeterminate"
                        : false
                  }
                  disabled={pageIds.length === 0}
                  onCheckedChange={onToggleSelectAll}
                  aria-label={t("dataList.selectAll")}
                />
              )}
            </TableHead>
            <TableHead className="w-28">{t("measurements.type")}</TableHead>
            <SortableHead
              column="value"
              label={t("measurements.value")}
              currentSort={sortBy}
              currentDir={sortDir}
              onSort={toggleSort}
            />
            <SortableHead
              column="measuredAt"
              label={t("measurements.date")}
              currentSort={sortBy}
              currentDir={sortDir}
              onSort={toggleSort}
            />
            <TableHead className="w-56">{t("measurements.comment")}</TableHead>
            <SortableHead
              column="source"
              label={t("measurements.source")}
              currentSort={sortBy}
              currentDir={sortDir}
              onSort={toggleSort}
              className="w-20"
            />
            <TableHead className="w-20 pr-4 text-right">
              {t("measurements.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {measurements.map((m) => (
            <MeasurementTableRow key={m.id} m={m} rows={rows} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One table row, and under a grouped row its open drill-down. */
function MeasurementTableRow({
  m,
  rows,
}: {
  m: Measurement;
  rows: MeasurementRowContext;
}) {
  const { canManage, onToggleRow, navigateForType, display } = rows;
  const { isGrouped, isSelected, isExpanded } = rowState(m, rows);
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { rowDisplay, rowIdentityAttrs } = display;
  // A sleep night is grouped (its chevron opens the stage segments) but
  // reads as a duration with a nap caption, not as a daily total.
  const isSleep = m.type === "SLEEP_DURATION";
  // A stable id, so the chevron's `aria-controls` names the panel it opens.
  const drilldownId = `drilldown-desktop-${m.dayKey ?? m.id}`;
  const label = typeLabel(m.type, t);
  return (
    <>
      <TableRow
        data-state={isSelected ? "selected" : undefined}
        // A row is addressable by what it holds, not by the copy it paints:
        // the type is an enum and the unit a symbol, so a browser journey can
        // pin "this glucose reading now reads in mmol/L" without matching
        // translated text.
        {...rowIdentityAttrs(m, isGrouped)}
        data-display-unit={isGrouped ? m.unit : rowDisplay(m).unit}
      >
        <TableCell className="pl-4">
          {/* A grouped row is not individually deletable: no checkbox. */}
          {!isGrouped && canManage && (
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleRow(m.id)}
              aria-label={t("dataList.selectRow")}
            />
          )}
        </TableCell>
        <TableCell>
          <Badge
            asChild
            variant="secondary"
            className={`focus-visible:ring-ring/50 cursor-pointer transition-colors focus-visible:ring-2 focus-visible:outline-none ${TYPE_COLORS[m.type] ?? ""}`.trim()}
          >
            <button
              type="button"
              onClick={() => navigateForType(m.type)}
              aria-label={t("measurements.openMetricInsights", {
                type: label,
              })}
            >
              {label}
            </button>
          </Badge>
        </TableCell>
        <TableCell
          className="font-semibold tabular-nums"
          data-slot="measurement-row-value"
        >
          {/* A reading keeps its native precision (78.4 kg stays 78.4); a
              day total of a cumulative type is a whole number; a night
              reads as a duration ("8h 12m") with its nap caption. */}
          {isSleep ? (
            <>
              {formatDurationMinutes(m.value, t)}
              <SleepNightCaption m={m} />
            </>
          ) : (
            <>
              {isGrouped
                ? fmt.integer(m.value)
                : fmt.number(
                    rowDisplay(m).value,
                    rawDisplayFractionDigits(m.type),
                  )}{" "}
              {measurementUnitLabel(
                m.type,
                isGrouped ? m.unit : rowDisplay(m).unit,
                t,
              )}
              {isGrouped && (
                <span className="text-muted-foreground ml-2 text-xs font-normal">
                  {t("measurements.dailyTotalCaption", {
                    count: fmt.integer(m.sampleCount as number),
                  })}
                </span>
              )}
            </>
          )}
        </TableCell>
        {/* Relative inside the last 24 hours ("3 min ago"), so the list and
            the dashboard never phrase "when" differently. The date opens its
            day; the row keeps opening the reading. */}
        <TableCell className="text-muted-foreground text-sm">
          {m.dayKey !== undefined ? (
            <DayLink date={m.dayKey}>
              {formatDateOrRelative(m.measuredAt, t)}
            </DayLink>
          ) : (
            <DayLinkAt at={m.measuredAt}>
              {formatDateOrRelative(m.measuredAt, t)}
            </DayLinkAt>
          )}
        </TableCell>
        <TableCell className="text-sm">
          {m.notes ? (
            <span title={m.notes}>{truncateComment(m.notes)}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
        <TableCell>
          {m.source !== "MANUAL" && (
            <Badge
              variant="outline"
              data-testid="measurement-source-badge"
              className={`text-xs ${sourceBadgeClass(m.source)}`.trim()}
            >
              {formatMeasurementSource(m.source, t)}
            </Badge>
          )}
        </TableCell>
        <TableCell className="pr-4 text-right">
          <div className="flex items-center justify-end gap-1">
            <MeasurementRowActions
              m={m}
              rows={rows}
              isGrouped={isGrouped}
              isExpanded={isExpanded}
              drilldownId={drilldownId}
              layout="desktop"
            />
          </div>
        </TableCell>
      </TableRow>
      {isGrouped && isExpanded && (
        <TableRow id={drilldownId}>
          <TableCell colSpan={7} className="p-0">
            <DayDrillDown
              type={m.type}
              dayKey={m.dayKey as string}
              unit={m.unit}
              layout="desktop"
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
