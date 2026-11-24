"use client";

/**
 * The top of an open treatment series: its progress, the next-session action
 * and every session in time order, each opening the visit it is.
 */
import { CirclePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Encounter } from "@/hooks/use-encounters";
import type { TreatmentSeries } from "@/hooks/use-treatment-series";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import { encounterStatusText } from "./encounter-labels";
import {
  SeriesProgressRow,
  SeriesStatusPill,
  dayInstant,
} from "./treatment-series-card";
import { sessionText } from "./treatment-series-labels";

export function TreatmentSeriesSessions({
  series,
  visits,
  ended,
  onAddSession,
  onOpenSession,
}: {
  series: TreatmentSeries;
  /** The sessions, or undefined while the detail loads. */
  visits: Encounter[] | undefined;
  ended: boolean;
  onAddSession?: (series: TreatmentSeries) => void;
  onOpenSession?: (visit: Encounter) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  return (
    <section
      className="space-y-3"
      aria-label={t("treatmentSeries.sessionsHeading")}
    >
      <TreatmentSeriesSummary series={series} />
      {onAddSession && !ended ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11"
          data-slot="treatment-series-add-session"
          onClick={() => onAddSession(series)}
        >
          <CirclePlus className="size-4" aria-hidden />
          {t("treatmentSeries.addSession")}
        </Button>
      ) : null}
      {visits === undefined ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : visits.length > 0 ? (
        <ol
          className="divide-border divide-y rounded-lg border"
          data-slot="treatment-series-sessions"
        >
          {visits.map((visit) => {
            const row = (
              <span className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left">
                <span className="min-w-0">
                  <span className="text-foreground block text-sm">
                    {format.dateTime(visit.occurredAt)}
                  </span>
                  {visit.status === "CANCELLED" ||
                  visit.status === "NO_SHOW" ? (
                    <span className="text-muted-foreground block text-xs">
                      {encounterStatusText(t, visit.status)}
                    </span>
                  ) : null}
                </span>
                {visit.series?.sessionNumber ? (
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {sessionText(
                      t,
                      visit.series.sessionNumber,
                      visit.series.plannedSessions,
                    )}
                  </span>
                ) : null}
              </span>
            );
            return (
              <li key={visit.id}>
                {onOpenSession ? (
                  <button
                    type="button"
                    className="hover:bg-muted/50 focus-visible:ring-ring/50 min-h-11 w-full focus-visible:ring-[3px] focus-visible:outline-none"
                    onClick={() => onOpenSession(visit)}
                  >
                    {row}
                  </button>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

/** The top of an open series: status, count and bar, and its window. */
function TreatmentSeriesSummary({ series }: { series: TreatmentSeries }) {
  const { t } = useTranslations();
  const format = useFormatters();
  const parts = [
    series.performer?.name ?? null,
    series.firstSessionAt
      ? t("treatmentSeries.firstSession", {
          date: format.date(series.firstSessionAt),
        })
      : null,
    series.validUntil
      ? t("treatmentSeries.validUntil", {
          date: format.date(dayInstant(series.validUntil)),
        })
      : null,
  ].filter(Boolean);
  return (
    <div className="space-y-2" data-slot="treatment-series-summary">
      <div className="flex items-center justify-between gap-3">
        <SeriesProgressRow series={series} />
        <SeriesStatusPill series={series} />
      </div>
      {parts.length > 0 ? (
        <p className="text-muted-foreground text-xs">{parts.join(", ")}</p>
      ) : null}
    </div>
  );
}
