"use client";

import {
  FilterBar,
  FilterBarDateRange,
  FilterBarNumberRange,
  FilterBarSelect,
} from "@/components/ui/filter-bar";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import { MEASUREMENT_TYPE_LABEL_KEYS as TYPE_LABEL_KEYS } from "../measurement-list-meta";

import {
  MEASUREMENT_SOURCE_OPTIONS,
  formatMeasurementSource,
} from "./list-model";
import type { MeasurementListFilters } from "./use-measurement-list-filters";

/**
 * The filter rail: compact pill triggers in the canonical order date range ·
 * type · source · value range, active filters folded into their pill as
 * removable chips, a reset action and the result count.
 */
export function MeasurementFilterRail({
  filters,
  total,
}: {
  filters: MeasurementListFilters;
  total: number | undefined;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const {
    typeFilter,
    sourceFilter,
    fromDay,
    toDay,
    valueMinInput,
    valueMaxInput,
    isDayGroupedFilter,
    resetFilters,
    setFromDay,
    setToDay,
    setTypeFilter,
    setSourceFilter,
    setValueMinInput,
    setValueMaxInput,
  } = filters;
  return (
    <FilterBar
      isFiltered={
        typeFilter !== "ALL" ||
        sourceFilter !== "ALL" ||
        fromDay !== "" ||
        toDay !== "" ||
        (!isDayGroupedFilter && (valueMinInput !== "" || valueMaxInput !== ""))
      }
      onReset={resetFilters}
      count={
        total !== undefined
          ? t("measurements.measurementCount", {
              count: fmt.integer(total),
            })
          : undefined
      }
    >
      <FilterBarDateRange
        label={t("dataList.dateRange")}
        from={fromDay}
        to={toDay}
        onFromChange={setFromDay}
        onToChange={setToDay}
        idPrefix="measurements"
      />
      <FilterBarSelect
        label={t("dataList.typeLabel")}
        value={typeFilter}
        onValueChange={setTypeFilter}
        allLabel={t("measurements.allTypes")}
        options={Object.entries(TYPE_LABEL_KEYS).map(([val, labelKey]) => ({
          value: val,
          label: t(labelKey),
        }))}
      />
      <FilterBarSelect
        label={t("dataList.sourceLabel")}
        value={sourceFilter}
        onValueChange={setSourceFilter}
        allLabel={t("dataList.allSources")}
        options={MEASUREMENT_SOURCE_OPTIONS.map((src) => ({
          value: src,
          label: formatMeasurementSource(src, t),
        }))}
      />
      {/* Value-range pill. Hidden for the day-grouped /
          sleep-night types where the painted `value` is a synthesised
          SUM / per-night total rather than a raw reading. */}
      {!isDayGroupedFilter && (
        <FilterBarNumberRange
          label={t("dataList.valueRange")}
          min={valueMinInput}
          max={valueMaxInput}
          onMinChange={setValueMinInput}
          onMaxChange={setValueMaxInput}
          idPrefix="measurements-value"
          fromLabel={t("dataList.valueMin")}
          toLabel={t("dataList.valueMax")}
        />
      )}
    </FilterBar>
  );
}
