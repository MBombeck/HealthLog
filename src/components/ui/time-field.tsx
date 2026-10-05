"use client";

import * as React from "react";
import { Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations, useTimeFormatPreference } from "@/lib/i18n/context";
import { hourCycleOptions } from "@/lib/format-locale";

/**
 * App-controlled time input. The committed VALUE is always a 24-hour
 * `"HH:mm"` string — identical to the native `<input type="time">` contract —
 * so this is a drop-in for it and existing form wiring is unchanged.
 *
 * Why it exists: the native `<input type="time">` / `datetime-local` picker
 * renders its clock (and the AM/PM toggle) according to the BROWSER UI
 * language, NOT the page `lang` and NOT the app's time-format preference. A
 * user on an English-language browser saw an AM/PM picker even with H24
 * selected. This component owns the picker, so the hour cycle always follows
 * the user's preference.
 *
 * How it works mirrors `<DateField>`:
 *   - A text overlay paints (and lets you type) the time in the user's hour-
 *     cycle preference (H24 → "14:30", H12 → "2:30 PM", AUTO → locale default).
 *     Free-typed entry is parsed tolerantly ("1430", "2:30pm", "14:30").
 *   - A clock button opens a dependency-free Popover with hour / minute (and,
 *     in 12-hour mode, AM/PM) columns. The columns ALWAYS reflect the
 *     preference — never the browser.
 *
 * Height / a11y / target-size parity with `<DateField>`: the same
 * `min-h-11 h-11 sm:min-h-10 sm:h-10` floor (WCAG 2.5.5) and field chrome.
 */

const FIELD_HEIGHT_CLASSES = "min-h-11 h-11 sm:min-h-10 sm:h-10";

// `min-w-0` mirrors `<DateField>` and carries the same reason: a flex item's
// automatic minimum size would otherwise be the 20-character intrinsic width of
// the text input inside, which floors the whole field at ~230 px and overflows
// the dialog that hosts it. See the note in `date-field.tsx`.
// Focus vocabulary and font-size parity with `<Input>` / `<DateField>`: the
// border turns the neutral `input-focus` tone with no ring (not the old hard
// `ring-2 ring-offset-2`, which painted 4 px outside the div and jumped on
// focus) and `text-base md:text-sm`
// to keep iOS Safari from auto-zooming a sub-16 px input.
const FIELD_BASE_CLASSES =
  "border-input bg-background text-foreground placeholder:text-muted-foreground relative flex w-full min-w-0 items-center rounded-md border ps-3 pe-2 text-base md:text-sm shadow-xs transition-[color,box-shadow] focus-within:border-input-focus focus-within:outline-none";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface TimeFieldProps {
  id?: string;
  name?: string;
  /** 24-hour `"HH:mm"` (controlled). */
  value?: string;
  /** Initial 24-hour `"HH:mm"` (uncontrolled). */
  defaultValue?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
  "data-testid"?: string;
}

export const TimeField = React.forwardRef<HTMLInputElement, TimeFieldProps>(
  function TimeField(
    {
      id,
      name,
      value,
      defaultValue,
      onChange,
      onBlur,
      disabled,
      required,
      placeholder,
      className,
      "aria-label": ariaLabel,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      "aria-required": ariaRequired,
      "data-testid": dataTestId,
    },
    forwardedRef,
  ) {
    const { locale, t } = useTranslations();
    const timeFormat = useTimeFormatPreference();
    const use12h = prefersTwelveHour(timeFormat, locale);

    const innerRef = React.useRef<HTMLInputElement | null>(null);
    const setRefs = React.useCallback(
      (node: HTMLInputElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    const [internal, setInternal] = React.useState(defaultValue ?? "");
    const hhmm = value ?? internal;

    // Mirror what the user is typing; cleared back to the formatted string
    // whenever the committed value changes.
    const [typed, setTyped] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState(false);

    const display = formatHhmm(hhmm, timeFormat, locale);
    const overlayValue = typed ?? display;

    function commit(next: string) {
      if (value === undefined) setInternal(next);
      setTyped(null);
      onChange?.(next);
    }

    function commitTyped() {
      if (typed === null) return;
      const trimmed = typed.trim();
      if (trimmed === "") {
        commit("");
        return;
      }
      const parsed = parseTypedTime(trimmed);
      if (parsed) commit(parsed);
      else setTyped(null); // snap back to the committed value
    }

    const parts = parseHhmm(hhmm);

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <div
          className={cn(FIELD_BASE_CLASSES, FIELD_HEIGHT_CLASSES, className)}
          data-slot="time-field"
          data-disabled={disabled ? "" : undefined}
        >
          {/* Hidden mirror so the value participates in native form submits. */}
          <input
            ref={setRefs}
            type="hidden"
            id={id}
            name={name}
            value={hhmm}
            disabled={disabled}
            required={required}
            readOnly
          />
          {/* Editable display overlay. */}
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            data-testid={dataTestId}
            // See `date-field.tsx`: without `min-w-0` the input's intrinsic
            // 20-character width becomes the field's floor.
            className="placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent py-1 outline-none disabled:cursor-not-allowed"
            value={overlayValue}
            placeholder={placeholder ?? (use12h ? "--:-- --" : "--:--")}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid}
            aria-required={ariaRequired}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTyped();
              }
            }}
            onBlur={() => {
              commitTyped();
              onBlur?.();
            }}
          />
          <PopoverTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              disabled={disabled}
              aria-label={t("common.openTimePicker")}
              // The button paints at 32 px; the `::before` halo (6 px per edge)
              // makes the touch target 44 px without changing the field.
              className="text-muted-foreground hover:text-foreground relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md before:absolute before:-inset-1.5 before:content-[''] disabled:cursor-not-allowed disabled:opacity-50"
              data-slot="time-field-trigger"
            >
              <Clock className="h-4 w-4" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </div>
        <PopoverContent
          align="start"
          className="w-auto p-0"
          data-slot="time-field-popover"
        >
          <TimeColumns
            use12h={use12h}
            parts={parts}
            onPick={(next) => commit(next)}
            hoursLabel={t("common.hours")}
            minutesLabel={t("common.minutes")}
            periodLabel={t("common.period")}
            amLabel={t("common.am")}
            pmLabel={t("common.pm")}
          />
        </PopoverContent>
      </Popover>
    );
  },
);

// ────────────────────────────────────────────────────────────────────
// Popover columns
// ────────────────────────────────────────────────────────────────────

interface TimeColumnsProps {
  use12h: boolean;
  parts: { hour: number; minute: number } | null;
  onPick: (hhmm: string) => void;
  hoursLabel: string;
  minutesLabel: string;
  periodLabel: string;
  amLabel: string;
  pmLabel: string;
}

function TimeColumns({
  use12h,
  parts,
  onPick,
  hoursLabel,
  minutesLabel,
  periodLabel,
  amLabel,
  pmLabel,
}: TimeColumnsProps) {
  const hour = parts?.hour ?? null;
  const minute = parts?.minute ?? null;
  // The selected period; default to AM so a fresh pick lands somewhere sane.
  const isPm = hour !== null ? hour >= 12 : false;

  const hourValues = use12h
    ? Array.from({ length: 12 }, (_, i) => i + 1) // 1..12
    : Array.from({ length: 24 }, (_, i) => i); // 0..23
  const minuteValues = Array.from({ length: 60 }, (_, i) => i);

  // The hour cell currently highlighted, expressed in the column's own space.
  const selectedHourCell =
    hour === null ? null : use12h ? to12hHour(hour) : hour;

  function pickHour(cell: number) {
    const baseMinute = minute ?? 0;
    const h24 = use12h ? from12hHour(cell, isPm) : cell;
    onPick(`${pad(h24)}:${pad(baseMinute)}`);
  }
  function pickMinute(m: number) {
    const baseHour = hour ?? (use12h ? 0 : 0);
    onPick(`${pad(baseHour)}:${pad(m)}`);
  }
  function pickPeriod(pm: boolean) {
    const cell = selectedHourCell ?? 12; // 12 = 12 AM / 12 PM anchor
    const h24 = from12hHour(cell, pm);
    onPick(`${pad(h24)}:${pad(minute ?? 0)}`);
  }

  return (
    <div className="flex" data-slot="time-columns">
      <Column
        label={hoursLabel}
        values={hourValues}
        selected={selectedHourCell}
        onPick={pickHour}
        format={(v) => (use12h ? String(v) : pad(v))}
        testid="time-field-hours"
      />
      <Column
        label={minutesLabel}
        values={minuteValues}
        selected={minute}
        onPick={pickMinute}
        format={(v) => pad(v)}
        testid="time-field-minutes"
      />
      {use12h && (
        <div
          className="flex flex-col border-s"
          role="group"
          aria-label={periodLabel}
          data-slot="time-field-period"
        >
          <span className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium">
            {periodLabel}
          </span>
          <div className="flex flex-col gap-0.5 p-1">
            <PeriodButton
              active={hour !== null && !isPm}
              label={amLabel}
              onClick={() => pickPeriod(false)}
            />
            <PeriodButton
              active={hour !== null && isPm}
              label={pmLabel}
              onClick={() => pickPeriod(true)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface ColumnProps {
  label: string;
  values: number[];
  selected: number | null;
  onPick: (value: number) => void;
  format: (value: number) => string;
  testid: string;
}

function Column({
  label,
  values,
  selected,
  onPick,
  format,
  testid,
}: ColumnProps) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const activeRef = React.useRef<HTMLButtonElement | null>(null);

  // Bring the selected cell into view when the popover mounts.
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center" });
  }, []);

  return (
    <div
      className="flex flex-col not-last:border-e"
      role="group"
      aria-label={label}
    >
      <span className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium">
        {label}
      </span>
      <div
        ref={listRef}
        className="flex max-h-56 flex-col gap-0.5 overflow-y-auto p-1"
        data-slot={testid}
      >
        {values.map((v) => {
          const isActive = selected === v;
          return (
            <button
              key={v}
              ref={isActive ? activeRef : undefined}
              type="button"
              aria-pressed={isActive}
              data-active={isActive ? "true" : "false"}
              onClick={() => onPick(v)}
              className={cn(
                "focus-visible:ring-ring w-12 rounded-md px-2 py-1.5 text-center text-sm tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-muted",
              )}
            >
              {format(v)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PeriodButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-active={active ? "true" : "false"}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring w-12 rounded-md px-2 py-1.5 text-center text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
        active
          ? "bg-primary text-primary-foreground"
          : "text-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers — exported for unit tests
// ────────────────────────────────────────────────────────────────────

/** AUTO follows the locale (en → 12h, every other shipped locale → 24h). */
export function prefersTwelveHour(
  timeFormat: ReturnType<typeof useTimeFormatPreference>,
  locale: string,
): boolean {
  if (timeFormat === "H12") return true;
  if (timeFormat === "H24") return false;
  return locale === "en"; // AUTO
}

/** Split a 24-hour `"HH:mm"` string into parts, or null when malformed. */
export function parseHhmm(
  value: string,
): { hour: number; minute: number } | null {
  const m = TIME_RE.exec(value.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Format a 24-hour `"HH:mm"` string for display in the user's hour cycle.
 * Returns "" for an empty / malformed value so the field paints its
 * placeholder. Renders through `Intl` with the preference's hour cycle so the
 * AM/PM affix (or its absence) matches every other clock in the app.
 */
export function formatHhmm(
  value: string,
  timeFormat: ReturnType<typeof useTimeFormatPreference>,
  locale: string,
): string {
  const parts = parseHhmm(value);
  if (!parts) return "";
  // Anchor on a fixed UTC date; only the wall-clock parts matter.
  const date = new Date(Date.UTC(2000, 0, 1, parts.hour, parts.minute));
  return date.toLocaleTimeString(locale, {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    ...hourCycleOptions(timeFormat),
  });
}

/**
 * Tolerant parse of free-typed time into a 24-hour `"HH:mm"` string. Accepts
 * "14:30", "1430", "2:30 pm", "2.30pm", "9" (→ 09:00). Returns null when the
 * components don't form a real wall-clock time.
 */
export function parseTypedTime(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (raw === "") return null;

  let pm: boolean | null = null;
  let body = raw;
  if (/\bp\.?m\.?$/.test(body) || body.endsWith("pm") || body.endsWith("p")) {
    pm = true;
  } else if (
    /\ba\.?m\.?$/.test(body) ||
    body.endsWith("am") ||
    body.endsWith("a")
  ) {
    pm = false;
  }
  body = body.replace(/[ap]\.?m?\.?$/i, "").trim();

  const digits = body.replace(/[^\d]/g, "");
  if (digits.length === 0) return null;

  let hour: number;
  let minute: number;
  if (body.includes(":") || body.includes(".")) {
    const [h, m] = body.split(/[.:]/);
    hour = Number(h);
    minute = m === undefined || m === "" ? 0 : Number(m);
  } else if (digits.length <= 2) {
    hour = Number(digits);
    minute = 0;
  } else {
    // "1430" → 14:30, "930" → 9:30
    hour = Number(digits.slice(0, digits.length - 2));
    minute = Number(digits.slice(-2));
  }

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (pm !== null) {
    if (hour < 1 || hour > 12) return null;
    hour = from12hHour(hour, pm);
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

/** 24-hour hour → its 12-hour clock cell (0/12 → 12, 13 → 1, …). */
export function to12hHour(hour24: number): number {
  const h = hour24 % 12;
  return h === 0 ? 12 : h;
}

/** 12-hour clock cell + period → 24-hour hour. */
export function from12hHour(cell: number, pm: boolean): number {
  const base = cell % 12; // 12 → 0
  return pm ? base + 12 : base;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
