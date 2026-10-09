"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import dynamic from "next/dynamic";
import type { Matcher } from "react-day-picker";

import { cn } from "@/lib/utils";
import { useTranslations, useDateFormatPreference } from "@/lib/i18n/context";
import { formatDate, parseIsoDate } from "@/lib/date-format";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The calendar (react-day-picker and the date-fns month names of every
 * interface language) loads when the popover first opens, not with every
 * form that holds a date field: it is the heaviest part of the field and
 * the only one a person may never use. Until it arrives the popover keeps
 * the calendar's footprint.
 */
const DateFieldCalendar = dynamic(
  () => import("./date-field-calendar").then((m) => m.DateFieldCalendar),
  {
    ssr: false,
    loading: () => (
      <div data-slot="date-field-calendar-loading" className="h-72 w-64" />
    ),
  },
);

/**
 * Dependency-free date input that DISPLAYS the value in the user's date-order
 * preference (AUTO follows the locale; DMY / MDY / YMD pin the field order)
 * while editing rides a fully app-controlled calendar — no native date picker.
 *
 * The committed VALUE is always ISO `yyyy-MM-dd` — identical to the native
 * `<input type="date">` contract `<DateInput>` ships — so this is a drop-in
 * for `<DateInput>` and existing react-hook-form wiring is unchanged.
 *
 * How it works:
 *   - A text overlay paints the formatted display string (or the placeholder)
 *     and stays editable: the user can type a date directly. On blur / Enter we
 *     parse what they typed against the active locale order and, on a clean
 *     parse, commit the ISO value through `commitIso`.
 *   - The calendar button is a `<Popover>` trigger; the popover holds the
 *     shadcn `<Calendar>` (react-day-picker). Picking a day commits the ISO
 *     value and closes the popover. The calendar renders identically on every
 *     browser / OS — the native picker's per-platform chrome (and its mobile
 *     quirks) is gone.
 *   - A hidden mirror input carries `name` + the ISO value so any caller that
 *     relies on native form submission still sees a normal field; the forwarded
 *     ref points at it for react-hook-form `register()` parity.
 *
 * Height / a11y / target-size parity with `<DateInput>`: the same
 * `min-h-11 h-11 sm:min-h-10 sm:h-10` floor (WCAG 2.5.5 — 44 px on mobile,
 * 40 px on sm+) and focus vocabulary as the rest of the input primitives.
 */

// Mirrors the `<DateInput>` height contract (minus the date-shadow rule, which
// only applies to the native value text — here no native input is rendered).
const FIELD_HEIGHT_CLASSES = "min-h-11 h-11 sm:min-h-10 sm:h-10";

// `min-w-0` is load-bearing, not cosmetic. A field is almost always a flex item
// (the date/time row, a form grid cell), and a flex item's `min-width: auto`
// resolves to its content-based minimum. The content here contains a text
// `<input>`, whose intrinsic width comes from the `size` attribute's default of
// 20 characters (~180 px) — so without this the field refuses to render below
// ~230 px no matter what width the parent hands it, and the surplus spills out
// of whatever dialog or sheet it sits in. See the matching note on the overlay
// input below; both ends are needed, one alone still floors the box.
// The focus vocabulary matches `<Input>` exactly: the border turns the neutral
// `input-focus` tone, with no ring. The earlier `ring-2 ring-offset-2`
// painted a hard 4 px ring OUTSIDE the box — wider than the field's div and
// visibly mismatched next to the app's other inputs, and it shifted the
// highlight box on focus. `text-base md:pointer-fine:text-sm` mirrors
// `<Input>` too: a sub-16 px input triggers iOS Safari's focus auto-zoom,
// which reads as a layout jump; 16 px on every touch screen suppresses it
// (`pointer-fine`, globals.css — a width breakpoint alone missed a phone
// held sideways and every iPad).
const FIELD_BASE_CLASSES =
  "border-input bg-background text-foreground placeholder:text-muted-foreground relative flex w-full min-w-0 items-center rounded-md border ps-3 pe-2 text-base md:pointer-fine:text-sm shadow-xs transition-[color,box-shadow] focus-within:border-input-focus focus-within:outline-none";

export interface DateFieldProps {
  id?: string;
  name?: string;
  /** ISO `yyyy-MM-dd` (controlled). */
  value?: string;
  /** Initial ISO `yyyy-MM-dd` (uncontrolled). */
  defaultValue?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  required?: boolean;
  /** Autofill hint forwarded to the hidden mirror input (e.g. "bday"). */
  autoComplete?: string;
  /** ISO `yyyy-MM-dd`. */
  min?: string;
  /** ISO `yyyy-MM-dd`. */
  max?: string;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "data-testid"?: string;
}

export const DateField = React.forwardRef<HTMLInputElement, DateFieldProps>(
  function DateField(
    {
      id,
      name,
      value,
      defaultValue,
      onChange,
      onBlur,
      disabled,
      required,
      autoComplete,
      min,
      max,
      placeholder,
      className,
      "aria-label": ariaLabel,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      "data-testid": dataTestId,
      ...rest
    },
    forwardedRef,
  ) {
    const { locale, t } = useTranslations();
    const dateFormat = useDateFormatPreference();

    // Track the ISO value so the overlay reflects controlled + uncontrolled
    // updates. Controlled `value` always wins on render.
    const [internal, setInternal] = React.useState(defaultValue ?? "");
    const iso = value ?? internal;

    // Mirror what the user is typing into the overlay; cleared back to the
    // formatted string whenever the committed ISO value changes.
    const [typed, setTyped] = React.useState<string | null>(null);

    // Calendar popover open state — selecting a day commits + closes.
    const [open, setOpen] = React.useState(false);

    const display = formatDate(iso, dateFormat, locale);
    const overlayValue = typed ?? display;

    const minDate = min ? isoToDate(min) : undefined;
    const maxDate = max ? isoToDate(max) : undefined;
    const selectedDate = isoToDate(iso);

    function commitIso(next: string) {
      const clamped = clampIso(next, min, max);
      if (value === undefined) setInternal(clamped);
      setTyped(null);
      onChange?.(clamped);
    }

    // Progressive enhancement: parse free-typed text against the active locale
    // order. We feed the typed string to the browser's own parser via a throw-
    // away Date only when it matches the ISO shape; otherwise we accept a small
    // set of separator-flexible numeric forms keyed off the preference.
    function commitTyped() {
      if (typed === null) return;
      const trimmed = typed.trim();
      if (trimmed === "") {
        commitIso("");
        return;
      }
      const parsed = parseTypedDate(trimmed, dateFormat, locale);
      if (parsed) {
        commitIso(parsed);
      } else {
        // Unparseable — discard the draft and snap back to the committed value.
        setTyped(null);
      }
    }

    // react-day-picker gates out-of-range days; `commitIso` still clamps typed
    // entry, so the two agree on the bounds.
    const disabledMatchers: Matcher[] = [];
    if (minDate) disabledMatchers.push({ before: minDate });
    if (maxDate) disabledMatchers.push({ after: maxDate });

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <div
          className={cn(FIELD_BASE_CLASSES, FIELD_HEIGHT_CLASSES, className)}
          data-slot="date-field"
          data-disabled={disabled ? "" : undefined}
        >
          {/* Hidden mirror — carries `name` + value for native submits and is
              the target of the forwarded ref. */}
          <input
            {...rest}
            ref={forwardedRef}
            id={id}
            name={name}
            type="hidden"
            value={iso}
            disabled={disabled}
            required={required}
            autoComplete={autoComplete}
            readOnly
          />
          {/* Editable display overlay. */}
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            data-testid={dataTestId}
            // `min-w-0` releases the input's own automatic minimum size (the
            // 20-character intrinsic width of a text input). Without it the
            // input is the widest thing in the field and the field cannot
            // shrink to the width its parent offers.
            className="placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent py-1 outline-none disabled:cursor-not-allowed"
            value={overlayValue}
            placeholder={placeholder ?? formatPlaceholder(dateFormat, locale)}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid}
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
              disabled={disabled}
              aria-label={t("common.openDatePicker")}
              // The button paints at 32 px; the `::before` halo (6 px per edge)
              // makes the touch target 44 px without changing the field.
              className="text-muted-foreground hover:text-foreground relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md before:absolute before:-inset-1.5 before:content-[''] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CalendarIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </div>
        <PopoverContent className="w-auto p-0" align="start">
          <DateFieldCalendar
            selected={selectedDate}
            onSelect={(d) => {
              commitIso(d ? dateToIso(d) : "");
              setOpen(false);
            }}
            disabled={disabledMatchers.length ? disabledMatchers : undefined}
            defaultMonth={selectedDate ?? new Date()}
            appLocale={locale}
          />
        </PopoverContent>
      </Popover>
    );
  },
);

/** Placeholder that mirrors the active field order, e.g. "DD.MM.YYYY". */
function formatPlaceholder(
  dateFormat: ReturnType<typeof useDateFormatPreference>,
  locale: ReturnType<typeof useTranslations>["locale"],
): string {
  // 2026-12-31 renders unambiguously in every order, so its formatted shape
  // doubles as a self-describing placeholder hint.
  return formatDate("2026-12-31", dateFormat, locale)
    .replace(/31/g, "DD")
    .replace(/12/g, "MM")
    .replace(/2026/g, "YYYY");
}

/**
 * Best-effort parse of a free-typed date into ISO `yyyy-MM-dd`. Accepts the
 * active preference's field order with `.`, `/`, or `-` separators, plus a
 * bare ISO string. Returns null when the parts don't form a real calendar
 * date so the caller can reject the draft.
 */
function parseTypedDate(
  input: string,
  dateFormat: ReturnType<typeof useDateFormatPreference>,
  locale: ReturnType<typeof useTranslations>["locale"],
): string | null {
  // A clean ISO string always wins.
  const isoDirect = parseIsoDate(input);
  if (isoDirect) return toIso(isoDirect);

  const parts = input.split(/[./-]/).map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => p === "" || !/^\d+$/.test(p))) {
    return null;
  }
  const nums = parts.map(Number) as [number, number, number];

  const order = resolveOrder(dateFormat, locale);
  let year: number, month: number, day: number;
  if (order === "MDY") [month, day, year] = nums;
  else if (order === "YMD") [year, month, day] = nums;
  else [day, month, year] = nums; // DMY

  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const candidate = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  const round = parseIsoDate(candidate);
  return round ? candidate : null;
}

function resolveOrder(
  dateFormat: ReturnType<typeof useDateFormatPreference>,
  locale: ReturnType<typeof useTranslations>["locale"],
): "DMY" | "MDY" | "YMD" {
  if (dateFormat === "DMY") return "DMY";
  if (dateFormat === "MDY") return "MDY";
  if (dateFormat === "YMD") return "YMD";
  // AUTO: en → MDY, every other shipped locale → DMY.
  return locale === "en" ? "MDY" : "DMY";
}

/**
 * ISO `yyyy-MM-dd` → a LOCAL `Date` at midnight (no UTC shift — the value is a
 * plain calendar date, so it must read back as the same day in the user's
 * zone). Returns undefined for an empty / malformed value.
 */
function isoToDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  // Reject rollover (e.g. 2026-02-31): a real date round-trips its parts.
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(m) - 1 ||
    date.getDate() !== Number(d)
  ) {
    return undefined;
  }
  return date;
}

/** LOCAL `Date` → ISO `yyyy-MM-dd` read in the user's own zone (no UTC shift). */
function dateToIso(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(
    date.getDate(),
    2,
  )}`;
}

/** Clamp an ISO `yyyy-MM-dd` string to `[min, max]` (lexical = chronological). */
function clampIso(value: string, min?: string, max?: string): string {
  if (value === "") return value;
  let out = value;
  if (min && out < min) out = min;
  if (max && out > max) out = max;
  return out;
}

function toIso(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(
    date.getUTCDate(),
    2,
  )}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
