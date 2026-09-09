"use client";

/**
 * v1.25.3 — one neutral card per instrument on the landing.
 *
 * v1.27.6 — rebuilt onto the shared med-/Vorsorge card anatomy so the test
 * cards read exactly like their peers: `MedicationCardHeader` (bold
 * name + outline category badge), a label/value block in the next-last
 * grammar ("last test" → relative day, "last result" → score + band word),
 * and a single bottom-pinned Start action. The surface stays NEUTRAL
 * regardless of the last band — no severity tint (house rule: status reads
 * through discreet text only, never a card wash).
 *
 * v1.27.9 — the card generalises over the four-instrument registry and
 * carries the instrument's required attribution/licence line (WHO
 * CC BY-NC-SA citation for the WHO-5, the Sleepio CC BY-NC citation for
 * the SCI, the Pfizer grant for PHQ/GAD). A locale without validated item
 * wording additionally gets the honest "validated in English" note. The
 * card BODY (header + last-result block) opens the per-instrument detail —
 * the Vorsorge-/med-card interaction — while the bottom-pinned Start
 * button stays a separate, non-overlapping action.
 *
 * v1.27.24 — the attribution left the space UNDER the Start button (which
 * crowded the action) for a discreet info affordance at the top-right of
 * the card header, at the heading's height. A single icon button opens a
 * popover carrying the verbatim citation (+ the "validated in English"
 * note where it applies), so the Start button stands alone with clean
 * space below it. The citation still renders verbatim in full view on the
 * result and detail surfaces; here it is one tap away. The trigger is a
 * sibling of the detail-open button (never nested inside it) so the two
 * actions never collide.
 */
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { MedicationCardHeader } from "@/components/medications/medication-card-header";
import {
  useFormatters,
  useTranslations,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { relativeCalendarDate } from "@/lib/i18n/relative-time";
import {
  INSTRUMENTS,
  hasValidatedItems,
} from "@/lib/mental-health/instruments";

import type { AssessmentRow, InstrumentId } from "./types";

export function InstrumentCard({
  instrument,
  last,
  onStart,
  onOpenDetail,
}: {
  instrument: InstrumentId;
  /** Most-recent assessment for this instrument, or undefined when none yet. */
  last: AssessmentRow | undefined;
  onStart: () => void;
  /**
   * Open this instrument's detail (last score + band, trend chart, dated
   * history). The card body is the target; Start stays separate.
   */
  onOpenDetail: () => void;
}) {
  const { t, locale } = useTranslations();
  const { date: formatDate } = useFormatters();
  // v1.36.x — a screener is answered by the person it is about. No grant
  // level admits it, so inside somebody else's record the card reads as
  // history and carries no way to start one.
  const { canManageDomain } = useRecordCapabilities();
  const canManageMind = canManageDomain("mind");
  // Issue #490 — day-boundary zone for the relative "today / yesterday"
  // bucket must match the zone `formatDate` renders in (mirror → Berlin).
  const displayTz = useDisplayTimezone();
  const def = INSTRUMENTS[instrument];
  const key = def.i18nKey;
  const title = t(`mentalHealth.instrument.${key}`);

  return (
    <Card
      className="relative h-full gap-3 md:gap-3"
      data-slot="instrument-card"
    >
      {/* Source / licence — a discreet info control at the top-right of the
          header, at the heading's height. A sibling of the detail-open
          button (never nested), so a tap opens the citation popover without
          also opening the detail. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="instrument-card-attribution-trigger"
            aria-label={t("mentalHealth.attributionShow", {
              instrument: title,
            })}
            className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring absolute top-4 right-4 z-10 flex size-8 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none md:top-6 md:right-6"
          >
            <Info className="size-4" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-w-xs">
          <p className="text-foreground text-xs font-medium">
            {t("mentalHealth.attributionLabel")}
          </p>
          <p
            className="text-muted-foreground mt-1 text-xs leading-snug"
            data-slot="instrument-card-attribution"
          >
            {!hasValidatedItems(instrument, locale) && (
              <>{t("mentalHealth.validatedInEnglishNote")} </>
            )}
            {def.attribution}
          </p>
        </PopoverContent>
      </Popover>

      {/* Only the HEADER region is the navigable open-target — mirrors the
          medication card header (focus-visible ring only, NO hover background
          wash, no whole-card click). The last-result block below is passive;
          the Start button stays a separate action. The short instrument titles
          clear the top-right info control that floats over the header's right
          padding. */}
      <button
        type="button"
        onClick={onOpenDetail}
        data-slot="instrument-card-open"
        aria-label={`${title} — ${t("mentalHealth.openDetail")}`}
        className="focus-visible:ring-ring block w-full rounded-t-xl text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <MedicationCardHeader
          name={title}
          dose=""
          categoryLabel={t(`mentalHealth.instrumentSub.${key}`)}
        />
      </button>

      {/* Label/value block in the Vorsorge card's next-last grammar. With
          no history yet, one calm line replaces the pair — no dashes
          pretending a value exists. */}
      {last ? (
        <div className="min-h-[2.75rem] w-full space-y-1.5 px-4 text-sm md:px-6">
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
              data-slot="instrument-card-last-score"
            >
              {last.totalScore}
              {" · "}
              {t(`mentalHealth.band.${last.instrument}.${last.severityBand}`)}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground flex min-h-[2.75rem] items-center px-4 text-sm md:px-6">
          {t("mentalHealth.noResultYet")}
        </div>
      )}

      <CardContent className="flex h-full flex-col">
        {/* Bottom-pinned single primary action — the med-/Vorsorge card slot.
            Nothing sits below it now: the attribution moved to the header's
            info control, so the Start button stands alone with clean space. */}
        {canManageMind && (
          <div className="mt-auto pt-0">
            <Button type="button" className="min-h-11 w-full" onClick={onStart}>
              {t("mentalHealth.start")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
