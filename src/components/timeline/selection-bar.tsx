"use client";

/**
 * The bar under the chart (v1.42, #613): the selected month, every entry
 * that touches it as a chip (each one a way into its day), the month's
 * means of the chosen values, and "Open 3 Jan." for the selected day.
 *
 * It is also where a label the chart had to leave out is read in full, and
 * where each keyboard step on the chart is announced (`aria-live`).
 */
import { ArrowRight } from "lucide-react";

import type { TimelineResponse } from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import {
  endOfMonth,
  formatAtPrecision,
  formatDayMonth,
  formatMonthYear,
  monthOf,
  startOfMonth,
} from "./timeline-dates";
import { itemsInMonth } from "./timeline-geometry";
import { laneDotStyle } from "./timeline-chart";
import { formatMonthMeans } from "./series-format";

export interface SelectionBarProps {
  timeline: TimelineResponse;
  selected: string;
  today: string;
  onOpenDay: (date: string) => void;
  onEditLifeEvent?: (id: string) => void;
}

/** The month means of each series for the month of `date`. */
export function monthMeans(
  series: TimelineResponse["series"],
  date: string,
): Array<{ key: string; mean: number; unit: string | null }> {
  const month = monthOf(date);
  const out: Array<{ key: string; mean: number; unit: string | null }> = [];
  for (const s of series) {
    const inMonth = s.points.filter((p) => monthOf(p.t) === month);
    if (inMonth.length === 0) continue;
    const mean = inMonth.reduce((sum, p) => sum + p.mean, 0) / inMonth.length;
    out.push({ key: s.key, mean, unit: s.unit });
  }
  return out;
}

export function SelectionBar({
  timeline,
  selected,
  today,
  onOpenDay,
  onEditLifeEvent,
}: SelectionBarProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const intl = resolveIntlLocale(locale);
  const entries = itemsInMonth(timeline.lanes, selected, today);
  const means = monthMeans(timeline.series, selected);
  const monthFrom = startOfMonth(selected);
  const monthTo = endOfMonth(selected);

  return (
    <div
      className="bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2.5"
      data-slot="timeline-selection-bar"
      data-month={monthOf(selected)}
    >
      <span className="text-sm font-semibold" aria-live="polite">
        {formatMonthYear(selected, intl)}
      </span>
      {entries.length === 0 && (
        <span className="text-muted-foreground text-xs">
          {t("timeline.selection.empty")}
        </span>
      )}
      {entries.map(({ lane, item, through }) => {
        // A chip opens the day its entry touches inside this month.
        const day =
          item.start >= monthFrom && item.start <= monthTo
            ? item.start
            : monthFrom;
        const canOpenDay = item.precision === "DAY" && day <= today;
        const when =
          item.open || through
            ? t("timeline.selection.ongoing")
            : item.end && item.end !== item.start
              ? t("timeline.selection.range", {
                  from: formatDayMonth(item.start, intl),
                  to: formatDayMonth(item.end, intl),
                })
              : item.precision === "DAY"
                ? formatDayMonth(item.start, intl)
                : formatAtPrecision(item.start, item.precision, intl);
        const text = `${item.label}${item.sub ? ` ${item.sub}` : ""} · ${when}`;
        const editable = item.kind === "lifeEvent" && onEditLifeEvent;
        if (!canOpenDay && !editable) {
          return (
            <span
              key={`${lane}-${item.id}`}
              className="bg-background text-foreground text-2xs inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium"
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={laneDotStyle(lane)}
                aria-hidden="true"
              />
              {text}
            </span>
          );
        }
        return (
          <button
            key={`${lane}-${item.id}`}
            type="button"
            data-slot="timeline-selection-chip"
            data-item={item.id}
            onClick={() =>
              editable ? onEditLifeEvent(item.id) : onOpenDay(day)
            }
            className="bg-background text-foreground text-2xs hover:bg-accent focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 py-1 font-medium outline-none focus-visible:ring-2 sm:min-h-7"
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={laneDotStyle(lane)}
              aria-hidden="true"
            />
            {text}
          </button>
        );
      })}
      {means.length > 0 && (
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("timeline.selection.mean", {
            values: formatMonthMeans(means, fmt),
          })}
        </span>
      )}
      <button
        type="button"
        data-slot="timeline-open-day"
        data-date={selected}
        onClick={() => onOpenDay(selected)}
        className="text-foreground hover:bg-accent focus-visible:ring-ring/50 ml-auto inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium outline-none focus-visible:ring-2 sm:min-h-8"
      >
        {t("timeline.openDay", { date: formatDayMonth(selected, intl) })}
        <ArrowRight className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
