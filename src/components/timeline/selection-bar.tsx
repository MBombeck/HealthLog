"use client";

/**
 * The bar under the chart (v1.42, #613): the selected month, every entry
 * that touches it as a chip (each one a way into its day), the means of the
 * chosen values in the bucket that holds the selected day (with the readings
 * behind each, and "no value" where there is none), and "Open 3 Jan." for
 * the selected day.
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
import { bucketText, laneDotStyle } from "./timeline-chart";
import { bucketValues, formatLabelledMeans } from "./series-format";

export interface SelectionBarProps {
  timeline: TimelineResponse;
  selected: string;
  today: string;
  seriesLabel: (key: string) => string;
  onOpenDay: (date: string) => void;
  onEditLifeEvent?: (id: string) => void;
}

export function SelectionBar({
  timeline,
  selected,
  today,
  seriesLabel,
  onOpenDay,
  onEditLifeEvent,
}: SelectionBarProps) {
  const { t, tCount, locale } = useTranslations();
  const fmt = useFormatters();
  const intl = resolveIntlLocale(locale);
  const entries = itemsInMonth(timeline.lanes, selected, today);
  const means = bucketValues(timeline.series, timeline.bucket, selected);
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
      {means.values.length > 0 && (
        <span
          className="text-muted-foreground text-xs tabular-nums"
          data-slot="timeline-selection-means"
          data-bucket={means.start}
        >
          {t("timeline.selection.mean", {
            values: `${bucketText(means.start, timeline.bucket, intl, t)}: ${formatLabelledMeans(
              means.values,
              fmt,
              {
                label: seriesLabel,
                bloodPressure: t("timeline.values.bloodPressure"),
                noValue: t("timeline.values.noValue"),
                readings: (n) => tCount("timeline.values.readings", n),
              },
            )}`,
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
