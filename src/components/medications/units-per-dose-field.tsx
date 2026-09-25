"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  UNITS_PER_DOSE_OPTIONS,
  isCuratedUnitsPerDose,
} from "@/components/medications/units-per-dose";
import {
  formatUnitsPerDose,
  parseUnitsPerDoseInput,
} from "@/lib/medications/units-per-dose";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Units per dose: the curated buttons (¼ ⅓ ½ ⅔ ¾ 1 2 3 4) plus an "Other"
 * entry that opens a text field for anything else (#1034): "1.5", "1,5",
 * "1 1/2", "1½", "0.8". The field writes what was typed into the payload;
 * the wizard reads it with `parseUnitsPerDoseInput` and holds the step
 * while it does not read. A value no button holds (a stored 1.5, or a
 * legacy 10) opens with the field showing it, so an edit never drops it.
 *
 * `inherit` adds a leading button that clears the value (the per-slot
 * override's "use the medication's value").
 */
export function UnitsPerDoseField({
  value,
  onChange,
  labelId,
  inputId,
  dataSlot,
  inherit,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Id of the visible label naming the whole control. */
  labelId: string;
  /** Id for the Other text field. */
  inputId: string;
  dataSlot: string;
  inherit?: { label: string };
}) {
  const { t, locale } = useTranslations();
  const [otherOpen, setOtherOpen] = useState(
    () => value.trim() !== "" && !isCuratedUnitsPerDose(value),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const typed = value.trim();
  const parsed = typed === "" ? null : parseUnitsPerDoseInput(typed);
  const invalid = otherOpen && typed !== "" && parsed === null;
  const messageId = `${inputId}-message`;

  function choose(next: string) {
    setOtherOpen(false);
    onChange(next);
  }

  function openOther() {
    setOtherOpen(true);
    // The field mounts on this render; focus it on the next frame.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div className="space-y-2" data-slot={dataSlot}>
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-wrap gap-1.5"
      >
        {inherit && (
          <Button
            type="button"
            size="sm"
            variant={!otherOpen && value === "" ? "default" : "outline"}
            aria-pressed={!otherOpen && value === ""}
            className="min-w-10"
            onClick={() => choose("")}
          >
            {inherit.label}
          </Button>
        )}
        {UNITS_PER_DOSE_OPTIONS.map((opt) => {
          const selected = !otherOpen && value === opt.raw;
          return (
            <Button
              key={opt.raw}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              aria-pressed={selected}
              className="min-w-10 tabular-nums"
              onClick={() => choose(opt.raw)}
            >
              {opt.label}
            </Button>
          );
        })}
        <Button
          type="button"
          size="sm"
          variant={otherOpen ? "default" : "outline"}
          aria-pressed={otherOpen}
          aria-controls={inputId}
          data-slot={`${dataSlot}-other`}
          onClick={openOther}
        >
          {t("medications.unitsPerDoseField.other")}
        </Button>
      </div>
      {otherOpen && (
        <div className="space-y-1">
          <Input
            ref={inputRef}
            id={inputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            maxLength={12}
            className="max-w-40 tabular-nums"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("medications.unitsPerDoseField.placeholder")}
            aria-label={t("medications.unitsPerDoseField.inputLabel")}
            aria-invalid={invalid || undefined}
            aria-describedby={typed !== "" ? messageId : undefined}
          />
          {invalid ? (
            <p
              id={messageId}
              role="alert"
              className="text-destructive text-xs"
              data-slot={`${dataSlot}-invalid`}
            >
              {t("medications.unitsPerDoseField.invalid")}
            </p>
          ) : parsed !== null ? (
            <p
              id={messageId}
              className="text-muted-foreground text-xs"
              data-slot={`${dataSlot}-preview`}
            >
              {t("medications.unitsPerDoseField.preview", {
                value: formatUnitsPerDose(parsed, locale),
              })}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
