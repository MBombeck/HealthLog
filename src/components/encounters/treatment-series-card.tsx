"use client";

/**
 * One treatment series, as a row above the visits.
 *
 * What the person wrote (the title) and the progress are foreground; the
 * dates are meta and muted. The status is a pill because it is the one fact a
 * person scans the list for: is it still running, did it run out.
 */
import { Repeat } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScorePill } from "@/components/ui/score-pill";
import type { TreatmentSeries } from "@/hooks/use-treatment-series";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import {
  SERIES_STATUS_TONE,
  seriesProgressText,
  seriesStatusText,
} from "./treatment-series-labels";

/** A `YYYY-MM-DD` key as an instant the formatters read on its own day. */
export function dayInstant(key: string): string {
  return `${key}T12:00:00.000Z`;
}

export function TreatmentSeriesCard({
  series,
  onOpen,
}: {
  series: TreatmentSeries;
  /** Omitted when the caller may not change the series. */
  onOpen?: (series: TreatmentSeries) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const meta = series.nextSessionAt
    ? t("treatmentSeries.next", { date: format.dateTime(series.nextSessionAt) })
    : series.validUntil &&
        (series.status === "ACTIVE" || series.status === "PLANNED")
      ? t("treatmentSeries.validUntil", {
          date: format.date(dayInstant(series.validUntil)),
        })
      : null;

  return (
    <Card
      density="compact"
      data-slot="treatment-series-card"
      data-series-id={series.id}
      data-done={series.sessions.done}
    >
      <CardContent>
        <Body onOpen={onOpen ? () => onOpen(series) : undefined}>
          <TileHeader
            size="sm"
            icon={Repeat}
            title={series.title ?? t("treatmentSeries.untitled")}
            right={<SeriesStatusPill series={series} />}
          />
          <SeriesProgressRow series={series} />
          {series.performer ? (
            <p className="text-foreground line-clamp-1 text-sm">
              {series.performer.name}
            </p>
          ) : null}
          {meta ? (
            <p className="text-muted-foreground text-xs">{meta}</p>
          ) : null}
        </Body>
      </CardContent>
    </Card>
  );
}

/** The status, as the pill a person scans the list for. */
export function SeriesStatusPill({ series }: { series: TreatmentSeries }) {
  const { t } = useTranslations();
  return (
    <ScorePill
      tone={SERIES_STATUS_TONE[series.status]}
      className="shrink-0"
      data-series-status={series.status}
    >
      {seriesStatusText(t, series.status)}
    </ScorePill>
  );
}

/** "3 of 6" with a bar; the count alone for an open-ended series. */
export function SeriesProgressRow({ series }: { series: TreatmentSeries }) {
  const { t } = useTranslations();
  const planned = series.plannedSessions;
  const text = seriesProgressText(t, series.sessions.done, planned);
  const percent =
    planned !== null && planned > 0
      ? Math.min(100, Math.round((series.sessions.done / planned) * 100))
      : null;
  return (
    <div className="flex items-center gap-3">
      <span
        className="text-foreground shrink-0 text-sm tabular-nums"
        data-slot="treatment-series-progress"
      >
        {text}
      </span>
      {percent !== null ? <Progress value={percent} aria-label={text} /> : null}
    </div>
  );
}

/** The card's content, a button only for someone who may open it. */
function Body({
  onOpen,
  children,
}: {
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  if (!onOpen) return <div className="w-full space-y-2">{children}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-slot="treatment-series-open"
      className="focus-visible:ring-ring/50 w-full space-y-2 text-left focus-visible:ring-[3px] focus-visible:outline-none"
    >
      {children}
    </button>
  );
}
