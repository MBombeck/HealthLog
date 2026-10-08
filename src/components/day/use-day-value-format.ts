"use client";

import { useCallback } from "react";

import { useUnitDisplay } from "@/hooks/use-unit-display";
import type { DayValue } from "@/lib/day/contract";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import { getUnitForType } from "@/lib/measurements/unit-map";

import type { DayValueTile } from "./day-values-model";

/** Count metrics are whole numbers by definition. */
const WHOLE_NUMBER_TYPES: ReadonlySet<string> = new Set([
  "ACTIVITY_STEPS",
  "FLIGHTS_CLIMBED",
  "ACTIVE_ENERGY_BURNED",
  "TIME_IN_DAYLIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "HRV_RMSSD",
  "OXYGEN_SATURATION",
  "RESPIRATORY_RATE",
]);

/** True for a type read in whole numbers (counts, pressures, pulses). */
export function isWholeNumberType(type: string): boolean {
  return WHOLE_NUMBER_TYPES.has(type);
}

export interface FormattedDayValue {
  label: string;
  /** The number (or duration) as it is read. */
  value: string;
  /** The unit beside it, or "" when the value carries its own. */
  unit: string;
  /** The usual range in the same spelling, or null without a band. */
  usual: string | null;
  /** The usual range per row, for the spoken form. */
  usualParts: Array<{ lo: string; hi: string }> | null;
}

/**
 * Formats a day's values the way every other surface in the app shows them:
 * the person's unit preference, the locale's decimal separator, sleep as a
 * duration. The server sends canonical units; a row whose unit is not the
 * canonical one is shown as sent.
 */
export function useDayValueFormat() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const units = useUnitDisplay();

  const labelFor = useCallback(
    (tileKey: string): string => {
      if (tileKey === "BLOOD_PRESSURE") return t("charts.bloodPressure");
      const key = (MEASUREMENT_TYPE_LABEL_KEYS as Record<string, string>)[
        tileKey
      ];
      return key ? t(key) : tileKey;
    },
    [t],
  );

  const number = useCallback(
    (row: Pick<DayValue, "type" | "unit">, raw: number): string => {
      const canonical = row.unit === getUnitForType(row.type);
      const shown = canonical ? units.toDisplay(row.type, raw) : raw;
      if (row.type === "SLEEP_DURATION" && canonical) {
        return formatDurationMinutes(shown, t);
      }
      if (WHOLE_NUMBER_TYPES.has(row.type)) {
        return fmt.number(Math.round(shown), 0);
      }
      const decimals =
        canonical && units.isTransformed(row.type)
          ? units.decimalsFor(row.type)
          : 1;
      const scale = 10 ** decimals;
      return fmt.number(Math.round(shown * scale) / scale);
    },
    [fmt, t, units],
  );

  const unitFor = useCallback(
    (row: Pick<DayValue, "type" | "unit">): string => {
      if (row.type === "SLEEP_DURATION") return "";
      if (row.unit === getUnitForType(row.type)) return units.unitFor(row.type);
      return row.unit;
    },
    [units],
  );

  const formatTile = useCallback(
    (tile: DayValueTile): FormattedDayValue => {
      const label = labelFor(tile.key);
      const first = tile.values[0];
      if (!first)
        return { label, value: "", unit: "", usual: null, usualParts: null };
      const join = (part: (row: DayValue) => string | null) => {
        const parts = tile.values.map(part);
        return parts.every((p) => p !== null) ? parts.join("/") : null;
      };
      const value = join((row) => number(row, row.value)) ?? "";
      const usualParts = tile.values.every((row) => row.band !== null)
        ? tile.values.map((row) => ({
            lo: number(row, row.band!.lo),
            hi: number(row, row.band!.hi),
          }))
        : null;
      const usual = usualParts
        ? usualParts.map((part) => `${part.lo}–${part.hi}`).join("/")
        : null;
      return { label, value, unit: unitFor(first), usual, usualParts };
    },
    [labelFor, number, unitFor],
  );

  return { labelFor, formatTile };
}
