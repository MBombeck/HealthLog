"use client";

/**
 * The timeline's legend (v1.42, #613; lab marks #1299).
 */
import type { TimelineBucket, TimelineLabSeries } from "@/lib/day/contract";
import { useTranslations } from "@/lib/i18n/context";

import { TIMELINE_LEGEND_MEAN_KEY } from "./label-keys";
import { LabExcludedNote } from "./lab-lines";

/**
 * What the marks mean. Under the selection bar and set off from it by a
 * hairline. With value lines, the two marks a line can carry besides its
 * points are explained by an example of each: the dashed stroke over a short
 * gap without measurements, and the hollow point of a mean resting on fewer
 * than three.
 */
export function TimelineLegend({
  bucket,
  hasSeries,
  labSeries = [],
  label = (key) => key,
}: {
  bucket: TimelineBucket;
  hasSeries: boolean;
  /**
   * The lab lines drawn: their three marks are explained, and what a line
   * left out is said here, where the marks are (#1299).
   */
  labSeries?: readonly TimelineLabSeries[];
  label?: (key: string) => string;
}) {
  const { t } = useTranslations();
  const hasLabs = labSeries.length > 0;
  return (
    <div
      className="text-muted-foreground border-border flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-3 text-xs"
      data-slot="timeline-legend"
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className="bg-muted-foreground h-1.5 w-4 shrink-0 rounded-full"
          aria-hidden="true"
        />
        {t("timeline.legendSpan")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="bg-muted-foreground size-2 shrink-0 rounded-full"
          aria-hidden="true"
        />
        {t("timeline.legendEvent")}
      </span>
      {hasSeries && (
        <>
          <span
            className="inline-flex items-center gap-1.5"
            data-slot="timeline-legend-mean"
            data-bucket={bucket}
          >
            <span
              className="bg-foreground h-0.5 w-4 shrink-0"
              aria-hidden="true"
            />
            {t(TIMELINE_LEGEND_MEAN_KEY[bucket])}
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            data-slot="timeline-legend-gap"
          >
            <svg
              width="16"
              height="8"
              viewBox="0 0 16 8"
              className="text-foreground"
              aria-hidden="true"
            >
              <line
                x1="1"
                x2="15"
                y1="4"
                y2="4"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeDasharray="3 3"
                strokeLinecap="round"
              />
            </svg>
            {t("timeline.legendGap")}
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            data-slot="timeline-legend-thin"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              className="text-foreground"
              aria-hidden="true"
            >
              <circle
                cx="4"
                cy="4"
                r="2.75"
                fill="var(--card)"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            </svg>
            {t("timeline.legendThin")}
          </span>
        </>
      )}
      {hasLabs && (
        <>
          <span
            className="inline-flex items-center gap-1.5"
            data-slot="timeline-legend-lab-value"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              className="text-foreground"
              aria-hidden="true"
            >
              <circle cx="4" cy="4" r="3.25" fill="currentColor" />
            </svg>
            {t("timeline.legendLabValue")}
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            data-slot="timeline-legend-lab-outside"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              className="text-foreground"
              aria-hidden="true"
            >
              <path d="M5 0.5L9.5 8.5L0.5 8.5Z" fill="currentColor" />
            </svg>
            {t("timeline.legendLabOutside")}
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            data-slot="timeline-legend-lab-range"
          >
            <svg
              width="16"
              height="8"
              viewBox="0 0 16 8"
              className="text-foreground"
              aria-hidden="true"
            >
              <rect
                x="0"
                y="0.5"
                width="16"
                height="7"
                fill="currentColor"
                fillOpacity="0.1"
              />
              <line
                x1="0"
                x2="16"
                y1="0.5"
                y2="0.5"
                stroke="currentColor"
                strokeOpacity="0.4"
                strokeDasharray="3 3"
              />
              <line
                x1="0"
                x2="16"
                y1="7.5"
                y2="7.5"
                stroke="currentColor"
                strokeOpacity="0.4"
                strokeDasharray="3 3"
              />
            </svg>
            {t("timeline.legendLabRange")}
          </span>
          <LabExcludedNote labSeries={labSeries} label={label} />
        </>
      )}
    </div>
  );
}
