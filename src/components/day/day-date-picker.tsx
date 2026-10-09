"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { resolveDateFnsLocale } from "@/components/ui/date-field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { DateKey } from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { useDayIndex } from "./use-day";

/**
 * The date in the day's header, as the way to any other day: the written
 * date is the button, and it opens a month calendar beside it. Picking a
 * day opens that day; "Today" opens today. Days that hold anything carry a
 * dot, read from `GET /api/day/index` for the month on screen.
 *
 * No icon and no field: the header keeps its one line, and the arrows
 * beside it stay the way to the neighbouring days. Radix owns the keyboard
 * (Enter or Space opens, Escape closes, focus returns to the date), and
 * the same popover serves the docked column and both sheets, with touch-
 * sized cells wherever the pointer is coarse.
 */

/** `YYYY-MM-DD` → a local `Date` at midnight, the calendar's own unit. */
export function keyToLocalDate(key: DateKey): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** A local `Date` → `YYYY-MM-DD`, read in the zone it was made in. */
export function localDateToKey(date: Date): DateKey {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}` as DateKey;
}

/** First and last day of the month that holds `month`, never past today. */
export function monthWindow(
  month: Date,
  today: DateKey,
): { from: DateKey; to: DateKey } {
  const from = localDateToKey(
    new Date(month.getFullYear(), month.getMonth(), 1),
  );
  const last = localDateToKey(
    new Date(month.getFullYear(), month.getMonth() + 1, 0),
  );
  return { from, to: last > today ? today : last };
}

/**
 * What a pick opens: the day itself, unless it is the day on screen already
 * or lies past today (the calendar disables those, this is the backstop).
 */
export function pickedDay(
  next: DateKey,
  date: DateKey,
  today: DateKey,
): DateKey | null {
  return next !== date && next <= today ? next : null;
}

export function DayDatePicker({
  date,
  today,
  label,
  onPick,
  className,
}: {
  date: DateKey;
  today: DateKey;
  /** The date as the header writes it: the button's text. */
  label: React.ReactNode;
  onPick: (date: DateKey) => void;
  className?: string;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => keyToLocalDate(date));
  const range = monthWindow(month, today);
  const index = useDayIndex(range.from, range.to, open);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Each opening starts on the month of the day on screen.
        if (next) setMonth(keyToLocalDate(date));
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="day-date-button"
          aria-haspopup="dialog"
          title={t("day.pickDate")}
          className={cn(
            "hover:bg-muted/60 focus-visible:ring-ring/50 data-[state=open]:bg-muted/60 -mx-1 block max-w-full truncate rounded-md px-1 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none",
            className,
          )}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-slot="day-date-picker"
        aria-label={t("day.pickerTitle")}
        className="w-auto p-0"
      >
        <DayCalendar
          date={date}
          today={today}
          month={month}
          onMonthChange={setMonth}
          withEntries={Object.keys(index.data?.days ?? {}) as DateKey[]}
          onPick={(next) => {
            setOpen(false);
            const day = pickedDay(next, date, today);
            if (day !== null) onPick(day);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The calendar's day button, with its date key and dot as attributes. */
function KeyedDayButton(props: React.ComponentProps<typeof CalendarDayButton>) {
  return (
    <CalendarDayButton
      {...props}
      data-date-key={localDateToKey(props.day.date)}
      data-entries={props.modifiers.entries ? "true" : undefined}
    />
  );
}

/**
 * The popover's body: the month with the day on screen selected, a dot on
 * every day that holds anything, nothing past today, and "Today" below.
 */
export function DayCalendar({
  date,
  today,
  month,
  onMonthChange,
  withEntries,
  onPick,
}: {
  date: DateKey;
  today: DateKey;
  month: Date;
  onMonthChange: (month: Date) => void;
  withEntries: readonly DateKey[];
  onPick: (date: DateKey) => void;
}) {
  const { t, locale } = useTranslations();
  const todayDate = keyToLocalDate(today);
  const dateLabel = new Intl.DateTimeFormat(resolveIntlLocale(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  // The calendar hands out local midnights; the label reads the same
  // calendar day at noon UTC, so no zone can move it.
  const labelOf = (day: Date) =>
    dateLabel.format(new Date(`${localDateToKey(day)}T12:00:00.000Z`));
  return (
    <>
      <Calendar
        mode="single"
        required
        selected={keyToLocalDate(date)}
        onSelect={(picked) => {
          if (picked) onPick(localDateToKey(picked));
        }}
        month={month}
        onMonthChange={onMonthChange}
        endMonth={todayDate}
        disabled={{ after: todayDate }}
        showOutsideDays={false}
        locale={resolveDateFnsLocale(locale)}
        modifiers={{ entries: withEntries.map(keyToLocalDate) }}
        modifiersClassNames={{
          // A dot under the number; the selected day's dot takes the
          // colour of the number on it.
          entries:
            "after:bg-primary data-[selected=true]:after:bg-primary-foreground after:pointer-events-none after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full",
        }}
        labels={{
          labelDayButton: (day, modifiers) =>
            modifiers.entries
              ? `${labelOf(day)}, ${t("day.hasEntries")}`
              : labelOf(day),
        }}
        components={{ DayButton: KeyedDayButton }}
        // 32 px cells beside a fine pointer, 40 px for a finger.
        className="[--cell-size:--spacing(10)] pointer-fine:[--cell-size:--spacing(8)]"
        autoFocus
      />
      <div className="border-border flex justify-end border-t p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="day-date-today"
          disabled={date === today}
          onClick={() => onPick(today)}
        >
          {t("day.today")}
        </Button>
      </div>
    </>
  );
}
