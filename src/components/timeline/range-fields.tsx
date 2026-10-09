"use client";

/**
 * The two date fields of a chosen range (v1.42): from and to, through the
 * app's own date field (the browser's native date input reads its order
 * from the browser, not from the person's setting). Each change is made
 * honest before it leaves (`clampRange`): never past today, never before
 * the record's first entry, never inverted. The fields carry the same
 * limits, so the calendar greys out what the clamp would move anyway.
 */
import { DateField } from "@/components/ui/date-field";
import { useTranslations } from "@/lib/i18n/context";

import { clampRange, type TimelineRange } from "./timeline-url";

export function RangeFields({
  range,
  today,
  dataFrom,
  onChange,
}: {
  range: TimelineRange;
  today: string;
  /** The record's first entry, once known; the earliest the range may start. */
  dataFrom: string | null;
  onChange: (next: TimelineRange) => void;
}) {
  const { t } = useTranslations();
  const commit = (next: TimelineRange) => {
    const clamped = clampRange(next, today, dataFrom);
    if (clamped.from !== range.from || clamped.to !== range.to) {
      onChange(clamped);
    }
  };
  return (
    <div
      role="group"
      aria-label={t("timeline.range.label")}
      data-slot="timeline-range"
      data-from={range.from}
      data-to={range.to}
      className="grid grid-cols-2 gap-3 sm:flex sm:items-end"
    >
      <div className="flex min-w-0 flex-col gap-1.5 sm:w-44">
        {/* The field's own input carries the name; this is its caption. */}
        <span className="text-xs font-medium" aria-hidden="true">
          {t("timeline.range.from")}
        </span>
        <DateField
          aria-label={t("timeline.range.from")}
          value={range.from}
          min={dataFrom ?? undefined}
          max={range.to}
          onChange={(from) => {
            if (from) commit({ from, to: range.to });
          }}
          data-testid="timeline-range-from"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 sm:w-44">
        {/* The field's own input carries the name; this is its caption. */}
        <span className="text-xs font-medium" aria-hidden="true">
          {t("timeline.range.to")}
        </span>
        <DateField
          aria-label={t("timeline.range.to")}
          value={range.to}
          min={range.from}
          max={today}
          onChange={(to) => {
            if (to) commit({ from: range.from, to });
          }}
          data-testid="timeline-range-to"
        />
      </div>
    </div>
  );
}
