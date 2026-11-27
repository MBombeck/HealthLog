"use client";

import { useTranslations } from "@/lib/i18n/context";

import type { Measurement } from "../list/list-model";
import { useMeasurementRowDisplay } from "../list/use-measurement-row-display";

/**
 * Under the value field, only when the typed value is far from the person's
 * own last reading of the type: a hint to check it. It never blocks a save;
 * see `last-value-deviation.ts` for the thresholds. The last reading itself
 * is the field's placeholder, not a line of its own.
 */
export function LastValueDeviation({ deviates }: { deviates: boolean }) {
  const { t } = useTranslations();
  if (!deviates) return null;
  return (
    <span
      className="text-warning block"
      role="status"
      data-slot="last-value-deviation"
    >
      {t("measurements.lastValueDeviates")}
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
