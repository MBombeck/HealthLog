"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "@/lib/i18n/context";

export const GLUCOSE_CONTEXTS = [
  { value: "FASTING", labelKey: "measurements.glucoseContextFasting" },
  {
    value: "POSTPRANDIAL",
    labelKey: "measurements.glucoseContextPostprandial",
  },
  { value: "RANDOM", labelKey: "measurements.glucoseContextRandom" },
  { value: "BEDTIME", labelKey: "measurements.glucoseContextBedtime" },
] as const;

export type GlucoseContextValue = (typeof GLUCOSE_CONTEXTS)[number]["value"];

/** A Radix select item cannot carry an empty value; this stands for "none". */
const NONE = "NONE";

/** Narrow a stored context to the four the control offers, else null. */
export function toGlucoseContextValue(
  raw: string | null | undefined,
): GlucoseContextValue | null {
  return GLUCOSE_CONTEXTS.some((ctx) => ctx.value === raw)
    ? (raw as GlucoseContextValue)
    : null;
}

/**
 * The meal-context selector of a blood glucose reading, shared by the add
 * form and the edit sheet. `allowNone` adds an explicit "not specified"
 * option for a reading saved without one (a sensor or MCP write); the add
 * form always asks for a context.
 */
export function GlucoseContextSelect({
  id,
  value,
  onValueChange,
  allowNone = false,
}: {
  id: string;
  value: GlucoseContextValue | null;
  onValueChange: (value: GlucoseContextValue | null) => void;
  allowNone?: boolean;
}) {
  const { t } = useTranslations();
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) =>
        onValueChange(v === NONE ? null : (v as GlucoseContextValue))
      }
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {GLUCOSE_CONTEXTS.map((ctx) => (
          <SelectItem
            key={ctx.value}
            value={ctx.value}
            // The option carries its enum alongside the translated label, so
            // an option can be chosen by which meal time it means rather than
            // by the words the current locale prints.
            data-glucose-context={ctx.value}
          >
            {t(ctx.labelKey)}
          </SelectItem>
        ))}
        {allowNone ? (
          <SelectItem value={NONE} data-glucose-context="none">
            {t("measurements.glucoseContextNone")}
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}
