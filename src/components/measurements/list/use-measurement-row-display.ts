"use client";

import { useCallback, useMemo } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay, type UnitDisplay } from "@/hooks/use-unit-display";
import {
  convertGlucose,
  resolveGlucoseUnit,
  type GlucoseUnit,
} from "@/lib/glucose";
import { getUnitForType } from "@/lib/measurements/unit-map";

import type { Measurement } from "./list-model";

/**
 * How a row shows its reading: in the person's preferred unit (kg ↔ lb,
 * cm ↔ in, °C ↔ °F) for a canonical row, verbatim for a legacy row whose
 * stored unit is not the type's canonical one (so a stored unit is never
 * silently relabelled). Glucose sits on its own axis, stored in mg/dL and
 * shown in whichever of mg/dL and mmol/L the account chose, so the list and
 * the dashboard tile agree about the same reading.
 *
 * `rowDisplayFor` is that rule for one glucose unit and one metric /
 * imperial preference; the hook binds it to the account.
 */
export function rowDisplayFor(
  glucoseUnit: GlucoseUnit,
  unitDisplay: UnitDisplay,
) {
  // An edit whose input is NOT in the stored unit. Only the mmol/L branch
  // qualifies: an mg/dL account edits in the unit the column holds, and
  // converting anyway would quantise a stored 95.48 to 95 the moment somebody
  // opened the sheet to fix a note.
  const editsConvertedGlucose = (m: { type: string; unit: string }) =>
    m.type === "BLOOD_GLUCOSE" &&
    glucoseUnit === "mmol/L" &&
    m.unit === getUnitForType(m.type);
  const rowDisplay = (m: { type: string; value: number; unit: string }) => {
    if (m.unit !== getUnitForType(m.type)) {
      return { value: m.value, unit: m.unit };
    }
    if (m.type === "BLOOD_GLUCOSE") {
      return {
        value: convertGlucose(m.value, glucoseUnit),
        unit: glucoseUnit,
      };
    }
    return {
      value: unitDisplay.toDisplay(m.type, m.value),
      unit: unitDisplay.unitFor(m.type),
    };
  };
  return { unitDisplay, editsConvertedGlucose, rowDisplay };
}

export function useMeasurementRowDisplay() {
  const { user } = useAuth();
  const unitDisplay = useUnitDisplay();
  const glucoseUnit = resolveGlucoseUnit(user?.glucoseUnit);
  const { editsConvertedGlucose, rowDisplay } = useMemo(
    () => rowDisplayFor(glucoseUnit, unitDisplay),
    [glucoseUnit, unitDisplay],
  );
  /**
   * A machine-readable mirror of what the row renders: the same number and
   * unit, before `Intl` turns them into locale text. A browser test that has
   * to assert a stored unit would otherwise pin a locale or match a loose
   * number. The desktop table and the mobile list emit the same set, so an
   * assertion holds at either viewport.
   */
  const rowIdentityAttrs = useCallback(
    (m: Measurement, isGrouped: boolean) => ({
      "data-testid": "measurement-row",
      "data-measurement-type": m.type,
      "data-measurement-value": String(
        isGrouped ? m.value : rowDisplay(m).value,
      ),
      "data-measurement-unit": isGrouped ? m.unit : rowDisplay(m).unit,
    }),
    [rowDisplay],
  );
  return { unitDisplay, editsConvertedGlucose, rowDisplay, rowIdentityAttrs };
}

export type MeasurementRowDisplay = ReturnType<typeof useMeasurementRowDisplay>;
