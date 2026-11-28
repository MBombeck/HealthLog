"use client";

import type { UnitDisplay } from "@/hooks/use-unit-display";
import { toCanonicalMgdl, type GlucoseUnit } from "@/lib/glucose";
import { CUMULATIVE_DAY_SUM_TYPES } from "@/lib/measurements/cumulative-day-sum";
import {
  entryValueToCanonical,
  parseDecimalEntry,
} from "@/lib/measurements/entry-units";
import { transformRescales } from "@/lib/measurements/display-transform";
import { deviatesFromLast } from "@/lib/measurements/last-value-deviation";
import { getUnitForType } from "@/lib/measurements/unit-map";

import type { Measurement } from "../list/list-model";
import { useRecentEntryTypes, useTypeHistory } from "./use-entry-recall";

/**
 * Types whose "last reading" is not one reading: a step or distance total is
 * many chunks a day, and sleep is a night of stages. The line would quote a
 * fragment, so these get none.
 */
const NO_LAST_VALUE: ReadonlySet<string> = new Set([
  ...CUMULATIVE_DAY_SUM_TYPES,
  "SLEEP_DURATION",
]);

/**
 * The number a typed entry is stored as. Canonical storage stays SI: an
 * imperial reader types lb / in / °F and the value is inverted at this entry
 * boundary, rounded to the canonical two decimals when the transform
 * rescales (210 lb stores as 95.25 kg, not 95.25439770…); glucose is
 * inverted from the account's unit to mg/dL; and a type stored in another
 * unit than the form asks for (sleep, entered in hours, stored in minutes)
 * is converted last.
 */
export function canonicalEntryValue(
  type: string,
  typed: number,
  unitDisplay: UnitDisplay,
  glucoseUnit: GlucoseUnit,
): number {
  let value = typed;
  if (type === "BLOOD_GLUCOSE") {
    value = toCanonicalMgdl(typed, glucoseUnit);
  } else if (unitDisplay.isTransformed(type)) {
    const inverted = unitDisplay.fromDisplay(type, typed);
    value = transformRescales(unitDisplay.transformFor(type))
      ? Math.round(inverted * 100) / 100
      : inverted;
  }
  return entryValueToCanonical(type, value);
}

/**
 * What the add form knows about the person's own habits for the chosen
 * type: the types they log by hand (most recent first), their last reading
 * of this type, and whether the typed value is far from it.
 */
export function useMeasurementEntryAssist({
  type,
  offered,
  value,
  sys,
  dia,
  unitDisplay,
  glucoseUnit,
}: {
  type: string;
  offered: ReadonlyArray<string>;
  value: string;
  sys: string;
  dia: string;
  unitDisplay: UnitDisplay;
  glucoseUnit: GlucoseUnit;
}) {
  const recent = useRecentEntryTypes(offered, true);
  const isBp = type === "BLOOD_PRESSURE";
  const history = useTypeHistory(
    isBp ? "BLOOD_PRESSURE_SYS" : NO_LAST_VALUE.has(type) ? null : type,
  );
  const diaHistory = useTypeHistory(isBp ? "BLOOD_PRESSURE_DIA" : null);
  const last: Measurement | null = history[0] ?? null;
  const lastDia: Measurement | null = isBp ? (diaHistory[0] ?? null) : null;

  let deviates = false;
  if (isBp) {
    const s = parseDecimalEntry(sys);
    const d = parseDecimalEntry(dia);
    deviates =
      (s !== null && deviatesFromLast("BLOOD_PRESSURE_SYS", s, last?.value)) ||
      (d !== null && deviatesFromLast("BLOOD_PRESSURE_DIA", d, lastDia?.value));
  } else {
    const typed = parseDecimalEntry(value);
    deviates =
      typed !== null &&
      last !== null &&
      // A legacy row in another unit is not comparable number to number.
      last.unit === getUnitForType(type) &&
      deviatesFromLast(
        type,
        canonicalEntryValue(type, typed, unitDisplay, glucoseUnit),
        last.value,
      );
  }

  return { recent, history, deviates };
}
