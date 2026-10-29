"use client";

/**
 * The timeline's chart as tables, for a screen reader (v1.42, #613): the
 * lane entries with their dates, and the value lines' means per bucket.
 * Both are visually hidden; the phone chronicle is the visible list form.
 * The lab lines' table sits with the lab lines (`lab-lines.tsx`).
 */
import type {
  TimelineBucket,
  TimelineLaneKey,
  TimelineResponse,
} from "@/lib/day/contract";
import { useTranslations } from "@/lib/i18n/context";

import { itemLine, useItemWords } from "./item-words";
import { TIMELINE_LANE_LABEL_KEY } from "./label-keys";
import { medicationListItems } from "./medication-rows";
import { formatSeriesValue, type SeriesValueFormat } from "./series-format";
import {
  bucketAfter,
  bucketStart,
  dayNumber,
  formatAtPrecision,
  formatBucket,
} from "./timeline-dates";
import { isSpan } from "./timeline-geometry";

/**
 * The chart as a table, for a screen reader: every entry with its lane and
 * dates. Visually hidden; the phone chronicle is the visible list form.
 */
export function TimelineTable({
  timeline,
  hiddenLanes,
  intl,
}: {
  timeline: TimelineResponse;
  hiddenLanes: ReadonlySet<TimelineLaneKey>;
  intl: string;
}) {
  const { t } = useTranslations();
  const words = useItemWords();
  const rows = timeline.lanes
    .filter((lane) => !hiddenLanes.has(lane.key))
    .flatMap((lane) =>
      (lane.key === "medications"
        ? medicationListItems(lane.items)
        : lane.items
      ).map((item) => ({ lane: lane.key, item })),
    )
    .sort((a, b) => dayNumber(b.item.start) - dayNumber(a.item.start));
  return (
    // The table is hidden by a wrapper, never by `sr-only` on the table
    // itself: `overflow: hidden` does not apply to a table box, so a
    // visually hidden table still laid out its rows at full height under
    // the page and made `<main>` scroll past its last card into nothing.
    <div className="sr-only" data-slot="timeline-table-frame">
      <table data-slot="timeline-table">
        <caption>{t("timeline.table.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("timeline.table.lane")}</th>
            <th scope="col">{t("timeline.table.entry")}</th>
            <th scope="col">{t("timeline.table.start")}</th>
            <th scope="col">{t("timeline.table.end")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ lane, item }) => (
            <tr key={`${lane}-${item.id}`}>
              <td>{t(TIMELINE_LANE_LABEL_KEY[lane])}</td>
              <td>{itemLine(item, words, t("timeline.startUnknown"))}</td>
              <td>{formatAtPrecision(item.start, item.precision, intl)}</td>
              <td>
                {!item.open && isSpan(item) && item.end
                  ? formatAtPrecision(item.end, item.precision, intl)
                  : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Januar 2026", "Jan bis März 2026", "5. Jan. bis 11. Jan. 2026". */
export function bucketText(
  start: string,
  bucket: TimelineBucket,
  intl: string,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  const label = formatBucket(start, bucket, intl);
  return typeof label === "string"
    ? label
    : t("timeline.selection.range", label);
}

/**
 * The value lines as a table, for a screen reader: one row per bucket from
 * the first to the last with a reading in the window, one column per
 * series. A bucket without a reading says so; nothing is filled in.
 */
export function SeriesTable({
  timeline,
  window,
  seriesLabel,
  fmt,
  intl,
}: {
  timeline: TimelineResponse;
  window: { from: string; to: string };
  seriesLabel: (key: string) => string;
  fmt: SeriesValueFormat;
  intl: string;
}) {
  const { t, tCount } = useTranslations();
  const { bucket, series } = timeline;
  const inWindow = (start: string) =>
    start <= window.to && bucketAfter(start, bucket) > window.from;
  const starts = series
    .flatMap((s) => s.points.map((p) => p.t))
    .filter(inWindow)
    .sort();
  if (starts.length === 0) return null;
  const rows: string[] = [];
  for (
    let start = bucketStart(starts[0], bucket);
    start <= starts[starts.length - 1];
    start = bucketAfter(start, bucket)
  ) {
    rows.push(start);
  }
  const byKey = new Map(
    series.map((s) => [s.key, new Map(s.points.map((p) => [p.t, p]))]),
  );
  return (
    // The table is hidden by a wrapper, never by `sr-only` on the table
    // itself: `overflow: hidden` does not apply to a table box, so a
    // visually hidden table still laid out its rows at full height under
    // the page and made `<main>` scroll past its last card into nothing.
    <div className="sr-only" data-slot="timeline-series-table-frame">
      <table data-slot="timeline-series-table">
        <caption>{t("timeline.table.seriesCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("timeline.table.period")}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {seriesLabel(s.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.reverse().map((start) => (
            <tr key={start} data-bucket={start}>
              <th scope="row">{bucketText(start, bucket, intl, t)}</th>
              {series.map((s) => {
                const point = byKey.get(s.key)?.get(start);
                return (
                  <td key={s.key}>
                    {point
                      ? `${formatSeriesValue(s.key, point.mean, s.unit, fmt)}, ${tCount("timeline.values.readings", point.count)}`
                      : t("timeline.values.noValue")}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
