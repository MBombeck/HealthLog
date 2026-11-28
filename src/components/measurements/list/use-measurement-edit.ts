"use client";

import { parseDecimalEntry } from "@/lib/measurements/entry-units";
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useSeededFormDismissal } from "@/components/forms/use-seeded-form-dismissal";
import { ApiError, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { toCanonicalMgdl } from "@/lib/glucose";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { transformRescales } from "@/lib/measurements/display-transform";
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
  toGlucoseContextValue,
  type GlucoseContextValue,
} from "../glucose-context-select";

import {
  MAX_COMMENT_LENGTH,
  toDateTimeLocalValue,
  type Measurement,
} from "./list-model";
import type { MeasurementListData } from "./use-measurement-list-data";
import type { MeasurementRowDisplay } from "./use-measurement-row-display";

/**
 * The edit input's seed: the number the row shows, in the unit the label
 * names. Every converted type seeds through the same display transform the
 * list renders with, rounded to that transform's decimals, so a metric
 * distance seeds "8.73" under "km" and an imperial weight seeds "210" under
 * "lb". A metric reader used to get the stored value (8733 metres under a
 * km label) because only the imperial branch was converted. A legacy row
 * whose stored unit is not the type's canonical one keeps its stored value.
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
  if (editsConvertedGlucose(measurement)) return rowDisplay(measurement).value;
  if (
    unitDisplay.isTransformed(measurement.type) &&
    measurement.unit === getUnitForType(measurement.type)
  ) {
    // `toDisplay` rounds a rescaling transform to its decimals and leaves an
    // identity transform (metric kg, cm, °C) at the stored number.
    return rowDisplay(measurement).value;
  }
  return measurement.value;
}

/**
 * The input's display-unit value inverted to the stored unit before the
 * request. Legacy rows pass unchanged.
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
    // A rescaled entry (lb, mi, km, km/h) lands on the canonical dialect's
    // two decimals; an identity transform passes the typed number through.
    return transformRescales(unitDisplay.transformFor(editing.type))
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

/** The edit sheet's draft; the dismissal guard compares it with its seed. */
interface EditDraft {
  value: string;
  measuredAt: string;
  notes: string;
  glucoseContext: GlucoseContextValue | null;
}

/** The sentence for a value outside its band, in the unit the input shows. */
export function outOfRangeMessage(
  display: Pick<MeasurementRowDisplay, "rowDisplay">,
  measurement: Measurement,
  t: Translate,
  formatNumber: (value: number) => string,
): string {
  const range = editValueRange(display, measurement);
  if (!range) return t("measurements.invalidValue");
  const bounds = { min: formatNumber(range.min), max: formatNumber(range.max) };
  // A score, rating, count or ratio has no unit label, which left a space
  // before the full stop.
  return range.unit
    ? t("measurements.valueOutOfRange", { ...bounds, unit: range.unit })
    : t("measurements.valueOutOfRangeNoUnit", bounds);
}

/** The draft an edit opens with: the reading as it is stored, in the display unit. */
function editDraftFor(
  display: Pick<
    MeasurementRowDisplay,
    "unitDisplay" | "editsConvertedGlucose" | "rowDisplay"
  >,
  measurement: Measurement,
): EditDraft {
  return {
    value: String(editSeedValue(display, measurement)),
    measuredAt: toDateTimeLocalValue(measurement.measuredAt),
    notes: (measurement.notes ?? "").slice(0, MAX_COMMENT_LENGTH),
    glucoseContext: toGlucoseContextValue(measurement.glucoseContext),
  };
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
  // #1407 — the meal context of a blood glucose reading; null is "none".
  const [editGlucoseContext, setEditGlucoseContext] =
    useState<GlucoseContextValue | null>(null);
  const [editSeed, setEditSeed] = useState<EditDraft>({
    value: "",
    measuredAt: "",
    notes: "",
    glucoseContext: null,
  });
  const [editError, setEditError] = useState<string | null>(null);
  // A refused value is said under the value input, not in the banner.
  const [editValueError, setEditValueError] = useState<string | null>(null);
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
      ...body
    }: {
      id: string;
      value?: number;
      measuredAt: string;
      notes: string | null;
      glucoseContext?: GlucoseContextValue | null;
    }) => {
      await apiPut(`/api/measurements/${id}`, body);
    },
    onSuccess: () => {
      setEditSeed({
        value: editValue,
        measuredAt: editMeasuredAt,
        notes: editNotes,
        glucoseContext: editGlucoseContext,
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
      glucoseContext: editGlucoseContext,
    },
    blocked: updateMutation.isPending || deleteMutation.isPending,
  });

  function startEdit(measurement: Measurement) {
    if (onEdit) {
      onEdit(measurement);
      return;
    }

    const seed = editDraftFor(display, measurement);
    setEditing(measurement);
    setEditValue(seed.value);
    setEditMeasuredAt(seed.measuredAt);
    setEditNotes(seed.notes);
    setEditGlucoseContext(seed.glucoseContext);
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
    // The field takes a decimal comma like the add form's.
    const parsedValue = parseDecimalEntry(editValue);
    if (parsedValue === null) {
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
      // An untouched value is not sent: converted back from mmol/L or pounds
      // it can land a rounding step off the stored one, which a connected
      // source's row would refuse as a value edit.
      ...(editValue !== editSeed.value && { value: canonicalValue }),
      measuredAt: measuredDate.toISOString(),
      notes: editNotes.trim() ? editNotes.trim() : null,
      ...(editing.type === "BLOOD_GLUCOSE" && {
        glucoseContext: editGlucoseContext,
      }),
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
    editGlucoseContext,
    setEditGlucoseContext,
    editError,
    editErrorId,
    editErrorDescriptor: editError ? editErrorId : undefined,
    editValueError,
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
