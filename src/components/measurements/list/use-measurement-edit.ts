"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useSeededFormDismissal } from "@/components/forms/use-seeded-form-dismissal";
import { ApiError, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { toCanonicalMgdl } from "@/lib/glucose";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { getUnitForType } from "@/lib/measurements/unit-map";
import {
  VALUE_RANGES,
  validateMeasurementRange,
} from "@/lib/measurements/value-ranges";
import {
  invalidateKeys,
  measurementDependentKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";

import {
  MAX_COMMENT_LENGTH,
  toDateTimeLocalValue,
  type Measurement,
} from "./list-model";
import type { MeasurementListData } from "./use-measurement-list-data";
import type { MeasurementRowDisplay } from "./use-measurement-row-display";

/**
 * The edit input's seed, in the preferred unit, so an imperial reader edits
 * in lb / in / °F (converted back on save), rounded so the input shows "210"
 * rather than a long float. Metric readers and legacy rows see the stored
 * value.
 */
export function editSeedValue(
  {
    unitDisplay,
    editsConvertedGlucose,
    rowDisplay,
  }: Pick<
    MeasurementRowDisplay,
    "unitDisplay" | "editsConvertedGlucose" | "rowDisplay"
  >,
  measurement: Measurement,
): number {
  const rd = rowDisplay(measurement);
  return editsConvertedGlucose(measurement)
    ? rd.value
    : unitDisplay.preference === "imperial" &&
        unitDisplay.isTransformed(measurement.type) &&
        measurement.unit === getUnitForType(measurement.type)
      ? Math.round(rd.value * 100) / 100
      : measurement.value;
}

/**
 * The input's display-unit value inverted to the stored unit before the
 * request. Metric readers and legacy rows pass unchanged.
 */
export function storedValueFor(
  {
    unitDisplay,
    editsConvertedGlucose,
  }: Pick<MeasurementRowDisplay, "unitDisplay" | "editsConvertedGlucose">,
  editing: Measurement,
  parsedValue: number,
): number {
  if (editsConvertedGlucose(editing)) {
    // The label said mmol/L, so the number is mmol/L. Sending it on would
    // rewrite a 95 mg/dL reading as 5.3.
    return toCanonicalMgdl(parsedValue, "mmol/L");
  }
  if (
    unitDisplay.isTransformed(editing.type) &&
    editing.unit === getUnitForType(editing.type)
  ) {
    const inverted = unitDisplay.fromDisplay(editing.type, parsedValue);
    return unitDisplay.preference === "imperial"
      ? Math.round(inverted * 100) / 100
      : inverted;
  }
  return parsedValue;
}

/**
 * The stored value's plausible band for the row's type, in the unit the edit
 * input shows, or null for a type without one. The same table the server
 * checks the edit against.
 */
export function editValueRange(
  { rowDisplay }: Pick<MeasurementRowDisplay, "rowDisplay">,
  measurement: Measurement,
): { min: number; max: number; unit: string } | null {
  const range = VALUE_RANGES[measurement.type];
  if (!range) return null;
  const low = rowDisplay({ ...measurement, value: range.min });
  const high = rowDisplay({ ...measurement, value: range.max });
  const round = (n: number) => Math.round(n * 10) / 10;
  return { min: round(low.value), max: round(high.value), unit: low.unit };
}

type Translate = ReturnType<typeof useTranslations>["t"];

/** The sentence for a value outside its band, in the unit the input shows. */
function outOfRangeMessage(
  display: Pick<MeasurementRowDisplay, "rowDisplay">,
  measurement: Measurement,
  t: Translate,
  formatNumber: (value: number) => string,
): string {
  const range = editValueRange(display, measurement);
  return range
    ? t("measurements.valueOutOfRange", {
        min: formatNumber(range.min),
        max: formatNumber(range.max),
        unit: range.unit,
      })
    : t("measurements.invalidValue");
}

/**
 * The banner for a refused save. A 409 names its reason in `meta.errorCode`:
 * the edit collides with another reading's (type, time, source, stage), or
 * the reading belongs to a server-owned source (connector, import, computed).
 */
function saveRefusal(err: unknown, t: Translate): string {
  const code = err instanceof ApiError ? err.meta?.errorCode : undefined;
  if (code === "measurement.duplicate_timestamp") {
    return t("measurements.duplicateTimestamp");
  }
  if (code === "measurement.update.server_owned_source") {
    return t("measurements.serverOwnedSource");
  }
  return localizedApiError(err, t, "measurements.saveError");
}

/**
 * The edit sheet's state: the reading being edited, the draft seeded in the
 * person's display unit, the save (converted back to the stored unit) and
 * the delete from inside the sheet, and the dismissal guard that asks before
 * an edited draft is thrown away.
 */
export function useMeasurementEdit({
  onEdit,
  display,
  deleteMutation,
}: {
  onEdit?: (m: Measurement) => void;
  display: MeasurementRowDisplay;
  deleteMutation: MeasurementListData["deleteMutation"];
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Measurement | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editMeasuredAt, setEditMeasuredAt] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editSeed, setEditSeed] = useState({
    value: "",
    measuredAt: "",
    notes: "",
  });
  const [editError, setEditError] = useState<string | null>(null);
  // A refused value is said under the value input, not in the banner.
  const [editValueError, setEditValueError] = useState<string | null>(null);
  const [editDeleteDialogOpen, setEditDeleteDialogOpen] = useState(false);
  // The error banner is linked to the inputs through `aria-describedby`, so a
  // screen reader announces why a submit was refused.
  const editErrorId = useId();
  const editValueErrorId = useId();
  // The sheet's footer is a slot the form portals its buttons into.
  const editFormId = useId();
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(null);

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      value,
      measuredAt,
      notes,
    }: {
      id: string;
      value: number;
      measuredAt: string;
      notes: string | null;
    }) => {
      await apiPut(`/api/measurements/${id}`, { value, measuredAt, notes });
    },
    onSuccess: () => {
      setEditSeed({
        value: editValue,
        measuredAt: editMeasuredAt,
        notes: editNotes,
      });
      dismissEdit();
      void invalidateKeys(queryClient, measurementDependentKeys);
      void refetchInactiveDailyReads(queryClient);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.issuePaths.includes("value")) {
        setEditValueError(valueRefusal());
      } else {
        setEditError(saveRefusal(err, t));
      }
    },
  });

  function valueRefusal(): string {
    return editing
      ? outOfRangeMessage(display, editing, t, fmt.number)
      : t("measurements.invalidValue");
  }
  const editDismissal = useSeededFormDismissal({
    seed: editSeed,
    value: {
      value: editValue,
      measuredAt: editMeasuredAt,
      notes: editNotes,
    },
    blocked: updateMutation.isPending || deleteMutation.isPending,
  });

  function startEdit(measurement: Measurement) {
    if (onEdit) {
      onEdit(measurement);
      return;
    }

    const seedValue = editSeedValue(display, measurement);
    const seed = {
      value: String(seedValue),
      measuredAt: toDateTimeLocalValue(measurement.measuredAt),
      notes: (measurement.notes ?? "").slice(0, MAX_COMMENT_LENGTH),
    };
    setEditing(measurement);
    setEditValue(seed.value);
    setEditMeasuredAt(seed.measuredAt);
    setEditNotes(seed.notes);
    setEditSeed(seed);
    setEditError(null);
    setEditValueError(null);
  }

  function dismissEdit() {
    setEditing(null);
    setEditError(null);
    setEditValueError(null);
    setEditDeleteDialogOpen(false);
  }

  function closeEdit() {
    editDismissal.requestClose(dismissEdit);
  }

  async function deleteEditingMeasurement() {
    if (!editing) return;

    try {
      setEditError(null);
      await deleteMutation.mutateAsync(editing.id);
      dismissEdit();
    } catch {
      setEditError(t("measurements.deleteError"));
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;

    setEditError(null);
    setEditValueError(null);
    const parsedValue = Number(editValue);
    if (!Number.isFinite(parsedValue)) {
      setEditValueError(t("measurements.invalidValue"));
      return;
    }

    const measuredDate = new Date(editMeasuredAt);
    if (Number.isNaN(measuredDate.getTime())) {
      setEditError(t("measurements.invalidTimestamp"));
      return;
    }

    const canonicalValue = storedValueFor(display, editing, parsedValue);
    // The server refuses a changed value outside the type's band; say so at
    // the field before sending, in the unit the input shows.
    if (
      editValue !== editSeed.value &&
      validateMeasurementRange(editing.type, canonicalValue) !== null
    ) {
      setEditValueError(valueRefusal());
      return;
    }

    updateMutation.mutate({
      id: editing.id,
      value: canonicalValue,
      measuredAt: measuredDate.toISOString(),
      notes: editNotes.trim() ? editNotes.trim() : null,
    });
  }

  return {
    editing,
    editValue,
    setEditValue,
    editMeasuredAt,
    setEditMeasuredAt,
    editNotes,
    setEditNotes,
    editError,
    editErrorId,
    editErrorDescriptor: editError ? editErrorId : undefined,
    editValueError,
    editValueErrorId,
    editFormId,
    editFooterEl,
    setEditFooterEl,
    editDeleteDialogOpen,
    setEditDeleteDialogOpen,
    editDismissal,
    updateMutation,
    deleteMutation,
    startEdit,
    closeEdit,
    deleteEditingMeasurement,
    submitEdit,
  };
}

export type MeasurementEdit = ReturnType<typeof useMeasurementEdit>;
