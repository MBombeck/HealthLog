"use client";

/**
 * v1.5.0 — CadencePicker component.
 *
 * Single picker exposing all 8 cadence kinds as a flat-grouped radio
 * list (per design-synthesis R-1 + R-4). One native radio drives the
 * `kind`; conditional sub-controls render only when their parent
 * radio is selected (hide-not-grey-out).
 *
 * Emits a `CadenceValue` (`{ kind, rrule, rollingIntervalDays,
 * oneShot }`) via `onChange`. The wizard / form layer maps that to
 * the wire shape — `oneShot` to the medication level, `rrule` +
 * `rollingIntervalDays` to the schedule.
 *
 * No new dependencies. Uses native `<input type="radio">` for the
 * grouped-flat-list semantic (no `RadioGroup` primitive ships in
 * `src/components/ui/`); shadcn `<Label>`, `<Input>` for sub-controls.
 *
 * Props:
 *   - `allowedKinds` (optional) — filters the radio list to a subset
 *     of `CadenceKind`. The wizard passes the recurring-only list so
 *     `"oneShot"` cannot land alongside the mode picker's canonical
 *     value. When omitted, every kind is rendered (the edit-form path
 *     preserves the full picker for legacy schedules).
 *
 * i18n keys consumed (namespace `medications.scheduling.cadence.*`):
 *
 *   .label                       — picker group ariaLabel
 *   .kind.daily                  — "Every day"
 *   .kind.weekdays               — "Certain days of the week"
 *   .kind.everyNWeeks            — "Every N weeks on certain days"
 *   .kind.monthly                — "Monthly on day"
 *   .kind.everyNMonths           — "Every N months on day"
 *   .kind.yearly                 — "Yearly on date"
 *   .kind.rolling                — "Every N days from when I last took it (flexible)"
 *   .kind.rollingExplainer       — "Counts from your last logged intake — pauses if you skip"
 *   .kind.oneShot                — "One-time dose"
 *   .weekdays.label              — chip-row aria-label "Days of week"
 *   .weekdays.short.mo|tu|we|th|fr|sa|su  — chip abbreviations
 *   .weekdays.long.mo|tu|we|th|fr|sa|su   — chip aria-labels (full name)
 *   .intervalWeeks.suffix        — "weeks"
 *   .dayOfMonth.label            — "Day"
 *   .intervalMonths.suffix       — "months"
 *   .intervalMonths.dayOnLabel   — "on day"
 *   .yearly.date.label           — "Date"
 *   .rollingDays.suffix          — "days"
 */

import { useCallback, useId, useMemo } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";

import {
  type CadenceKind,
  type CadenceSubControls,
  type CadenceValue,
  DEFAULT_SUB_CONTROLS,
  type WeekdayToken,
  WEEKDAY_TOKENS,
} from "./types";

export interface CadencePickerProps {
  value: CadenceValue;
  /** Internal sub-controls; the parent owns them so the picker stays
   *  stateless. Optional — if omitted, `DEFAULT_SUB_CONTROLS` is used
   *  and the picker simply re-emits with the chosen defaults. */
  subControls?: CadenceSubControls;
  /**
   * Optional filter over the rendered radio list. When defined, only
   * the listed kinds appear (in the file-level `ALL_KINDS` order);
   * when omitted, every kind renders so the edit-form path stays
   * fully expressive. Used by the wizard's Step 3 to drop the
   * `"oneShot"` radio once the mode picker has already taken that
   * decision.
   */
  allowedKinds?: readonly CadenceKind[];
  onChange: (next: CadenceValue, subControls: CadenceSubControls) => void;
  /** Disables the entire picker (edit-locked-while-active medications). */
  disabled?: boolean;
  /** Translation namespace prefix. */
  i18nPrefix?: string;
}

const ALL_KINDS: CadenceKind[] = [
  "daily",
  "weekdays",
  "everyNWeeks",
  "monthly",
  "everyNMonths",
  "yearly",
  "rolling",
  "oneShot",
];

// ────────────────────────────────────────────────────────────────────
// Encoder — pure helper (exported for unit tests)
// ────────────────────────────────────────────────────────────────────

/**
 * Map a (kind, subControls) pair to a `CadenceValue`. Pure function;
 * the picker calls this on every interaction to produce the next
 * value emitted to `onChange`.
 *
 * Defaults:
 *   - `weekdays` / `everyNWeeks` with no days selected → default to
 *     `[MO]` so the encoded RRULE is always valid.
 *   - `yearly` with no date set → uses Jan 1 placeholder
 *     (`FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1`); the wizard should still
 *     gate the "continue" button until the user picks a real date.
 */
export function encodeCadence(
  kind: CadenceKind,
  sub: CadenceSubControls,
): CadenceValue {
  switch (kind) {
    case "daily":
      return {
        kind,
        rrule: "FREQ=DAILY",
        rollingIntervalDays: null,
        oneShot: false,
      };
    case "weekdays": {
      const days = sub.weekdays.length > 0 ? sub.weekdays : ["MO"];
      return {
        kind,
        rrule: `FREQ=WEEKLY;BYDAY=${days.join(",")}`,
        rollingIntervalDays: null,
        oneShot: false,
      };
    }
    case "everyNWeeks": {
      const days = sub.weekdays.length > 0 ? sub.weekdays : ["MO"];
      const n = clamp(sub.intervalWeeks, 1, 52);
      return {
        kind,
        rrule: `FREQ=WEEKLY;INTERVAL=${n};BYDAY=${days.join(",")}`,
        rollingIntervalDays: null,
        oneShot: false,
      };
    }
    case "monthly": {
      const d = clamp(sub.dayOfMonth, 1, 31);
      return {
        kind,
        rrule: `FREQ=MONTHLY;BYMONTHDAY=${d}`,
        rollingIntervalDays: null,
        oneShot: false,
      };
    }
    case "everyNMonths": {
      const n = clamp(sub.intervalMonths, 1, 12);
      const d = clamp(sub.dayOfMonth, 1, 31);
      return {
        kind,
        rrule: `FREQ=MONTHLY;INTERVAL=${n};BYMONTHDAY=${d}`,
        rollingIntervalDays: null,
        oneShot: false,
      };
    }
    case "yearly": {
      const parsed = parseIsoDate(sub.yearlyDate);
      const month = parsed?.month ?? 1;
      const day = parsed?.day ?? 1;
      return {
        kind,
        rrule: `FREQ=YEARLY;BYMONTH=${month};BYMONTHDAY=${day}`,
        rollingIntervalDays: null,
        oneShot: false,
      };
    }
    case "rolling": {
      const n = clamp(sub.rollingDays, 1, 365);
      return {
        kind,
        rrule: null,
        rollingIntervalDays: n,
        oneShot: false,
      };
    }
    case "oneShot":
      return {
        kind,
        rrule: null,
        rollingIntervalDays: null,
        oneShot: true,
      };
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseIsoDate(s: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return { year: y, month: m, day: d };
}

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

export function CadencePicker({
  value,
  subControls,
  allowedKinds,
  onChange,
  disabled = false,
  i18nPrefix = "medications.scheduling.cadence",
}: CadencePickerProps) {
  const { t } = useTranslations();
  const groupName = useId();
  const sub = subControls ?? DEFAULT_SUB_CONTROLS;
  const renderedKinds = useMemo(() => {
    if (!allowedKinds) return ALL_KINDS;
    const allowed = new Set(allowedKinds);
    return ALL_KINDS.filter((k) => allowed.has(k));
  }, [allowedKinds]);

  const emit = useCallback(
    (kind: CadenceKind, nextSub: CadenceSubControls) => {
      onChange(encodeCadence(kind, nextSub), nextSub);
    },
    [onChange],
  );

  const onPickKind = useCallback(
    (kind: CadenceKind) => {
      emit(kind, sub);
    },
    [emit, sub],
  );

  const onSubChange = useCallback(
    (patch: Partial<CadenceSubControls>) => {
      emit(value.kind, { ...sub, ...patch });
    },
    [emit, sub, value.kind],
  );

  return (
    <fieldset
      disabled={disabled}
      className="space-y-2"
      aria-label={t(`${i18nPrefix}.label`)}
      data-slot="cadence-picker"
    >
      {renderedKinds.map((kind) => {
        const selected = value.kind === kind;
        return (
          <CadenceOption
            key={kind}
            kind={kind}
            selected={selected}
            groupName={groupName}
            disabled={disabled}
            i18nPrefix={i18nPrefix}
            sub={sub}
            onPick={() => onPickKind(kind)}
            onSubChange={onSubChange}
            t={t}
          />
        );
      })}
    </fieldset>
  );
}

// ────────────────────────────────────────────────────────────────────
// CadenceOption — one row (radio + label + conditional sub-controls)
// ────────────────────────────────────────────────────────────────────

interface CadenceOptionProps {
  kind: CadenceKind;
  selected: boolean;
  groupName: string;
  disabled: boolean;
  i18nPrefix: string;
  sub: CadenceSubControls;
  onPick: () => void;
  onSubChange: (patch: Partial<CadenceSubControls>) => void;
  t: (key: string) => string;
}

function CadenceOption({
  kind,
  selected,
  groupName,
  disabled,
  i18nPrefix,
  sub,
  onPick,
  onSubChange,
  t,
}: CadenceOptionProps) {
  const inputId = useId();
  const label = t(`${i18nPrefix}.kind.${kind}`);
  return (
    <div
      className="border-border/60 hover:bg-muted/30 has-checked:bg-muted/40 rounded-md border p-3 transition-colors"
      data-slot="cadence-option"
      data-kind={kind}
    >
      {/* Wrapping the row in <label> makes the entire 44 px-tall card
          a click target for the radio (WCAG 2.5.5) instead of just the
          16 px radio glyph + the label text node. */}
      <label
        htmlFor={inputId}
        className="flex min-h-11 cursor-pointer items-center gap-3 select-none"
      >
        <input
          id={inputId}
          type="radio"
          name={groupName}
          checked={selected}
          disabled={disabled}
          onChange={onPick}
          className="text-primary focus-visible:ring-ring h-4 w-4 cursor-pointer focus-visible:outline-none focus-visible:ring-2"
          data-slot="cadence-option-radio"
        />
        <span className="text-sm font-medium">{label}</span>
      </label>

      {selected && kind === "weekdays" && (
        <div className="mt-3">
          <WeekdayChips
            selected={sub.weekdays}
            disabled={disabled}
            i18nPrefix={i18nPrefix}
            onChange={(weekdays) => onSubChange({ weekdays })}
            t={t}
          />
        </div>
      )}

      {selected && kind === "everyNWeeks" && (
        <div className="mt-3 space-y-3">
          <NumberWithSuffix
            value={sub.intervalWeeks}
            min={1}
            max={52}
            suffix={t(`${i18nPrefix}.intervalWeeks.suffix`)}
            disabled={disabled}
            onChange={(intervalWeeks) => onSubChange({ intervalWeeks })}
          />
          <WeekdayChips
            selected={sub.weekdays}
            disabled={disabled}
            i18nPrefix={i18nPrefix}
            onChange={(weekdays) => onSubChange({ weekdays })}
            t={t}
          />
        </div>
      )}

      {selected && kind === "monthly" && (
        <div className="mt-3">
          <NumberWithLabel
            label={t(`${i18nPrefix}.dayOfMonth.label`)}
            value={sub.dayOfMonth}
            min={1}
            max={31}
            disabled={disabled}
            onChange={(dayOfMonth) => onSubChange({ dayOfMonth })}
          />
        </div>
      )}

      {selected && kind === "everyNMonths" && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <NumberWithSuffix
            value={sub.intervalMonths}
            min={1}
            max={12}
            suffix={t(`${i18nPrefix}.intervalMonths.suffix`)}
            disabled={disabled}
            onChange={(intervalMonths) => onSubChange({ intervalMonths })}
          />
          <span className="text-muted-foreground pb-2 text-sm">
            {t(`${i18nPrefix}.intervalMonths.dayOnLabel`)}
          </span>
          <NumberWithLabel
            label=""
            value={sub.dayOfMonth}
            min={1}
            max={31}
            disabled={disabled}
            onChange={(dayOfMonth) => onSubChange({ dayOfMonth })}
          />
        </div>
      )}

      {selected && kind === "yearly" && (
        <div className="mt-3">
          <YearlyDate
            value={sub.yearlyDate}
            disabled={disabled}
            i18nPrefix={i18nPrefix}
            onChange={(yearlyDate) => onSubChange({ yearlyDate })}
            t={t}
          />
        </div>
      )}

      {selected && kind === "rolling" && (
        <div className="mt-3 space-y-2">
          <NumberWithSuffix
            value={sub.rollingDays}
            min={1}
            max={365}
            suffix={t(`${i18nPrefix}.rollingDays.suffix`)}
            disabled={disabled}
            onChange={(rollingDays) => onSubChange({ rollingDays })}
          />
          <p
            className="text-muted-foreground text-xs"
            data-slot="cadence-rolling-explainer"
          >
            {t(`${i18nPrefix}.kind.rollingExplainer`)}
          </p>
        </div>
      )}

      {/* oneShot has no sub-controls — the dose date lives in CourseWindowRow. */}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sub-controls
// ────────────────────────────────────────────────────────────────────

interface WeekdayChipsProps {
  selected: WeekdayToken[];
  disabled: boolean;
  i18nPrefix: string;
  onChange: (next: WeekdayToken[]) => void;
  t: (key: string) => string;
}

function WeekdayChips({
  selected,
  disabled,
  i18nPrefix,
  onChange,
  t,
}: WeekdayChipsProps) {
  const set = useMemo(() => new Set(selected), [selected]);
  const toggle = (tok: WeekdayToken) => {
    const next = new Set(set);
    if (next.has(tok)) next.delete(tok);
    else next.add(tok);
    onChange(WEEKDAY_TOKENS.filter((w) => next.has(w)));
  };

  return (
    <div
      role="group"
      aria-label={t(`${i18nPrefix}.weekdays.label`)}
      className="flex flex-wrap gap-1.5"
      data-slot="cadence-weekday-chips"
    >
      {WEEKDAY_TOKENS.map((tok) => {
        const isOn = set.has(tok);
        const short = t(`${i18nPrefix}.weekdays.short.${tok.toLowerCase()}`);
        const long = t(`${i18nPrefix}.weekdays.long.${tok.toLowerCase()}`);
        return (
          <button
            key={tok}
            type="button"
            disabled={disabled}
            aria-pressed={isOn}
            aria-label={long}
            data-slot="cadence-weekday-chip"
            data-token={tok}
            data-active={isOn ? "true" : "false"}
            onClick={() => toggle(tok)}
            className={[
              "focus-visible:ring-ring inline-flex h-11 min-w-11 items-center justify-center rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50",
              isOn
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border bg-background text-foreground hover:bg-muted",
            ].join(" ")}
          >
            {short}
          </button>
        );
      })}
    </div>
  );
}

interface NumberWithSuffixProps {
  value: number;
  min: number;
  max: number;
  suffix: string;
  disabled: boolean;
  onChange: (next: number) => void;
}

function NumberWithSuffix({
  value,
  min,
  max,
  suffix,
  disabled,
  onChange,
}: NumberWithSuffixProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="sr-only">
        {suffix}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-11 w-20"
        inputMode="numeric"
        data-slot="cadence-number-input"
      />
      <span className="text-sm">{suffix}</span>
    </div>
  );
}

interface NumberWithLabelProps {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (next: number) => void;
}

function NumberWithLabel({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: NumberWithLabelProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      {label ? (
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
      ) : null}
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-11 w-20"
        inputMode="numeric"
        aria-label={label || undefined}
        data-slot="cadence-number-input"
      />
    </div>
  );
}

interface YearlyDateProps {
  value: string;
  disabled: boolean;
  i18nPrefix: string;
  onChange: (next: string) => void;
  t: (key: string) => string;
}

function YearlyDate({ value, disabled, i18nPrefix, onChange, t }: YearlyDateProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-sm">
        {t(`${i18nPrefix}.yearly.date.label`)}
      </Label>
      <Input
        id={id}
        type="date"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-11"
        data-slot="cadence-yearly-date"
      />
    </div>
  );
}
