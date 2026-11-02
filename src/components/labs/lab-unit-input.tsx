"use client";

import { useId, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DIMENSIONLESS_UNIT,
  isDimensionlessUnit,
  labUnitLabel,
} from "@/lib/labs/dimensionless";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/** A marker's unit as a muted label, "No unit" for a ratio or an index. */
export function LabUnitName({
  unit,
  className,
}: {
  unit: string;
  className?: string;
}) {
  const { t } = useTranslations();
  return (
    <span className={cn("text-muted-foreground text-xs", className)}>
      {labUnitLabel(unit, t)}
    </span>
  );
}

interface LabUnitInputProps {
  id: string;
  value: string;
  onChange: (unit: string) => void;
  maxLength?: number;
  placeholder?: string;
  required?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /**
   * Offer the explicit "no unit" choice. Off for a field that only shares the
   * input, such as a medication dose on the document review.
   */
  allowNoUnit?: boolean;
}

/**
 * The unit of a lab value, with an explicit "no unit" choice for a ratio or an
 * index. Ticking it sets the unit to the UCUM unity `"1"`, which every write
 * path accepts as a real unit; leaving the field empty is still refused, so a
 * unit an extraction dropped is never taken for a value that has none. Only
 * the box makes the choice: a unit typed key by key passes through "1" on its
 * way to `10^9/L`, and that keystroke stays text.
 */
export function LabUnitInput({
  id,
  value,
  onChange,
  maxLength,
  placeholder,
  required,
  allowNoUnit = true,
  ...aria
}: LabUnitInputProps) {
  const { t } = useTranslations();
  const noneId = useId();
  const hintId = `${noneId}-hint`;
  // Set when a keystroke, not the box, left the field at "1".
  const [typedOne, setTypedOne] = useState(false);
  const none = allowNoUnit && isDimensionlessUnit(value) && !typedOne;
  // What was typed before the box was ticked, so unticking gives it back.
  const typed = useRef(none ? "" : value);

  const input = (
    <Input
      id={id}
      value={none ? "" : value}
      onChange={(e) => {
        typed.current = e.target.value;
        setTypedOne(isDimensionlessUnit(e.target.value));
        onChange(e.target.value);
      }}
      placeholder={none ? t("labs.unit.none") : placeholder}
      maxLength={maxLength}
      required={required && !none}
      disabled={none}
      {...aria}
    />
  );
  if (!allowNoUnit) return input;

  return (
    <div className="space-y-1.5" data-slot="lab-unit-input">
      {input}
      <label
        htmlFor={noneId}
        className="flex min-h-11 cursor-pointer items-start gap-2 sm:min-h-0"
      >
        <Checkbox
          id={noneId}
          checked={none}
          onCheckedChange={(state) => {
            setTypedOne(false);
            onChange(
              state === true
                ? DIMENSIONLESS_UNIT
                : isDimensionlessUnit(typed.current)
                  ? ""
                  : typed.current,
            );
          }}
          aria-describedby={hintId}
          className="mt-0.5"
        />
        <span className="space-y-0.5">
          <span className="block text-sm">{t("labs.unit.none")}</span>
          <span id={hintId} className="text-muted-foreground block text-xs">
            {t("labs.unit.noneHint")}
          </span>
        </span>
      </label>
    </div>
  );
}
