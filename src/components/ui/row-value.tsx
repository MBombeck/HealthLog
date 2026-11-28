"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { DateField, type DateFieldProps } from "@/components/ui/date-field";
import { TimeField, type TimeFieldProps } from "@/components/ui/time-field";
import { cn } from "@/lib/utils";

/**
 * A row's value: what stands in a `ListItem`'s `trailing` slot, whether it is
 * plain text, a choice, a date or a time. UI standards §20.
 *
 * Every kind ends in the same fixed glyph slot, 32 px wide: a chevron for a
 * choice, the calendar or clock button for a date or time, nothing for text.
 * The value text is right-aligned against that slot, in the same size and
 * weight everywhere (16 px under a finger so iOS does not zoom into a focused
 * field, 14 px under a mouse), so the values of a group end on one vertical
 * line and every glyph sits the same distance from its text. No frame, no
 * fill: the glyph is the only sign a value opens something.
 *
 * Never hand a `NativeSelect`, `DateField` or `TimeField` to a row directly;
 * `row-value-guard.test.ts` refuses it.
 */

/** The value's type: one size and weight for every row value. */
const VALUE_TEXT = "text-base font-normal pointer-fine:text-sm";

/** The glyph slot every row value ends in. */
const GLYPH_SLOT = "flex size-8 shrink-0 items-center justify-center";

/** Frameless field overrides for the date and time fields. */
const FIELD = cn(
  "h-9 min-h-9 sm:h-9 sm:min-h-9 border-transparent bg-transparent shadow-none ps-0 pe-0",
  "[&_input]:text-right [&_input]:text-base pointer-fine:[&_input]:text-sm [&_input]:font-normal",
);

/** Plain text as a row's value, ending where a glyph would sit. */
function RowValue({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  /** The full value as a tooltip, for one that is cut short. */
  title?: string;
}) {
  return (
    <span
      data-slot="row-value"
      data-kind="text"
      className="flex min-w-0 items-center"
    >
      <span
        data-slot="row-value-text"
        title={title}
        className={cn(
          VALUE_TEXT,
          "max-w-[50vw] truncate text-right sm:max-w-sm",
          className,
        )}
      >
        {children}
      </span>
      <span aria-hidden className={GLYPH_SLOT} />
    </span>
  );
}

/**
 * A native select as a row's value. A select is as wide as its longest
 * option, so the chosen one is aligned right (`text-align-last`) against the
 * chevron.
 */
function RowValueSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <span
      data-slot="row-value"
      data-kind="select"
      className="flex items-center"
    >
      <select
        data-slot="row-value-text"
        className={cn(
          VALUE_TEXT,
          "text-foreground h-9 max-w-[50vw] cursor-pointer appearance-none truncate bg-transparent text-right outline-none [text-align-last:right] focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-sm",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <span aria-hidden className={cn(GLYPH_SLOT, "text-muted-foreground")}>
        <ChevronDown className="size-4" />
      </span>
    </span>
  );
}

/** A date as a row's value; the field's own calendar button is the glyph. */
function RowValueDate({ className, ...props }: DateFieldProps) {
  return (
    <span data-slot="row-value" data-kind="date" className="flex">
      <DateField className={cn(FIELD, "w-32", className)} {...props} />
    </span>
  );
}

/** A time as a row's value; the field's own clock button is the glyph. */
function RowValueTime({ className, ...props }: TimeFieldProps) {
  return (
    <span data-slot="row-value" data-kind="time" className="flex">
      <TimeField className={cn(FIELD, "w-24", className)} {...props} />
    </span>
  );
}

export { RowValue, RowValueDate, RowValueSelect, RowValueTime };
