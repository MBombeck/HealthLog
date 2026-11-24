"use client";

/**
 * Browser-side words for a treatment series: its status and its progress.
 * Literal `t()` calls, so `i18n-call-site-coverage` sees every key.
 */
import type { ScorePillTone } from "@/components/ui/score-pill";
import type { TreatmentSeriesStatus } from "@/lib/treatment-series/derive";

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export function seriesStatusText(
  t: Translate,
  status: TreatmentSeriesStatus,
): string {
  switch (status) {
    case "PLANNED":
      return t("treatmentSeries.status.planned");
    case "ACTIVE":
      return t("treatmentSeries.status.active");
    case "COMPLETED":
      return t("treatmentSeries.status.completed");
    case "EXPIRED":
      return t("treatmentSeries.status.expired");
  }
}

/** Status is meaning, so it carries a tone (UI standards §3). */
export const SERIES_STATUS_TONE: Record<TreatmentSeriesStatus, ScorePillTone> =
  {
    PLANNED: "neutral",
    ACTIVE: "info",
    COMPLETED: "success",
    EXPIRED: "warning",
  };

/** "3 of 6", or "3 sessions" for an open-ended series. */
export function seriesProgressText(
  t: Translate,
  done: number,
  planned: number | null,
): string {
  return planned !== null
    ? t("treatmentSeries.progress", { done, planned })
    : t("treatmentSeries.sessionsDoneCount", { count: done });
}

/** "Session 3 of 6" / "Session 3" on a visit that belongs to a series. */
export function sessionText(
  t: Translate,
  sessionNumber: number,
  planned: number | null,
): string {
  return planned !== null
    ? t("treatmentSeries.sessionOf", { number: sessionNumber, planned })
    : t("treatmentSeries.session", { number: sessionNumber });
}
