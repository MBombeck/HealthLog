"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { DateField } from "@/components/ui/date-field";
import { TimeField } from "@/components/ui/time-field";

/**
 * Datetime input that composes a native-calendar `<DateField>` (date part)
 * with the app-controlled `<TimeField>` (time part). The committed VALUE is a
 * local `yyyy-MM-ddTHH:mm` string — identical to the native
 * `<input type="datetime-local">` contract the original `<DateTimeField>`
 * shipped — so this stays a drop-in for existing form wiring.
 *
 * Why the split: the native `datetime-local` picker renders its time spinner
 * (and AM/PM toggle) by the BROWSER UI language, not the app's time-format
 * preference — an English-language browser showed AM/PM even under H24. The
 * date half keeps the familiar native calendar (no AM/PM there); the time half
 * routes through `<TimeField>`, whose hour cycle always follows the preference.
 *
 * `min` / `max` are honoured two ways: their date portion gates the calendar,
 * and the recombined value is clamped to `[min, max]` on every change. The
 * `yyyy-MM-ddTHH:mm` shape sorts lexicographically = chronologically, so the
 * clamp is a plain string compare.
 */

export interface DateTimeFieldProps {
  id?: string;
  name?: string;
  /** Local `yyyy-MM-ddTHH:mm` (controlled). */
  value?: string;
  /** Initial local `yyyy-MM-ddTHH:mm` (uncontrolled). */
  defaultValue?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  required?: boolean;
  /** Local `yyyy-MM-ddTHH:mm`. */
  min?: string;
  /** Local `yyyy-MM-ddTHH:mm`. */
  max?: string;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
  "data-testid"?: string;
}

export const DateTimeField = React.forwardRef<
  HTMLInputElement,
  DateTimeFieldProps
>(function DateTimeField(
  {
    id,
    name,
    value,
    defaultValue,
    onChange,
    onBlur,
    disabled,
    required,
    min,
    max,
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
  const seed = value ?? defaultValue ?? "";
  const [internal, setInternal] = React.useState(seed);
  const current = value ?? internal;

  // Split state so a half-filled field (date but no time yet) keeps both parts
  // visible even while the combined value is still empty.
  const [dateStr, setDateStr] = React.useState(() => splitDate(seed));
  const [timeStr, setTimeStr] = React.useState(() => splitTime(seed));

  // Re-sync the parts when a controlled value changes from the outside.
  React.useEffect(() => {
    if (value === undefined) return;
    setDateStr(splitDate(value));
    setTimeStr(splitTime(value));
  }, [value]);

  function commitParts(nextDate: string, nextTime: string) {
    setDateStr(nextDate);
    setTimeStr(nextTime);
    const combined =
      nextDate === ""
        ? ""
        : clamp(`${nextDate}T${nextTime || "00:00"}`, min, max);
    // A clamp can pull the time (or date) back; reflect that in the parts.
    if (combined !== "") {
      setDateStr(splitDate(combined));
      setTimeStr(splitTime(combined));
    }
    if (value === undefined) setInternal(combined);
    onChange?.(combined);
  }

  return (
    <div
      className={cn(
        // Date and time share one row at every width: stacked, the pair
        // cost a phone sheet a whole field's height for a five-character
        // time. The time takes what "23:59" and its clock need, the date
        // the rest.
        //
        // Both halves need `min-w-0`, and that lives in the field primitives
        // themselves: each field wraps a text `<input>` whose 20-character
        // intrinsic width was the field's automatic minimum size, so the row
        // demanded ~470 px inside a 400 px dialog body and spilled past the
        // edge. `min-w-0` here lets the row itself shrink inside whatever
        // grid or flex cell hosts it.
        "flex min-w-0 items-stretch gap-2",
        className,
      )}
      data-slot="date-time-field"
    >
      {/* Hidden mirror so the combined value participates in native submits. */}
      <input
        ref={forwardedRef}
        type="hidden"
        name={name}
        value={current}
        disabled={disabled}
        required={required}
        readOnly
      />
      <DateField
        id={id}
        value={dateStr}
        onChange={(d) => commitParts(d, timeStr)}
        onBlur={onBlur}
        disabled={disabled}
        min={min ? splitDate(min) : undefined}
        max={max ? splitDate(max) : undefined}
        placeholder={placeholder}
        className="min-w-0 flex-1"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        data-testid={dataTestId}
      />
      <TimeField
        value={timeStr}
        onChange={(tm) => commitParts(dateStr, tm)}
        onBlur={onBlur}
        disabled={disabled}
        className="w-28 shrink-0 sm:w-32"
        aria-label={ariaLabel}
        aria-required={ariaRequired}
      />
    </div>
  );
});

/** First 10 chars of a `yyyy-MM-ddTHH:mm` string, when well-formed. */
function splitDate(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1] : "";
}

/** The `HH:mm` portion of a `yyyy-MM-ddTHH:mm` string, when present. */
function splitTime(value: string): string {
  const m = /T(\d{2}:\d{2})/.exec(value.trim());
  return m ? m[1] : "";
}

/** Clamp a `yyyy-MM-ddTHH:mm` string to `[min, max]` (lexical = chronological). */
function clamp(value: string, min?: string, max?: string): string {
  let out = value;
  if (min && out < min) out = min;
  if (max && out > max) out = max;
  return out;
}
