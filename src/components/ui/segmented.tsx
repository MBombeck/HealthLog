"use client";

/**
 * The segmented control: a short row of mutually exclusive choices (zoom
 * level, chronicle grouping, cards or table, recent or all,
 * Paperless-ngx or Papra). One look everywhere, the one the dashboard chart
 * tabs always had: no track, the chosen segment filled in the primary colour,
 * the others plain until hovered. A muted track with a raised segment was
 * tried and read as heavier than the card around it.
 *
 * Two sizes: `md` (default) for a choice that is the content of its area (a
 * view switch, a form sheet, a detail page's sections), `sm` for a range row
 * in a chart header, where the segments sit beside the chart's title and
 * must not outweigh it.
 *
 * Two semantics, one chrome:
 *
 * - `mode="radio"` (default): an ARIA radiogroup with one tab stop and arrow
 *   keys through the shared roving helper. `onChange` fires on every press,
 *   the chosen segment included, because a segment can open something (the
 *   timeline's custom range re-opens its popover).
 * - `mode="toggle"`: buttons with `aria-pressed`, for a view switch and for a
 *   choice inside a form sheet (the sheets' discard guard reads any checked
 *   radio as the person's input, and a precision that starts on "Day" is a
 *   default, not an answer). Pressing the active segment does nothing, so a
 *   setter that saves a preference is not called twice.
 *
 * Touch: every segment is at least 44 px on a coarse pointer and 36 px under
 * a mouse, the same floor `Button` carries; a `sm` range row keeps 44 px
 * under a mouse too, as the chart tabs always had. The four controls this
 * replaced sat at 36, 36, 44 and 44.
 *
 * An option with an `icon` and `iconOnly` on the control renders the icon and
 * names the segment through `aria-label` and `title`.
 */
import { Fragment, type ReactElement, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import { cn } from "@/lib/utils";

/**
 * The two paints of a segment. `Tabs` (`ui/tabs.tsx`) is the same control
 * with panels under it and spells these under its own state selector;
 * `tabs.test.tsx` holds the two to the same tokens.
 */
export const SEGMENT_CHOSEN =
  "bg-primary text-primary-foreground hover:bg-primary/90";
export const SEGMENT_REST =
  "text-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Rendered after the label (a connected check beside a system name). */
  trailing?: ReactNode;
  /** A longer name shown on hover ("Last 7 days" for "7d"). */
  title?: string;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Accessible name of the group. */
  label: string;
  /** `data-slot` of the group. */
  slot?: string;
  /**
   * `data-slot` of one segment. Defaults to `${slot}-${value}` when the group
   * has a slot.
   */
  optionSlot?: (value: T) => string;
  mode?: "radio" | "toggle";
  /** Render the options' icons only; the label becomes the accessible name. */
  iconOnly?: boolean;
  /** Spread the segments over the full width. */
  stretch?: boolean;
  /** `sm` for a range row in a chart header; see the module comment. */
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  /**
   * Wraps one segment's button, for a popover anchored to it (the range
   * segment). Returns the button itself for every other segment.
   */
  wrapOption?: (value: T, button: ReactElement) => ReactNode;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  slot,
  optionSlot,
  mode = "radio",
  iconOnly = false,
  stretch = false,
  size = "md",
  disabled = false,
  className,
  wrapOption,
}: SegmentedProps<T>) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const { getRadioProps } = useRovingRadioGroup({
    count: options.length,
    selectedIndex,
    onSelect: (index) => {
      if (!disabled) onChange(options[index].value);
    },
  });
  const segmentSlot =
    optionSlot ?? (slot ? (v: T) => `${slot}-${v}` : undefined);

  return (
    <div
      role={mode === "toggle" ? "group" : "radiogroup"}
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-slot={slot}
      className={cn(
        "inline-flex shrink-0 items-center gap-1",
        stretch && "flex w-full",
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const Icon = option.icon;
        const button = (
          <button
            key={option.value}
            type="button"
            {...(mode === "toggle"
              ? { "aria-pressed": checked }
              : {
                  role: "radio",
                  "aria-checked": checked,
                  ...getRadioProps(index),
                })}
            {...(iconOnly
              ? {
                  "aria-label": option.label,
                  title: option.title ?? option.label,
                }
              : option.title
                ? { title: option.title }
                : {})}
            disabled={disabled}
            data-value={option.value}
            data-slot={segmentSlot?.(option.value)}
            onClick={() => {
              if (mode === "toggle" && checked) return;
              onChange(option.value);
            }}
            className={cn(
              "focus-visible:ring-ring/50 inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none",
              size === "sm" ? "text-xs" : "text-sm",
              iconOnly
                ? "size-9 pointer-coarse:size-11"
                : size === "sm"
                  ? "min-h-11 px-2 sm:px-3 pointer-coarse:min-w-11"
                  : "min-h-9 px-3 pointer-coarse:min-h-11",
              stretch && "flex-1",
              checked
                ? // A faded fill reads ~2:1 in light mode; disabled swaps to
                  // the token pair `Button` uses instead of the opacity.
                  [
                    SEGMENT_CHOSEN,
                    "disabled:bg-primary-disabled disabled:text-primary-disabled-foreground disabled:opacity-100",
                  ]
                : SEGMENT_REST,
            )}
          >
            {Icon ? (
              <Icon className="size-4 shrink-0" aria-hidden="true" />
            ) : null}
            {iconOnly ? null : option.label}
            {iconOnly ? null : option.trailing}
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
