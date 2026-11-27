"use client";

import { StickyNote } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { DayLink, DayLinkAt } from "@/components/day/day-link";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { formatRelativeShort } from "@/lib/i18n/relative-time";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { rawDisplayFractionDigits } from "@/lib/measurements/display-transform";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { measurementUnitLabel } from "@/lib/measurements/unit-label";
import { metricName } from "@/lib/measurements/type-label-keys";
import { ShortName } from "@/components/ui/short-name";

import {
  MEASUREMENT_TYPE_COLORS as TYPE_COLORS,
  MEASUREMENT_TYPE_ICONS as TYPE_ICONS,
} from "../measurement-list-meta";

import { DayDrillDown, SleepNightCaption } from "./day-drill-down";
import {
  isServerComputed,
  rowState,
  type MeasurementRowContext,
} from "./row-actions";
import { formatMeasurementSource, type Measurement } from "./list-model";

/**
 * The phone list: one card, one row per reading, day or night (UI standards
 * §20). A reading's row opens its edit sheet, whose "⋯" holds delete; a
 * day's or night's row opens its samples underneath. The row carries no
 * edit or delete buttons of its own.
 */
export function MeasurementCardList({
  measurements,
  rows,
}: {
  measurements: Measurement[];
  rows: MeasurementRowContext;
}) {
  return (
    <ListGroup data-slot="measurement-rows" className="md:hidden">
      {measurements.map((m) => (
        <MeasurementRow key={m.id} m={m} rows={rows} />
      ))}
    </ListGroup>
  );
}

/** One row, and under a grouped row its open drill-down. */
function MeasurementRow({
  m,
  rows,
}: {
  m: Measurement;
  rows: MeasurementRowContext;
}) {
  const {
    canManage,
    selecting,
    onToggleRow,
    navigateForType,
    display,
    toggleExpand,
    startEdit,
  } = rows;
  const { isGrouped, isSelected, isExpanded } = rowState(m, rows);
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const { rowDisplay, rowIdentityAttrs } = display;
  const Icon = TYPE_ICONS[m.type];
  const isSleep = m.type === "SLEEP_DURATION";
  const drilldownId = `drilldown-mobile-${m.dayKey ?? m.id}`;
  const name = metricName(m.type, t);
  const editable = !isGrouped && !isServerComputed(m) && canManage;
  // Selection is a mode (the list's "⋯" › Select), not a box on every row.
  const selectable = editable && !!selecting;
  // The unit stands with its value, muted; a night reads as a duration and
  // has none.
  const unit = isSleep
    ? null
    : measurementUnitLabel(m.type, isGrouped ? m.unit : rowDisplay(m).unit, t);
  const value = isSleep
    ? formatDurationMinutes(m.value, t)
    : isGrouped
      ? fmt.integer(m.value)
      : fmt.number(rowDisplay(m).value, rawDisplayFractionDigits(m.type));
  const when = formatRelativeShort(m.measuredAt, t, locale, fmt);
  const select = isGrouped
    ? { onSelect: () => toggleExpand(m.dayKey as string) }
    : selectable
      ? { onSelect: () => onToggleRow(m.id) }
      : editable
        ? { onSelect: () => startEdit(m) }
        : {};
  return (
    <ListItem
      data-state={isSelected ? "selected" : undefined}
      // The same addressing contract as the desktop row.
      {...rowIdentityAttrs(m, isGrouped)}
      data-display-unit={isGrouped ? m.unit : rowDisplay(m).unit}
      className="data-[state=selected]:bg-primary/5"
      {...select}
      expanded={isGrouped ? isExpanded : undefined}
      controls={isGrouped ? drilldownId : undefined}
      actionLabel={
        isGrouped
          ? isExpanded
            ? t("measurements.collapseDay")
            : t("measurements.expandDay")
          : undefined
      }
      chevron={!selectable}
      leading={
        selectable ? (
          // The checkbox owns its 44 px hit area through an `after` hit-slop.
          <div className="-ml-2 flex size-11 items-center justify-center">
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleRow(m.id)}
              aria-label={t("dataList.selectRow")}
              className="relative after:absolute after:-inset-3.5"
            />
          </div>
        ) : undefined
      }
      icon={
        Icon ? (
          <button
            type="button"
            onClick={() => navigateForType(m.type)}
            aria-label={t("measurements.openMetricInsights", {
              type: name.full,
            })}
            className={`focus-visible:ring-ring/50 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none ${TYPE_COLORS[m.type] ?? ""}`}
          >
            <Icon className="h-4 w-4" />
          </button>
        ) : undefined
      }
      // The type names the row: without it two readings in the same unit
      // ("55 ms" HRV and "63 ms" RMSSD) could not be told apart on a phone,
      // where the table's type column does not exist.
      title={
        <span data-slot="measurement-row-type" title={name.full}>
          <ShortName short={name.short} full={name.full} />
        </span>
      }
      // When, then where from: "vor 7 Std., Withings".
      meta={
        <>
          {m.dayKey !== undefined ? (
            <DayLink date={m.dayKey}>{when}</DayLink>
          ) : (
            <DayLinkAt at={m.measuredAt}>{when}</DayLinkAt>
          )}
          {isGrouped && !isSleep ? (
            <>
              {", "}
              {t("measurements.dailyTotalCaption", {
                count: fmt.integer(m.sampleCount as number),
              })}
            </>
          ) : null}
          {isSleep ? <SleepNightCaption m={m} /> : null}
          {m.source !== "MANUAL" ? (
            <span data-testid="measurement-source-badge">
              {", "}
              {formatMeasurementSource(m.source, t)}
            </span>
          ) : null}
          {m.notes ? (
            // The note is the person's own text; the row says one is there,
            // the edit sheet shows it.
            <StickyNote
              className="text-foreground ml-1 inline size-3 align-[-2px]"
              aria-label={t("common.note")}
              role="img"
            />
          ) : null}
        </>
      }
      trailing={
        // Value and unit share one line, even a long unit ("mL/(kg·min)",
        // "Atemzüge/min"): the row has no chevron, so the room is theirs.
        <span className="flex items-baseline justify-end gap-x-1 text-right whitespace-nowrap">
          <span data-slot="measurement-row-value" className="whitespace-nowrap">
            {value}
          </span>
          {unit ? (
            <span
              data-slot="measurement-row-unit"
              className="text-muted-foreground text-xs font-normal whitespace-nowrap"
            >
              {unit}
            </span>
          ) : null}
        </span>
      }
    >
      {isGrouped && isExpanded && (
        <div id={drilldownId} className="px-4 pb-3">
          <DayDrillDown
            type={m.type}
            dayKey={m.dayKey as string}
            unit={m.unit}
            layout="mobile"
          />
        </div>
      )}
    </ListItem>
  );
}
