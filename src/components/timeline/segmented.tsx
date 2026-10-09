"use client";

/**
 * A small segmented choice (zoom, chronicle grouping, life-event precision):
 * an ARIA radiogroup with one tab stop and arrow keys, through the shared
 * roving helper. Neutral palette; the chosen segment is raised, not coloured.
 *
 * Inside a form sheet it renders as toggle buttons (`aria-pressed`) instead:
 * the sheets' discard guard reads any checked radio as the person's input,
 * and a precision that starts on "Day" is a default, not an answer.
 */
import { Fragment, type ReactElement, type ReactNode } from "react";

import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  slot,
  className,
  stretch = false,
  asToggleButtons = false,
  wrapOption,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  label: string;
  slot: string;
  className?: string;
  stretch?: boolean;
  asToggleButtons?: boolean;
  /**
   * Wraps one segment's button, for a popover anchored to it (the range
   * segment). Returns the button itself for every other segment.
   */
  wrapOption?: (value: T, button: ReactElement) => ReactNode;
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const { getRadioProps } = useRovingRadioGroup({
    count: options.length,
    selectedIndex,
    onSelect: (index) => onChange(options[index].value),
  });
  return (
    <div
      role={asToggleButtons ? "group" : "radiogroup"}
      aria-label={label}
      data-slot={slot}
      className={cn(
        "bg-muted inline-flex items-center gap-1 rounded-lg p-1",
        stretch && "flex w-full",
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const button = (
          <button
            key={option.value}
            type="button"
            {...(asToggleButtons
              ? { "aria-pressed": checked }
              : {
                  role: "radio",
                  "aria-checked": checked,
                  ...getRadioProps(index),
                })}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "focus-visible:ring-ring/50 inline-flex min-h-9 items-center justify-center rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2",
              stretch && "flex-1",
              checked
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
        return wrapOption ? (
          <Fragment key={option.value}>
            {wrapOption(option.value, button)}
          </Fragment>
        ) : (
          button
        );
      })}
    </div>
  );
}
