"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";

import type { Measurement } from "../list/list-model";
import { useMeasurementRowDisplay } from "../list/use-measurement-row-display";

/**
 * The meta line under the value field: the person's own last reading of the
 * type, in the unit the field asks in ("Last 82.3 kg, 3 days ago"), and when
 * the typed value is far from it, a hint to check it. The hint never blocks a
 * save; see `last-value-deviation.ts` for the thresholds.
 */
export function LastValueLine({
  last,
  lastDia,
  deviates,
}: {
  last: Measurement | null;
  /** The diastolic beside a systolic `last`, for blood pressure. */
  lastDia?: Measurement | null;
  deviates: boolean;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const { rowDisplay } = useMeasurementRowDisplay();
  if (!last) return null;
  const shown = rowDisplay(last);
  const value = lastDia
    ? `${fmt.number(shown.value)}/${fmt.number(rowDisplay(lastDia).value)} ${shown.unit}`
    : shown.unit
      ? `${fmt.number(shown.value)} ${shown.unit}`
      : fmt.number(shown.value);
  return (
    <span className="block space-y-0.5" data-slot="last-value-line">
      <span className="block">
        {t("measurements.lastValue", {
          value,
          when: formatRelativeTime(last.measuredAt, t, locale),
        })}
      </span>
      {deviates ? (
        <span
          className="text-warning block"
          role="status"
          data-slot="last-value-deviation"
        >
          {t("measurements.lastValueDeviates")}
        </span>
      ) : null}
    </span>
  );
}

/** The placeholder a value field shows: the last reading, or nothing. */
export function lastValuePlaceholder(
  last: Measurement | null,
  rowDisplay: ReturnType<typeof useMeasurementRowDisplay>["rowDisplay"],
  formatNumber: (value: number) => string,
): string | undefined {
  return last ? formatNumber(rowDisplay(last).value) : undefined;
}
