"use client";

/**
 * v1.27.9 — per-instrument detail surface, opened by clicking an instrument
 * card (the Vorsorge-/med-card detail interaction). Hosted in a
 * `ResponsiveSheet` by the page orchestrator; this component owns the calm
 * detail spine: last score + band → Start action → trend chart + dated
 * history (via the pinned `AssessmentHistory`) → the instrument's required
 * attribution line. The history and the score curve live ONLY here — the
 * landing stays a quiet card grid, so the trend is opt-in behind a
 * deliberate click, never pushed at the moment someone arrives to check in.
 */
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { Button } from "@/components/ui/button";
import {
  useFormatters,
  useTranslations,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { relativeCalendarDate } from "@/lib/i18n/relative-time";
import { INSTRUMENTS } from "@/lib/mental-health/instruments";

import { AssessmentHistory } from "./assessment-history";
import type { AssessmentRow, InstrumentId } from "./types";

export function InstrumentDetail({
  instrument,
  rows,
  onStart,
}: {
  instrument: InstrumentId;
  /** ALL assessments; the pinned history filters to this instrument. */
  rows: AssessmentRow[];
  /** Start a check-in for this instrument (closes the host sheet). */
  onStart: () => void;
}) {
  const { t } = useTranslations();
  const { date: formatDate } = useFormatters();
  // v1.36.x — see the card: starting a screener is not a delegated verb.
  const { canManageDomain } = useRecordCapabilities();
  const canManageMind = canManageDomain("mind");
  // Issue #490 — day-boundary zone for the relative "today / yesterday"
  // bucket must match the zone `formatDate` renders in (mirror → Berlin).
  const displayTz = useDisplayTimezone();
  const def = INSTRUMENTS[instrument];
  const last = rows.find((r) => r.instrument === instrument);

  return (
    <div className="flex flex-col gap-4" data-slot="instrument-detail">
      {/* Last result, in the card's label/value grammar — score + band word
          on one slot, the relative day on the other. Neutral text, no tint. */}
      {last && (
        <div className="space-y-1.5 text-sm">
          <div className="text-muted-foreground flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-shrink truncate font-medium">
              {t("mentalHealth.lastResult")}
            </span>
            <span className="text-foreground text-right">
              {relativeCalendarDate(last.takenAt, t, formatDate, displayTz)}
            </span>
          </div>
          <div className="text-muted-foreground flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-shrink truncate font-medium">
              {t("mentalHealth.lastScore")}
            </span>
            <span
              className="text-foreground text-right"
              data-slot="instrument-detail-last-score"
            >
              {last.totalScore}
              {" · "}
              {t(`mentalHealth.band.${last.instrument}.${last.severityBand}`)}
            </span>
          </div>
        </div>
      )}

      {/* The Start action stays reachable here too — the detail is a calm
          reading surface, not a dead end. */}
      {canManageMind && (
        <Button
          type="button"
          className="min-h-11 w-full"
          onClick={onStart}
          data-slot="instrument-detail-start"
        >
          {t("mentalHealth.start")}
        </Button>
      )}

      <AssessmentHistory rows={rows} instrument={instrument} />

      {/* Required attribution — same factual line as the card + result view. */}
      <p className="text-muted-foreground text-xs leading-snug">
        {def.attribution}
      </p>
    </div>
  );
}
