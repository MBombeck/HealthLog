"use client";

import { localDateTimeValue } from "@/components/day/prefill";
import {
  useActiveRecordName,
  useRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FieldGroup } from "@/components/ui/field-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { showEntrySavedToast } from "@/components/forms/entry-saved-toast";
import { removeSavedMeasurements } from "@/components/forms/entry-undo";
import { useTranslations } from "@/lib/i18n/context";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { useAuth } from "@/hooks/use-auth";
import { resolveGlucoseUnit } from "@/lib/glucose";
import {
  durationEntryUnit,
  entryValueToCanonical,
  parseDecimalEntry,
} from "@/lib/measurements/entry-units";
import { defaultGlucoseContext } from "@/lib/measurements/glucose-context-default";
import {
  nextUsualType,
  orderByRecent,
} from "@/lib/measurements/recent-entry-types";
import { parseDurationEntry } from "@/lib/measurements/parse-duration";
import {
  invalidateKeys,
  measurementDependentKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { localizedApiError } from "@/lib/api/localized-error";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";

import { DurationReadAs } from "./duration-read-as";
import { useEntryType } from "./entry/use-entry-type";
import { LastValueDeviation } from "./entry/last-value-line";
import { MeasurementEntryFields } from "./entry/measurement-entry-fields";
import {
  canonicalEntryValue,
  useMeasurementEntryAssist,
} from "./entry/use-measurement-entry-assist";
import {
  MEASUREMENT_TYPES,
  measurementFormTypes,
} from "./measurement-form-types";
import type { GlucoseContextValue } from "./glucose-context-select";
import { ketoneFingerstickBatch } from "./ketone-fingerstick";
import {
  BloodPressureFields,
  MeasurementFormFooter,
  PairedGlucoseField,
} from "./measurement-form-parts";

interface MeasurementFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  defaultType?: string;
  /**
   * v1.42 — a calendar day (`YYYY-MM-DD`) to start the date on, when the
   * form is opened from that day. Defaults to now.
   */
  defaultDate?: string;
  /**
   * v1.4.27 — when the form is mounted inside a
   * `<ResponsiveSheet>` the caller passes the sheet's footer slot
   * element here. The form's action-row (kebab + Cancel + Save) is
   * portalled into that slot so the bottom-sheet branch can
   * sticky-pin it; the Save button stays associated with the logical
   * `<form>` via the HTML `form` attribute.
   */
  footerSlot?: HTMLElement | null;
  /**
   * Offer "Save and next value": save, keep the form open, clear the value
   * and move on to the next type the person usually logs. For the capture
   * sheets; a form whose save completes something else (a reminder, an
   * onboarding step) leaves it off.
   */
  chain?: boolean;
  /** Focus the first value field on mount (default). */
  autoFocus?: boolean;
}

/** What the create route answers: the stored row, or the rows of a batch. */
type SavedRows = { id: string } | Array<{ id: string }>;

function getDefaultMeasuredAtValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

export function MeasurementForm({
  onSuccess,
  onCancel,
  defaultType,
  footerSlot,
  defaultDate,
  chain = false,
  autoFocus = true,
}: MeasurementFormProps) {
  const { t } = useTranslations();
  const { canManageDomain } = useRecordCapabilities();
  const recordName = useActiveRecordName();
  const queryClient = useQueryClient();
  const post = useIdempotentPost();
  const unitDisplay = useUnitDisplay();
  const { user } = useAuth();
  // Glucose is its own display axis, separate from metric/imperial: it is
  // stored in mg/dL and rendered in whichever of mg/dL and mmol/L the
  // account chose. The form has to ask in the same unit it labels, and
  // invert on the way out, or a reader on mmol/L would file "5.5" as five
  // and a half mg/dL — a number the plausibility band happily accepts and
  // every surface then reads back as a severe hypo.
  const glucoseUnit = resolveGlucoseUnit(user?.glucoseUnit);

  // Normalize legacy BP types to combined mode
  const normalizedDefault =
    defaultType === "BLOOD_PRESSURE_SYS" || defaultType === "BLOOD_PRESSURE_DIA"
      ? "BLOOD_PRESSURE"
      : defaultType;

  // Only types whose module is on. A default, a deep link or the last-used
  // type that is switched off falls back to the first offered type.
  const moduleTypes = measurementFormTypes(user?.modules);
  const [value, setValue] = useState("");
  const [valueError, setValueError] = useState<string | null>(null);
  const [sysBp, setSysBp] = useState("");
  const [diaBp, setDiaBp] = useState("");
  const [pulse, setPulse] = useState("");
  const { type, setType } = useEntryType(
    moduleTypes.map((mt) => mt.value),
    normalizedDefault,
    value !== "" || sysBp !== "" || diaBp !== "" || pulse !== "",
  );
  // The glucose of a fingerstick entered with its ketones; optional.
  const [pairedGlucose, setPairedGlucose] = useState("");
  const [notes, setNotes] = useState("");
  const [measuredAt, setMeasuredAt] = useState(() =>
    localDateTimeValue(defaultDate),
  );
  // Null until the person picks one: the shown context is then the default
  // for the reading's time (`defaultGlucoseContext`), not a fixed "fasting".
  const [pickedGlucoseContext, setGlucoseContext] =
    useState<GlucoseContextValue | null>(null);
  // Set by "Save and next value" for the one submit it starts.
  const chainNext = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // v1.4.27 — wire `aria-describedby` on every required field so
  // screen readers announce the form-level error banner the moment it
  // surfaces. The banner already carries `role="alert"`, so the
  // descriptor relationship is purely additive.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;

  // v1.4.27 — stable id so the portalled Save button can keep
  // its `<form>` association via the HTML `form` attribute.
  const formId = useId();

  const assist = useMeasurementEntryAssist({
    type,
    offered: moduleTypes.map((mt) => mt.value),
    value,
    sys: sysBp,
    dia: diaBp,
    unitDisplay,
    glucoseUnit,
  });
  // The person's recently logged types first, then the catalogue order.
  const offeredTypes = orderByRecent(moduleTypes, assist.recent);
  const glucoseContext =
    pickedGlucoseContext ??
    defaultGlucoseContext(new Date(measuredAt), assist.history);
  const nextType = chain ? nextUsualType(assist.recent, type) : null;

  const typeInfo = MEASUREMENT_TYPES.find((t) => t.value === type);
  const isBpMode = type === "BLOOD_PRESSURE";
  const isGlucoseMode = type === "BLOOD_GLUCOSE";
  const isKetoneMode = type === "BLOOD_KETONES";
  // For a type with a metric/imperial transform the unit follows the user's
  // preference (kg↔lb, cm↔in, °C↔°F); everything else keeps its static
  // catalogue unit.
  const valueUnit = isGlucoseMode
    ? glucoseUnit
    : typeInfo
      ? unitDisplay.isTransformed(type)
        ? unitDisplay.unitFor(type)
        : "unitKey" in typeInfo
          ? t(typeInfo.unitKey)
          : typeInfo.unit
      : "";
  // A duration field (sleep, in hours) also reads "7:30" and "7h 30m"; the
  // hint under it says how the entry was understood.
  const durationUnit = durationEntryUnit(type);
  const durationRead =
    durationUnit !== null ? parseDurationEntry(value, durationUnit) : null;

  function resetForm() {
    setType(normalizedDefault || null);
    setValue("");
    setSysBp("");
    setDiaBp("");
    setPulse("");
    setPairedGlucose("");
    setNotes("");
    setMeasuredAt(localDateTimeValue(defaultDate));
    setGlucoseContext(null);
    setError(null);
    setValueError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const goOn = chainNext.current;
    chainNext.current = false;
    setError(null);
    setLoading(true);

    try {
      let created: SavedRows;
      const timestamp = new Date(measuredAt).toISOString();

      if (isBpMode) {
        // Batch: Sys + Dia + optional Pulse
        const batch: Array<{
          type: string;
          value: number;
          measuredAt: string;
          notes?: string;
        }> = [
          {
            type: "BLOOD_PRESSURE_SYS",
            value: parseFloat(sysBp),
            measuredAt: timestamp,
            notes: notes || undefined,
          },
          {
            type: "BLOOD_PRESSURE_DIA",
            value: parseFloat(diaBp),
            measuredAt: timestamp,
            notes: notes || undefined,
          },
        ];

        if (pulse) {
          batch.push({
            type: "PULSE",
            value: parseFloat(pulse),
            measuredAt: timestamp,
            notes: notes || undefined,
          });
        }

        created = await post<SavedRows>("/api/measurements", batch);
      } else if (isKetoneMode) {
        // One fingerstick, posted as one transaction (`ketone-fingerstick.ts`).
        const batch = ketoneFingerstickBatch({
          ketones: value,
          glucose: pairedGlucose,
          glucoseUnit,
          glucoseContext,
          measuredAt: timestamp,
          notes,
        });
        if (!batch) {
          setError(t("measurements.saveError"));
          return;
        }
        created = await post<SavedRows>("/api/measurements", batch);
      } else {
        // Single measurement, converted at the entry boundary
        // (`canonicalEntryValue`). Sleep is entered in hours and stored in
        // minutes; sending the typed number through unconverted filed a
        // 7.5-hour night as seven and a half minutes.
        let typed: number | null;
        if (durationRead) {
          if (!durationRead.ok) {
            setValueError(
              t(
                durationRead.reason === "tooLong"
                  ? "measurements.durationTooLong"
                  : "measurements.durationInvalid",
              ),
            );
            return;
          }
          typed = durationRead.value;
        } else {
          typed = parseDecimalEntry(value);
        }
        if (typed === null) {
          setError(t("measurements.saveError"));
          return;
        }
        const canonicalValue = durationRead
          ? entryValueToCanonical(type, typed)
          : canonicalEntryValue(type, typed, unitDisplay, glucoseUnit);
        created = await post<SavedRows>("/api/measurements", {
          type,
          value: canonicalValue,
          measuredAt: timestamp,
          notes: notes || undefined,
          ...(isGlucoseMode ? { glucoseContext } : {}),
        });
      }

      const savedValue = isBpMode
        ? `${sysBp}/${diaBp} mmHg`
        : `${value.trim()} ${valueUnit}`.trim();
      const ids = (Array.isArray(created) ? created : [created]).map(
        (row) => row.id,
      );
      setValue("");
      setSysBp("");
      setDiaBp("");
      setPulse("");
      setPairedGlucose("");
      setNotes("");
      setGlucoseContext(null);
      // v1.36.x — a delegate's receipt names the record.
      showEntrySavedToast({
        t,
        label: typeInfo ? t(typeInfo.labelKey) : t("measurements.title"),
        value: savedValue,
        recordName,
        // Undo removes what was just written through the list's own bulk
        // delete; a delegate who may write but not delete gets no Undo.
        undo: canManageDomain("measurements")
          ? async () => {
              await removeSavedMeasurements(ids);
              void invalidateKeys(queryClient, measurementDependentKeys);
              void refetchInactiveDailyReads(queryClient);
            }
          : undefined,
        edit: { kind: "measurement", ids: ids.slice(0, 1) }, // BP: systolic
      });
      if (goOn && nextType) {
        setType(nextType);
        // The next field takes the focus, ready to type.
        setTimeout(() => {
          document
            .getElementById(nextType === "BLOOD_PRESSURE" ? "sys" : "value")
            ?.focus();
        }, 0);
      } else {
        onSuccess?.();
      }
      // The reading is stored; the sheet does not wait for every read that
      // shows it to come back.
      void invalidateKeys(queryClient, measurementDependentKeys);
      void refetchInactiveDailyReads(queryClient);
    } catch (err) {
      setError(localizedApiError(err, t, "measurements.saveError"));
    } finally {
      setLoading(false);
    }
  }

  const footerNode = (
    <MeasurementFormFooter
      loading={loading}
      formId={formId}
      onReset={resetForm}
      onCancel={onCancel}
      onSaveNext={nextType ? () => (chainNext.current = true) : undefined}
      onSave={() => (chainNext.current = false)}
    />
  );

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <FieldGroup htmlFor="measurement-type" label={t("measurements.type")}>
        <Select
          value={type}
          onValueChange={(next) => {
            setType(next);
            setValueError(null);
          }}
        >
          <SelectTrigger id="measurement-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {offeredTypes.map((mt) => (
              <SelectItem key={mt.value} value={mt.value}>
                {t(mt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldGroup>

      <MeasurementEntryFields
        unit={valueUnit}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          setValueError(null);
        }}
        valueField={
          isBpMode ? (
            <BloodPressureFields
              sys={sysBp}
              dia={diaBp}
              pulse={pulse}
              onSys={setSysBp}
              onDia={setDiaBp}
              onPulse={setPulse}
              autoFocus={autoFocus}
              invalid={!!error}
              describedBy={errorDescriptor}
            />
          ) : undefined
        }
        valueHint={
          durationRead?.ok === true ? (
            <DurationReadAs minutes={durationRead.minutes} />
          ) : assist.deviates ? (
            <LastValueDeviation deviates />
          ) : null
        }
        valueError={valueError}
        // A duration also takes "7:30" and "7h 30m", which the decimal
        // keypad cannot type.
        inputMode={durationUnit !== null ? "text" : "decimal"}
        autoFocus={autoFocus}
        glucoseContext={
          isGlucoseMode || (isKetoneMode && pairedGlucose.trim() !== "")
            ? {
                value: glucoseContext,
                // The add form offers no "none": a reading typed in always
                // says when it was taken.
                onChange: (v) => v && setGlucoseContext(v),
              }
            : null
        }
        measuredAt={measuredAt}
        onMeasuredAtChange={setMeasuredAt}
        maxMeasuredAt={getDefaultMeasuredAtValue()}
        notes={notes}
        onNotesChange={setNotes}
        invalid={!!error}
        describedBy={errorDescriptor}
      >
        {isKetoneMode && (
          <PairedGlucoseField
            value={pairedGlucose}
            onChange={setPairedGlucose}
            unit={glucoseUnit}
            invalid={!!error}
            describedBy={errorDescriptor}
          />
        )}
      </MeasurementEntryFields>

      {error && (
        <div
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}

      {footerSlot ? createPortal(footerNode, footerSlot) : footerNode}
    </form>
  );
}
