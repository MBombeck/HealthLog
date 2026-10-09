"use client";

/**
 * The bar under the chart (v1.42, #613): a cross-section of one bucket, the
 * one that holds the selected day. Its head names the bucket outright ("July
 * to September 2026", "September 2026", "Week of 22 September 2026"), so a
 * value that changes with the zoom says why: it is the mean of a different
 * stretch. Then every entry that touches the bucket as a chip (each one a
 * way into its day), the means of the chosen values with the readings behind
 * each ("no value" where there is none), and "Open 3 Jan." for the selected
 * day. Until someone picks a day, a short line says how to.
 *
 * It is also where a label the chart had to leave out is read in full, and
 * where each keyboard step on the chart is announced (`aria-live`).
 */
import { ArrowRight } from "lucide-react";

import type { TimelineResponse } from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";

import {
  bucketAfter,
  bucketStart,
  dayKey,
  dayNumber,
  formatAtPrecision,
  formatDayMonth,
  formatDayMonthYearLong,
  formatMonthLong,
  formatMonthYear,
} from "./timeline-dates";
import { itemsInPeriod } from "./timeline-geometry";
import { MeanPartsLine, laneDotStyle } from "./timeline-chart";
import {
  bucketValues,
  labelledMeanParts,
  type SeriesValueFormat,
} from "./series-format";

const VALUES_MARK = "\u0000";

export interface SelectionBarProps {
  timeline: TimelineResponse;
  selected: string;
  /** Nobody has picked a day yet: the bar says how to. */
  showHint?: boolean;
  today: string;
  seriesLabel: (key: string) => string;
  /** The colour of each value line, as on the chart (`series-colors.ts`). */
  seriesColor: (key: string) => string;
  /** How a value reads (`useSeriesValueFormat`). */
  seriesFormat: SeriesValueFormat;
  onOpenDay: (date: string) => void;
  onEditLifeEvent?: (id: string) => void;
}

export function SelectionBar({
  timeline,
  selected,
  showHint = false,
  today,
  seriesLabel,
  seriesColor,
  seriesFormat,
  onOpenDay,
  onEditLifeEvent,
}: SelectionBarProps) {
  const { t, tCount, locale } = useTranslations();
  const intl = resolveIntlLocale(locale);
  const bucket = timeline.bucket;
  const periodFrom = bucketStart(selected, bucket);
  const periodTo = dayKey(dayNumber(bucketAfter(periodFrom, bucket)) - 1);
  const entries = itemsInPeriod(timeline.lanes, periodFrom, periodTo, today);
  const means = bucketValues(timeline.series, timeline.bucket, selected);
  // "Ø {values}": the words around the values, so the values can carry
  // their colour dots.
  const [meanBefore, meanAfter = ""] = t("timeline.selection.mean", {
    values: VALUES_MARK,
  }).split(VALUES_MARK);

  return (
    <div
      className="bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2.5"
      data-slot="timeline-selection-bar"
      data-bucket={bucket}
      data-period-from={periodFrom}
      data-period-to={periodTo}
    >
      {showHint && (
        // One line, worded for the input in hand: a pointer clicks, a
        // finger taps.
        <p
          className="text-muted-foreground basis-full text-xs"
          data-slot="timeline-selection-hint"
        >
          <span className="pointer-coarse:hidden">
            {t("timeline.selection.hintClick")}
          </span>
          <span className="hidden pointer-coarse:inline">
            {t("timeline.selection.hintTap")}
          </span>
        </p>
      )}
      <span
        className="text-sm font-semibold"
        aria-live="polite"
        data-slot="timeline-selection-title"
      >
        {bucketTitle(periodFrom, bucket, intl, t)}
      </span>
      {entries.length === 0 && (
        <span
          className="text-muted-foreground text-xs"
          data-slot="timeline-selection-empty"
        >
          {t("timeline.selection.empty")}
        </span>
      )}
      {entries.map(({ lane, item, through }) => {
        // A chip opens the day its entry touches inside this period.
        const day =
          item.start >= periodFrom && item.start <= periodTo
            ? item.start
            : periodFrom;
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
          {meanBefore}
          <MeanPartsLine
            parts={labelledMeanParts(means.values, seriesFormat, {
              label: seriesLabel,
              bloodPressure: t("timeline.values.bloodPressure"),
              noValue: t("timeline.values.noValue"),
              readings: (n) => tCount("timeline.values.readings", n),
            })}
            seriesColor={seriesColor}
          />
          {meanAfter}
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

/**
 * The bucket by name, in full: "July to September 2026", "September 2026",
 * "Week of 22 September 2026", "22 September 2026".
 */
export function bucketTitle(
  start: string,
  bucket: TimelineResponse["bucket"],
  intl: string,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  if (bucket === "day") return formatDayMonthYearLong(start, intl);
  if (bucket === "month") return formatMonthYear(start, intl);
  if (bucket === "quarter") {
    const last = dayKey(dayNumber(bucketAfter(start, bucket)) - 1);
    return t("timeline.selection.range", {
      from: formatMonthLong(start, intl),
      to: formatMonthYear(last, intl),
    });
  }
  return t("timeline.selection.week", {
    date: formatDayMonthYearLong(start, intl),
  });
}
