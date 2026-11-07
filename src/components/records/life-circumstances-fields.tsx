/**
 * The small field primitives the life circumstances form is built from.
 * Each one owns only its own input state; the form owns the answers.
 */
import { useState, type ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useFormatters } from "@/lib/i18n/context";

export type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {/* Block, so the colon follows a label that wraps instead of standing
          alone at the far edge as a flex item. */}
      <Label htmlFor={id} className="block leading-snug">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function ChoiceField({
  id,
  label,
  value,
  options,
  onChange,
  t,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  t: Translate;
  disabled: boolean;
}) {
  return (
    <Field id={id} label={label}>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("records.life.noAnswer")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function BoolField({
  id,
  label,
  value,
  onChange,
  t,
  disabled,
}: {
  id: string;
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  t: Translate;
  disabled: boolean;
}) {
  return (
    <ChoiceField
      id={id}
      label={label}
      value={value === null ? "" : value ? "yes" : "no"}
      options={[
        { value: "yes", label: t("records.life.yes") },
        { value: "no", label: t("records.life.no") },
      ]}
      onChange={(next) => onChange(next === "" ? null : next === "yes")}
      t={t}
      disabled={disabled}
    />
  );
}

export function NumberField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number | null) => void;
  disabled: boolean;
}) {
  // What the person is typing. A year passes through "1", "19" and "198" on
  // its way to "1985", so clamping each keystroke turned the first digit into
  // the minimum and the field could not be typed into. A value is committed
  // once it is in range, and leaving the field puts the committed one back.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field id={id} label={label}>
      <Input
        id={id}
        type="number"
        inputMode={step < 1 ? "decimal" : "numeric"}
        min={min}
        max={max}
        step={step}
        value={draft ?? (value === null ? "" : String(value))}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (raw === "") return onChange(null);
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
            onChange(parsed);
          }
        }}
        onBlur={() => setDraft(null)}
      />
    </Field>
  );
}

/**
 * A month typed as YYYY-MM. Only a complete month is committed, so the field
 * keeps what is being typed on its own: holding it to the committed value
 * threw away every keystroke until the text was a whole month, and only a
 * paste got through. Leaving the field pads "2019-3" to "2019-03" and puts
 * the committed month back over anything that is not one.
 */
export function QuitMonthInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      id={id}
      placeholder="YYYY-MM"
      inputMode="numeric"
      maxLength={7}
      value={draft ?? value ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const month = completeMonth(raw);
        if (month !== undefined) onChange(month);
      }}
      onBlur={() => {
        if (draft !== null) {
          const short = /^(\d{4})-([1-9])$/.exec(draft.trim());
          if (short) onChange(`${short[1]}-0${short[2]}`);
        }
        setDraft(null);
      }}
    />
  );
}

/** A whole month, null for an emptied field, undefined while still typing. */
function completeMonth(raw: string): string | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : undefined;
}

export function MultiField<T extends string>({
  id,
  label,
  hint,
  options,
  value,
  onChange,
  max,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: readonly T[];
  onChange: (value: T[]) => void;
  max?: number;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-2" data-slot={id}>
      <legend className="text-sm font-medium">{label}</legend>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {options.map((option) => {
          const checked = value.includes(option.value);
          const full = max !== undefined && value.length >= max && !checked;
          return (
            <label
              key={option.value}
              className="flex min-h-11 min-w-0 items-center gap-2 text-sm sm:min-h-9"
            >
              <Checkbox
                className="shrink-0"
                checked={checked}
                disabled={disabled || full}
                onCheckedChange={(next) =>
                  onChange(
                    next === true
                      ? [...value, option.value]
                      : value.filter((item) => item !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Month and year of "valid since", as `YYYY-MM`. */
export function MonthField({
  id,
  value,
  onChange,
  t,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  t: Translate;
  disabled: boolean;
}) {
  const fmt = useFormatters();
  const [year, month] = value.split("-");
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 80 }, (_, i) => String(thisYear - i));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">
        {t("records.life.validSince")}
      </legend>
      <div className="grid grid-cols-2 gap-4">
        <NativeSelect
          id={`${id}-month`}
          aria-label={t("records.life.month")}
          value={month}
          disabled={disabled}
          onChange={(event) => onChange(`${year}-${event.target.value}`)}
        >
          {Array.from({ length: 12 }, (_, i) => {
            const m = String(i + 1).padStart(2, "0");
            return (
              <option key={m} value={m}>
                {fmt.monthShort(new Date(Date.UTC(2026, i, 15)))}
              </option>
            );
          })}
        </NativeSelect>
        <NativeSelect
          id={`${id}-year`}
          aria-label={t("records.life.year")}
          value={year}
          disabled={disabled}
          onChange={(event) => onChange(`${event.target.value}-${month}`)}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </NativeSelect>
      </div>
    </fieldset>
  );
}
