"use client";

/**
 * One instrument on the landing, as one row of a single card (ui-standards
 * §20): its name over the last result ("yesterday, 4, minimal"), or the calm
 * "no check-in yet" line. The whole row opens the instrument's detail sheet,
 * which carries the last result, the trend, the dated history, the required
 * attribution and the Start action. The landing used to stack four cards,
 * each with its own full-width Start button and an info control.
 *
 * Neutral regardless of the last band: status reads through the words, never
 * a tint.
 */

import { ListItem } from "@/components/ui/list-row";
import {
  useDisplayTimezone,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { relativeCalendarDate } from "@/lib/i18n/relative-time";
import { INSTRUMENTS } from "@/lib/mental-health/instruments";

import type { AssessmentRow, InstrumentId } from "./types";

export function InstrumentRow({
  instrument,
  last,
  onOpenDetail,
}: {
  instrument: InstrumentId;
  /** Most-recent assessment for this instrument, or undefined when none yet. */
  last: AssessmentRow | undefined;
  /** Open this instrument's detail sheet. */
  onOpenDetail: () => void;
}) {
  const { t } = useTranslations();
  const { date: formatDate } = useFormatters();
  // Issue #490 — day-boundary zone for the relative "today / yesterday"
  // bucket must match the zone `formatDate` renders in (mirror → Berlin).
  const displayTz = useDisplayTimezone();
  const key = INSTRUMENTS[instrument].i18nKey;

  return (
    <ListItem
      data-slot="instrument-row"
      data-instrument={instrument}
      onSelect={onOpenDetail}
      actionLabel={`${t(`mentalHealth.instrument.${key}`)}, ${t("mentalHealth.openDetail")}`}
      title={t(`mentalHealth.instrument.${key}`)}
      meta={
        last ? (
          <span data-slot="instrument-row-last">
            {relativeCalendarDate(last.takenAt, t, formatDate, displayTz)}
            {", "}
            {last.totalScore}
            {", "}
            {t(`mentalHealth.band.${last.instrument}.${last.severityBand}`)}
          </span>
        ) : (
          t("mentalHealth.noResultYet")
        )
      }
    />
  );
}
