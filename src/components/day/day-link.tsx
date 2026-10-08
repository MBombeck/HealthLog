"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { DAY_QUERY_PARAM, type DateKey } from "@/lib/day/contract";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
import {
  dateOnlyKey,
  isDateOnlyKey,
  isNoonUtcAnchor,
} from "@/lib/tz/date-only";
import { cn } from "@/lib/utils";

import { openDay, useOpenDay, type DayFocus } from "./day-layer-controller";
import { dateKeyOfInstant, isOpenableDay } from "./day-url";
import { useTodayKey } from "./use-today-key";

/**
 * A date that opens its day: the one affordance for "show me everything on
 * this day" across the app.
 *
 * Text in the foreground colour with a quiet underline in the border colour,
 * no icon, no colour of its own. It sits beside whatever the row already does:
 * the row keeps opening its entry, the date opens the day. On a touch screen
 * the hit area grows to 44 px without moving the line it sits in.
 *
 * A date in the future, or one that is not a calendar date, renders as plain
 * text: a day without content is a dead end, so nothing offers it.
 *
 * It is a real link to `?day=` on the current page, so it can be opened in a
 * new tab; a plain click opens the layer in place instead of navigating.
 */
export interface DayLinkProps {
  date: DateKey;
  children: ReactNode;
  /** What the person was looking at, shown at the top of the day. */
  focus?: Omit<DayFocus, "date">;
  className?: string;
  /** Size of the text; the link inherits it otherwise. */
  size?: "xs" | "sm";
  /**
   * `-1` keeps the link out of the tab order where its surface already owns
   * the keyboard (a roving-tabindex grid of cards), and offers the day on
   * another keyboard path.
   */
  tabIndex?: number;
}

export const DAY_LINK_CLASS = cn(
  "text-foreground decoration-border relative rounded-sm underline decoration-[1.5px] underline-offset-[3px] tabular-nums",
  "hover:decoration-foreground focus-visible:ring-ring/50 transition-colors focus-visible:ring-[3px] focus-visible:outline-none",
  // A 44 px hit area on touch that does not change the line height.
  "pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3 pointer-coarse:after:inset-x-0 pointer-coarse:after:content-['']",
);

/** The open day is marked like a selected row, not underlined. */
export const DAY_LINK_OPEN_CLASS =
  "bg-muted -mx-1.5 px-1.5 no-underline decoration-transparent";

export function DayLink({
  date,
  children,
  focus,
  className,
  size,
  tabIndex,
}: DayLinkProps) {
  const { t } = useTranslations();
  const pathname = usePathname();
  const today = useTodayKey();
  const open = useOpenDay();

  if (!isOpenableDay(date, today)) {
    return (
      <span
        data-slot="day-link-plain"
        className={cn(
          "tabular-nums",
          size === "xs" && "text-xs",
          size === "sm" && "text-sm",
          className,
        )}
      >
        {children}
      </span>
    );
  }

  const isOpen = open === date;
  return (
    <a
      href={`${pathname}?${DAY_QUERY_PARAM}=${date}`}
      data-slot="day-link"
      data-day={date}
      data-open={isOpen ? "true" : undefined}
      tabIndex={tabIndex}
      title={t("day.openDay")}
      onClick={(event) => {
        // A modified click opens a new tab or window, as any link does.
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        // The row around the date opens its entry; this click is the day's.
        event.stopPropagation();
        openDay(date, {
          focus: focus ? { ...focus, date } : null,
          trigger: event.currentTarget,
        });
      }}
      onKeyDown={(event) => {
        // A row that opens on Enter must not also open under the day.
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      className={cn(
        DAY_LINK_CLASS,
        size === "xs" && "text-xs",
        size === "sm" && "text-sm",
        isOpen && DAY_LINK_OPEN_CLASS,
        className,
      )}
    >
      {children}
    </a>
  );
}

/**
 * A `DayLink` for an instant (a reading's `measuredAt`, an intake's
 * `takenAt`): the day is the instant's calendar day in the record's display
 * zone, the zone every date on screen is printed in.
 */
export function DayLinkAt({
  at,
  ...props
}: Omit<DayLinkProps, "date"> & { at: Date | string | number }) {
  const timeZone = useDisplayTimezone();
  return <DayLink date={dateKeyOfInstant(at, timeZone)} {...props} />;
}

/**
 * A `DayLink` for a value that may be a stated calendar date stored at noon
 * UTC (a lab draw date, a report date) or a real instant. A noon-UTC anchor
 * is its UTC date in every zone; anything else is cut in the display zone,
 * exactly as the surface prints it.
 */
export function DayLinkStated({
  at,
  ...props
}: Omit<DayLinkProps, "date"> & { at: string | Date }) {
  const timeZone = useDisplayTimezone();
  if (typeof at === "string" && isDateOnlyKey(at)) {
    return <DayLink date={at} {...props} />;
  }
  const instant = new Date(at);
  const date = isNoonUtcAnchor(instant)
    ? dateOnlyKey(instant)
    : dateKeyOfInstant(instant, timeZone);
  return <DayLink date={date} {...props} />;
}

/**
 * Put a node where a translated sentence names a value. Pass the marker as
 * the parameter (`t("illness.onsetOn", { date: DAY_LINK_SLOT })`) and the
 * link replaces it, so a date inside a sentence can open its day without the
 * sentence being split into fragments in the bundle.
 */
export const DAY_LINK_SLOT = "⁣day⁣";

export function withDayLinkSlot(text: string, node: ReactNode): ReactNode {
  const at = text.indexOf(DAY_LINK_SLOT);
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      {node}
      {text.slice(at + DAY_LINK_SLOT.length)}
    </>
  );
}
