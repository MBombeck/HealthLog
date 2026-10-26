"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";

import type { complianceFromLedger } from "../dose-history-ledger-compute";

/**
 * Compact took / skipped history chart — a single proportional bar split into
 * on-time / late / missed, with the headline rate beside it. No Recharts: a
 * three-segment CSS bar is calmer + lighter for a summary this small, and it
 * tracks the ledger the user is already reading.
 */
export function LedgerSummaryChart({
  compliance,
}: {
  compliance: NonNullable<ReturnType<typeof complianceFromLedger>>;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { takenOnTime, takenLate, missed, denominator, rate } = compliance;
  const pct = (n: number) => (denominator > 0 ? (n / denominator) * 100 : 0);

  return (
    <div className="min-w-0 flex-1 space-y-1.5" data-slot="ledger-summary">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          {t("medications.detail.verlauf.adherenceLabel")}
        </span>
        <span className="text-foreground text-sm font-semibold tabular-nums">
          {rate !== null ? `${fmt.number(rate)}%` : "—"}
        </span>
      </div>
      <div
        className="bg-muted flex h-2 overflow-hidden rounded-full"
        role="img"
        aria-label={t("medications.detail.verlauf.adherenceBarLabel", {
          onTime: takenOnTime,
          late: takenLate,
          missed,
        })}
      >
        <div
          className="bg-success h-full"
          style={{ width: `${pct(takenOnTime)}%` }}
        />
        <div
          className="bg-warning h-full"
          style={{ width: `${pct(takenLate)}%` }}
        />
        <div
          className="bg-destructive h-full"
          style={{ width: `${pct(missed)}%` }}
        />
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
        <span className="text-success">
          {t("medications.detail.verlauf.status.taken_on_time")}: {takenOnTime}
        </span>
        <span className="text-warning">
          {t("medications.detail.verlauf.status.taken_late")}: {takenLate}
        </span>
        <span className="text-destructive">
          {t("medications.detail.verlauf.status.missed")}: {missed}
        </span>
      </div>
    </div>
  );
}
