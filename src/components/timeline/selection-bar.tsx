"use client";

/**
 * The cross-section under the chart (v1.42, #613): one bucket, the
 * one that holds the selected day. Its head names the bucket outright ("July
 * to September 2026", "September 2026", "Week of 22 September 2026"), so a
 * value that changes with the zoom says why: it is the mean of a different
 * stretch. Then every entry that touches the bucket as a chip (each one a
 * way into its day), the means of the chosen values with the readings behind
 * each ("no value" where there is none; the readings behind a mean are a
 * hover and a screen-reader detail, not a second line). The day itself opens
 * from a chip, from Enter on the chart or a double click; a separate "Open
 * 3 Jan." link sat apart from everything else and is gone. Until someone
 * picks a day, a short line says how to.
 *
 * It is also where a label the chart had to leave out is read in full, and
 * where each keyboard step on the chart is announced (`aria-live`).
 *
 * It sits on the card's own surface, set off from the chart by a hairline
 * above it, not in a box of its own. An entry's parts are joined by commas,
 * a period still open reads "since 3 Mar." (it needs no "ongoing"), and a
 * medication is one entry however many of its items touch the bucket
 * (`medicationPeriodItem`).
 */
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
import { useItemWords } from "./item-words";
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
  const words = useItemWords();
  const intl = resolveIntlLocale(locale);
  const bucket = timeline.bucket;
  const periodFrom = bucketStart(selected, bucket);
  const periodTo = dayKey(dayNumber(bucketAfter(periodFrom, bucket)) - 1);
  const entries = itemsInPeriod(timeline.lanes, periodFrom, periodTo, today);
  const means = bucketValues(timeline.series, timeline.bucket, selected);
  // A bucket with a value but no entry is not empty: the means below say
  // what it holds, so "No entries" is kept for a stretch with nothing.
  const hasValue = means.values.some((v) => v.mean !== null);
  // "Ø {values}": the words around the values, so the values can carry
  // their colour dots.
  const [meanBefore, meanAfter = ""] = t("timeline.selection.mean", {
    values: VALUES_MARK,
  }).split(VALUES_MARK);

  return (
    <div
      className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3"
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
      {entries.length === 0 && !hasValue && (
        <span
          className="text-muted-foreground text-xs"
          data-slot="timeline-selection-empty"
        >
          {t("timeline.selection.empty")}
        </span>
      )}
      {entries.map(({ lane, item }) => {
        // A chip opens the day its entry touches inside this period.
        const day =
          item.start >= periodFrom && item.start <= periodTo
            ? item.start
            : periodFrom;
        const canOpenDay = item.precision === "DAY" && day <= today;
        const at = (date: string) =>
          item.precision === "DAY"
            ? formatDayMonth(date, intl)
            : formatAtPrecision(date, item.precision, intl);
        const when = item.open
          ? t("timeline.selection.since", { date: at(item.start) })
          : item.end && item.end !== item.start
            ? t("timeline.selection.range", {
                from: at(item.start),
                to: at(item.end),
              })
            : at(item.start);
        const { label, sub, tag } = words(item);
        const name = [label, sub].filter(Boolean).join(" ");
        const text = `${name}, ${when}`;
        // A life event's category is a chip of its own inside the entry,
        // never run on after its title.
        const category = tag ? (
          <span
            data-slot="timeline-selection-tag"
            className="border-border text-muted-foreground rounded-full border px-1.5 leading-4"
          >
            {tag}
          </span>
        ) : null;
        const editable = item.kind === "lifeEvent" && onEditLifeEvent;
        if (!canOpenDay && !editable) {
          return (
            <span
              key={`${lane}-${item.id}`}
              className="bg-muted text-foreground text-2xs inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium"
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={laneDotStyle(lane)}
                aria-hidden="true"
              />
              {text}
              {category}
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
            className="bg-muted text-foreground text-2xs hover:bg-accent focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 py-1 font-medium outline-none focus-visible:ring-2 sm:min-h-7"
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={laneDotStyle(lane)}
              aria-hidden="true"
            />
            {text}
            {category}
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
