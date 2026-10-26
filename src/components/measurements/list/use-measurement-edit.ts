"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useSeededFormDismissal } from "@/components/forms/use-seeded-form-dismissal";
import { ApiError, apiPut } from "@/lib/api/api-fetch";
import { toCanonicalMgdl } from "@/lib/glucose";
import { useTranslations } from "@/lib/i18n/context";
import { getUnitForType } from "@/lib/measurements/unit-map";
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
  const [editDeleteDialogOpen, setEditDeleteDialogOpen] = useState(false);
  // The error banner is linked to the inputs through `aria-describedby`, so a
  // screen reader announces why a submit was refused.
  const editErrorId = useId();
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
    onSuccess: async () => {
      await invalidateKeys(queryClient, measurementDependentKeys);
      await refetchInactiveDailyReads(queryClient);
      setEditSeed({
        value: editValue,
        measuredAt: editMeasuredAt,
        notes: editNotes,
      });
      dismissEdit();
    },
    onError: (err) => {
      // A 409 names its reason in `meta.errorCode`: the edit collides with
      // another reading's (type, time, source, stage), or the reading belongs
      // to a server-owned source (connector, import, computed).
      if (
        err instanceof ApiError &&
        err.meta?.errorCode === "measurement.duplicate_timestamp"
      ) {
        setEditError(t("measurements.duplicateTimestamp"));
        return;
      }
      if (
        err instanceof ApiError &&
        err.meta?.errorCode === "measurement.update.server_owned_source"
      ) {
        setEditError(t("measurements.serverOwnedSource"));
        return;
      }
      setEditError(
        err instanceof Error ? err.message : t("measurements.saveError"),
      );
    },
  });
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
  }

  function dismissEdit() {
    setEditing(null);
    setEditError(null);
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

    const parsedValue = Number(editValue);
    if (!Number.isFinite(parsedValue)) {
      setEditError(t("measurements.invalidValue"));
      return;
    }

    const measuredDate = new Date(editMeasuredAt);
    if (Number.isNaN(measuredDate.getTime())) {
      setEditError(t("measurements.invalidTimestamp"));
      return;
    }

    const canonicalValue = storedValueFor(display, editing, parsedValue);

    setEditError(null);
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
