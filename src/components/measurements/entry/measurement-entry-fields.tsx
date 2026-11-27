"use client";

import type { ReactNode } from "react";

import { DateTimeField } from "@/components/ui/date-time-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";
import { MEASUREMENT_NOTES_MAX_LENGTH } from "@/lib/measurements/notes-limit";

import {
  GlucoseContextSelect,
  type GlucoseContextValue,
} from "../glucose-context-select";

/** A note this close to its limit shows how much room is left. */
const NOTE_COUNTER_FROM = Math.floor(MEASUREMENT_NOTES_MAX_LENGTH * 0.8);

/**
 * The body every measurement form shares: value, glucose context, time,
 * note. "Messwert erfassen" and "Messwert bearbeiten" render it, so the two
 * look the same field for field. The add form puts its type select above
 * it and may replace the value field with the blood pressure row; nothing
 * else differs. Guard: `measurement-entry-fields-parity.test.tsx`.
 *
 * - The value is labelled "Value (unit)", the way every other form names a
 *   field with a unit; a reading without a unit is just "Value".
 * - Every field is the shared `Input`, one height.
 * - The note's counter appears only once the note nears its limit.
 *
 * `idPrefix` keeps the add and edit ids apart when both are mounted.
 */
export function MeasurementEntryFields({
  idPrefix = "",
  unit,
  value,
  onValueChange,
  valueField,
  valueHint,
  valueError,
  inputMode = "decimal",
  placeholder,
  autoFocus,
  glucoseContext,
  measuredAt,
  onMeasuredAtChange,
  maxMeasuredAt,
  notes,
  onNotesChange,
  invalid,
  describedBy,
  children,
}: {
  idPrefix?: string;
  /** The unit as the person reads it; "" when the reading has none. */
  unit: string;
  value: string;
  onValueChange: (next: string) => void;
  /** Replaces the single value field (the blood pressure row). */
  valueField?: ReactNode;
  valueHint?: ReactNode;
  valueError?: string | null;
  inputMode?: "decimal" | "text";
  placeholder?: string;
  autoFocus?: boolean;
  /** Shown for a glucose reading; `allowNone` for one that came without. */
  glucoseContext?: {
    value: GlucoseContextValue | null;
    onChange: (next: GlucoseContextValue | null) => void;
    allowNone?: boolean;
  } | null;
  measuredAt: string;
  onMeasuredAtChange: (next: string) => void;
  maxMeasuredAt: string;
  notes: string;
  onNotesChange: (next: string) => void;
  /** The form-level error marks the fields invalid. */
  invalid: boolean;
  describedBy?: string;
  /** Fields that belong between the value and the time (paired glucose). */
  children?: ReactNode;
}) {
  const { t } = useTranslations();
  const id = (name: string) => `${idPrefix}${name}`;
  const valueErrorId = `${id("value")}-error`;
  return (
    <>
      {valueField ?? (
        <FieldGroup
          htmlFor={id("value")}
          hint={valueHint}
          error={valueError ?? undefined}
          label={
            unit
              ? t("measurements.valueWithUnit", { unit })
              : t("measurements.value")
          }
        >
          <Input
            id={id("value")}
            // Not `type="number"`: its sanitisation drops a decimal comma on
            // the engines that do not localise the field. `inputMode` still
            // raises the numeric keypad, and the submit path reads the comma.
            inputMode={inputMode}
            enterKeyHint="next"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={placeholder}
            autoFocus={autoFocus}
            required
            aria-required="true"
            aria-invalid={invalid || !!valueError || undefined}
            aria-describedby={
              [valueError ? valueErrorId : null, describedBy]
                .filter(Boolean)
                .join(" ") || undefined
            }
          />
        </FieldGroup>
      )}

      {children}

      {glucoseContext ? (
        <FieldGroup
          htmlFor={id("glucose-context")}
          label={t("measurements.glucoseContext")}
        >
          <GlucoseContextSelect
            id={id("glucose-context")}
            value={glucoseContext.value}
            onValueChange={glucoseContext.onChange}
            allowNone={glucoseContext.allowNone}
          />
        </FieldGroup>
      ) : null}

      <FieldGroup
        htmlFor={id("measuredAt")}
        label={t("measurements.timestamp")}
      >
        <DateTimeField
          id={id("measuredAt")}
          value={measuredAt}
          onChange={onMeasuredAtChange}
          // The server refuses a future instant; so does the picker.
          max={maxMeasuredAt}
          required
          aria-required="true"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      </FieldGroup>

      <FieldGroup
        htmlFor={id("notes")}
        label={
          <>
            {t("common.note")}
            <span className="text-muted-foreground ml-1 font-normal">
              ({t("common.optional")})
            </span>
          </>
        }
        labelAccessory={
          notes.length >= NOTE_COUNTER_FROM ? (
            <span
              data-slot="measurement-note-counter"
              className="text-muted-foreground text-xs tabular-nums"
            >
              {notes.length}/{MEASUREMENT_NOTES_MAX_LENGTH}
            </span>
          ) : undefined
        }
      >
        <Input
          id={id("notes")}
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder={t("measurements.notesPlaceholder")}
          maxLength={MEASUREMENT_NOTES_MAX_LENGTH}
          enterKeyHint="done"
          autoCapitalize="sentences"
        />
      </FieldGroup>
    </>
  );
}
