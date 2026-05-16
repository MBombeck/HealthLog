"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Native date input that hints the active locale via `lang=`. Browsers
 * use this hint to render the calendar widget in dd.MM.yyyy / MM/dd/yyyy
 * order, which is the user-visible format we want to follow the app's
 * EN/DE preference. Wrapping the prop here keeps every callsite from
 * having to pull `locale` out of `useTranslations()` just to feed it
 * back into the same JSX prop, and guarantees a future date input
 * cannot silently regress by forgetting the hint.
 *
 * v1.4.33 — height parity with `<Input>` and `<NativeSelect>`.
 *
 *   Mobile Safari + Android Chrome give `type="date"` (and
 *   `type="datetime-local"`) an intrinsic chrome that puffs the
 *   field past Tailwind's `h-10`, so the DOB cell on
 *   `/settings/account` rendered ~6 px taller than its row siblings
 *   and roughly 12 px wider on the Pixel-5 mobile-pass screenshots.
 *   `appearance-none` switches the native widget off, then
 *   `min-h-10` re-asserts the contract that every other input
 *   primitive ships. The `:webkit-date-and-time-value` shadow rule
 *   forces the embedded value text to occupy at least one full line
 *   even when iOS shrinks its placeholder, so the field looks
 *   identical on both engines.
 */
const DATE_INPUT_HEIGHT_CLASSES =
  "appearance-none min-h-10 h-10 [&::-webkit-date-and-time-value]:min-h-[1.5em]";

type InputProps = React.ComponentProps<typeof Input>;
type DateInputProps = Omit<InputProps, "type" | "lang">;

export function DateInput({ className, ...props }: DateInputProps) {
  const { locale } = useTranslations();
  return (
    <Input
      type="date"
      lang={locale}
      className={cn(DATE_INPUT_HEIGHT_CLASSES, className)}
      {...props}
    />
  );
}

export function DateTimeInput({ className, ...props }: DateInputProps) {
  const { locale } = useTranslations();
  return (
    <Input
      type="datetime-local"
      lang={locale}
      className={cn(DATE_INPUT_HEIGHT_CLASSES, className)}
      {...props}
    />
  );
}
