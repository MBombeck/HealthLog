"use client";

/**
 * v1.5.0 — TimesOfDayChips component.
 *
 * Multi-chip HH:mm input. Each chip is removable; adding a chip opens
 * a small native `<input type="time">`. A preset row above the chips
 * offers Morning / Noon / Evening / Night — tapping a preset adds the
 * matching chip if absent, removes it if present.
 *
 * When the parent passes `maxChips=1` (one-shot context), the
 * component renders as a single `<input type="time">` (no chip list)
 * since there is nothing meaningful to add or remove beyond the one
 * value.
 *
 * Chips are sorted ascending HH:mm before display + emit. Duplicate
 * adds are no-ops.
 *
 * i18n keys consumed (namespace `medications.scheduling.timesOfDay.*`):
 *
 *   .label                 — input aria-label "Times of day"
 *   .empty.cta             — "Add the first time"
 *   .add                   — button label "Add time"
 *   .remove                — chip remove aria-label
 *   .presets.morning       — chip "Morning 08:00"
 *   .presets.noon          — chip "Noon 12:00"
 *   .presets.evening       — chip "Evening 18:00"
 *   .presets.night         — chip "Night 22:00"
 *   .max.reached           — "Maximum reached" copy
 */

import { useCallback, useId, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";

export interface TimesOfDayChipsProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Max chips. Default 8 (matches Zod schema cap). */
  maxChips?: number;
  /** Disables the input. */
  disabled?: boolean;
  /** Translation namespace prefix. */
  i18nPrefix?: string;
}

/** Preset table — wall-clock HH:mm and i18n suffix key. */
const PRESETS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "morning", value: "08:00" },
  { key: "noon", value: "12:00" },
  { key: "evening", value: "18:00" },
  { key: "night", value: "22:00" },
];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ────────────────────────────────────────────────────────────────────
// Pure helpers — exported for unit tests
// ────────────────────────────────────────────────────────────────────

/** Sort HH:mm strings ascending; ignore malformed entries. */
export function sortTimes(times: string[]): string[] {
  return [...times]
    .filter((t) => TIME_RE.test(t))
    .sort((a, b) => a.localeCompare(b));
}

/** Add a HH:mm to the list; sorted, deduped, capped at maxChips. */
export function addTime(
  current: string[],
  next: string,
  maxChips: number,
): string[] {
  if (!TIME_RE.test(next)) return current;
  if (current.includes(next)) return current;
  if (current.length >= maxChips) return current;
  return sortTimes([...current, next]);
}

/** Remove a HH:mm; returns sorted remainder. */
export function removeTime(current: string[], target: string): string[] {
  return sortTimes(current.filter((t) => t !== target));
}

/** Toggle a preset — present-then-remove, else add (if under cap). */
export function togglePreset(
  current: string[],
  preset: string,
  maxChips: number,
): string[] {
  if (current.includes(preset)) return removeTime(current, preset);
  return addTime(current, preset, maxChips);
}

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

export function TimesOfDayChips({
  value,
  onChange,
  maxChips = 8,
  disabled = false,
  i18nPrefix = "medications.scheduling.timesOfDay",
}: TimesOfDayChipsProps) {
  const { t } = useTranslations();
  const inputId = useId();
  const sortedValue = useMemo(() => sortTimes(value), [value]);
  const [draft, setDraft] = useState("");

  const onAddDraft = useCallback(() => {
    if (!draft) return;
    const next = addTime(sortedValue, draft, maxChips);
    onChange(next);
    setDraft("");
  }, [draft, maxChips, onChange, sortedValue]);

  const onRemove = (target: string) => {
    onChange(removeTime(sortedValue, target));
  };

  const onPresetToggle = (preset: string) => {
    onChange(togglePreset(sortedValue, preset, maxChips));
  };

  const atCap = sortedValue.length >= maxChips;

  // One-shot context — render a single time picker, no chip list.
  if (maxChips === 1) {
    const single = sortedValue[0] ?? "";
    return (
      <div data-slot="times-of-day-single" className="flex items-center gap-2">
        <Label htmlFor={inputId} className="sr-only">
          {t(`${i18nPrefix}.label`)}
        </Label>
        <Input
          id={inputId}
          type="time"
          value={single}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              onChange([]);
              return;
            }
            if (!TIME_RE.test(v)) return;
            onChange([v]);
          }}
          className="h-11 w-32"
          aria-label={t(`${i18nPrefix}.label`)}
        />
      </div>
    );
  }

  return (
    <div
      className="space-y-3"
      data-slot="times-of-day-chips"
      aria-label={t(`${i18nPrefix}.label`)}
    >
      {/* Preset row */}
      <div
        role="group"
        aria-label={t(`${i18nPrefix}.label`)}
        className="flex flex-wrap gap-1.5"
        data-slot="times-of-day-presets"
      >
        {PRESETS.map(({ key, value: preset }) => {
          const isOn = sortedValue.includes(preset);
          const label = `${t(`${i18nPrefix}.presets.${key}`)} ${preset}`;
          return (
            <button
              key={key}
              type="button"
              disabled={disabled || (!isOn && atCap)}
              aria-pressed={isOn}
              aria-label={label}
              data-slot="times-of-day-preset"
              data-preset={key}
              data-active={isOn ? "true" : "false"}
              onClick={() => onPresetToggle(preset)}
              className={[
                "focus-visible:ring-ring inline-flex h-11 items-center gap-1 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50",
                isOn
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border bg-background text-foreground hover:bg-muted",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Chip list */}
      {sortedValue.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-slot="times-of-day-empty"
        >
          {t(`${i18nPrefix}.empty.cta`)}
        </p>
      ) : (
        <ul
          className="flex flex-wrap gap-1.5"
          data-slot="times-of-day-list"
          aria-label={t(`${i18nPrefix}.label`)}
        >
          {sortedValue.map((time) => (
            <li
              key={time}
              data-slot="times-of-day-chip"
              data-time={time}
              className="bg-muted text-foreground inline-flex h-11 items-center gap-1.5 rounded-md border px-3 text-sm font-medium"
            >
              <span>{time}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`${t(`${i18nPrefix}.remove`)} ${time}`}
                onClick={() => onRemove(time)}
                className="focus-visible:ring-ring inline-flex h-7 w-7 items-center justify-center rounded-sm hover:bg-background focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
                data-slot="times-of-day-chip-remove"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add-new row */}
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="sr-only">
          {t(`${i18nPrefix}.add`)}
        </Label>
        <Input
          id={inputId}
          type="time"
          value={draft}
          disabled={disabled || atCap}
          onChange={(e) => setDraft(e.target.value)}
          className="h-11 w-32"
          aria-label={t(`${i18nPrefix}.add`)}
          data-slot="times-of-day-draft-input"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !draft || atCap}
          onClick={onAddDraft}
          className="h-11"
          aria-label={t(`${i18nPrefix}.add`)}
          data-slot="times-of-day-add"
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          {t(`${i18nPrefix}.add`)}
        </Button>
      </div>

      {atCap && (
        <p
          className="text-muted-foreground text-xs"
          data-slot="times-of-day-max"
        >
          {t(`${i18nPrefix}.max.reached`)}
        </p>
      )}
    </div>
  );
}
