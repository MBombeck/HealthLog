"use client";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DayLink, DayLinkAt } from "@/components/day/day-link";
import { formatDateOrRelative } from "@/lib/format";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { rawDisplayFractionDigits } from "@/lib/measurements/display-transform";
import { ListRow } from "@/components/ui/list-row";
import { measurementUnitMetaLead } from "@/lib/measurements/unit-label";

import {
  MEASUREMENT_TYPE_COLORS as TYPE_COLORS,
  MEASUREMENT_TYPE_ICONS as TYPE_ICONS,
} from "../measurement-list-meta";

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

/** The phone list: one card per reading, day or night. */
export function MeasurementCardList({
  measurements,
  rows,
}: {
  measurements: Measurement[];
  rows: MeasurementRowContext;
}) {
  return (
    <div data-slot="measurement-rows" className="space-y-2 md:hidden">
      {measurements.map((m) => (
        <MeasurementCard key={m.id} m={m} rows={rows} />
      ))}
    </div>
  );
}

/** One card, and under a grouped card its open drill-down. */
function MeasurementCard({
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
  const Icon = TYPE_ICONS[m.type];
  const isSleep = m.type === "SLEEP_DURATION";
  const drilldownId = `drilldown-mobile-${m.dayKey ?? m.id}`;
  const label = typeLabel(m.type, t);
  // The unit is meta: on a phone a long one ("Atemzüge/min") beside the
  // value pushed the row's controls, so it leads the meta line instead. A
  // night reads as a duration and has none.
  const unitLead = isSleep
    ? null
    : measurementUnitMetaLead(
        m.type,
        isGrouped ? m.unit : rowDisplay(m).unit,
        t,
      );
  return (
    <ListRow
      data-state={isSelected ? "selected" : undefined}
      // The same addressing contract as the desktop row.
      {...rowIdentityAttrs(m, isGrouped)}
      data-display-unit={isGrouped ? m.unit : rowDisplay(m).unit}
      className="bg-card border-border data-[state=selected]:border-primary/60 data-[state=selected]:bg-primary/5"
    >
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {!isGrouped && canManage && (
            // The checkbox owns its 44 px hit area through an `after`
            // hit-slop inside a plain layout `<div>`: a wrapper `<button>`
            // would nest a button in a button, invalid markup that failed
            // hydration on every list paint.
            <div className="flex size-11 shrink-0 items-center justify-center">
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => onToggleRow(m.id)}
                aria-label={t("dataList.selectRow")}
                className="relative after:absolute after:-inset-3.5"
              />
            </div>
          )}
          {Icon && (
            <button
              type="button"
              onClick={() => navigateForType(m.type)}
              aria-label={t("measurements.openMetricInsights", {
                type: label,
              })}
              className={`focus-visible:ring-ring/50 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none ${TYPE_COLORS[m.type] ?? ""}`}
            >
              <Icon className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            {/* The type names the row: without it two readings in the same
                unit ("55 ms" HRV and "63 ms" RMSSD) could not be told apart
                on a phone, where the table's type column does not exist. */}
            <p
              className="truncate text-xs font-medium"
              data-slot="measurement-row-type"
            >
              {label}
            </p>
            <span
              className="font-semibold tabular-nums"
              data-slot="measurement-row-value"
            >
              {isSleep
                ? formatDurationMinutes(m.value, t)
                : isGrouped
                  ? fmt.integer(m.value)
                  : fmt.number(
                      rowDisplay(m).value,
                      rawDisplayFractionDigits(m.type),
                    )}
            </span>
            {isSleep ? (
              <SleepNightCaption m={m} />
            ) : (
              isGrouped && (
                <span className="text-muted-foreground ml-1.5 text-xs">
                  {t("measurements.dailyTotalCaption", {
                    count: fmt.integer(m.sampleCount as number),
                  })}
                </span>
              )
            )}
            {/* The meta line wraps rather than truncates: cut short it hid
                the day it opens and the source beside it. */}
            <p className="text-muted-foreground text-xs">
              {unitLead ? (
                <span
                  data-slot="measurement-row-unit"
                  className="whitespace-nowrap"
                >
                  {unitLead}
                </span>
              ) : null}
              {m.dayKey !== undefined ? (
                <DayLink date={m.dayKey} className="whitespace-nowrap">
                  {formatDateOrRelative(m.measuredAt, t)}
                </DayLink>
              ) : (
                <DayLinkAt at={m.measuredAt} className="whitespace-nowrap">
                  {formatDateOrRelative(m.measuredAt, t)}
                </DayLinkAt>
              )}
              {m.source !== "MANUAL" && (
                <Badge
                  variant="outline"
                  data-testid="measurement-source-badge"
                  className={`ml-1.5 h-4 px-1 text-xs ${sourceBadgeClass(m.source)}`.trim()}
                >
                  {formatMeasurementSource(m.source, t)}
                </Badge>
              )}
            </p>
            {m.notes && (
              // User data is never muted; the table renders the same note in
              // the foreground colour.
              <p className="text-foreground truncate text-xs">
                {truncateComment(m.notes)}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <MeasurementRowActions
            m={m}
            rows={rows}
            isGrouped={isGrouped}
            isExpanded={isExpanded}
            drilldownId={drilldownId}
            layout="mobile"
          />
        </div>
      </div>
      {isGrouped && isExpanded && (
        <div id={drilldownId}>
          <DayDrillDown
            type={m.type}
            dayKey={m.dayKey as string}
            unit={m.unit}
            layout="mobile"
          />
        </div>
      )}
    </ListRow>
  );
}
