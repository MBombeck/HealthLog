"use client";

import { useTranslations } from "@/lib/i18n/context";

/**
 * Under the value field, only when the typed value is far from the person's
 * own last reading of the type: a hint to check it. It never blocks a save;
 * see `last-value-deviation.ts` for the thresholds.
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
