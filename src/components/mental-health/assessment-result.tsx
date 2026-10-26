"use client";

/**
 * The result of one check-in, the same layout for every instrument.
 *
 * Order: the crisis card first when PHQ-9 item 9 was answered above zero
 * (support before numbers), then one result card with the score on the
 * instrument's own scale, its band, what the band means in plain words, the
 * change since the last check-in measured against the meaningful-change
 * threshold, a note when the answers were given in a translation that has
 * not been validated (the score then reads as orientation), and the next
 * step: the direction-aware follow-up hint when the
 * score crosses the instrument's threshold, a routine note otherwise. The
 * attribution and "take another" close the view.
 *
 * Every number and verdict is the server's (the create response and the
 * history read's `trends`); nothing is re-scored here. SAFETY: this surface
 * never invites an AI Coach conversation about item content.
 */
import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { INSTRUMENTS, needsFollowUp } from "@/lib/mental-health/instruments";

import { AssessmentTrendNote } from "./assessment-trend-note";
import { CrisisCard } from "./crisis-card";
import type { AssessmentTrendDto, CreateResponse } from "./types";

export function AssessmentResult({
  result,
  trend,
  onTakeAnother,
  onBack,
}: {
  result: CreateResponse;
  /** This instrument's trend, once the history read includes this result. */
  trend?: AssessmentTrendDto;
  onTakeAnother: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslations();
  const { integer } = useFormatters();
  const { assessment } = result;
  const instrument = assessment.instrument;
  const def = INSTRUMENTS[instrument];
  const key = def.i18nKey;
  const band = assessment.severityBand;
  // The trend counts only once it ends on this very result.
  const ownTrend =
    trend && trend.latest.takenAt === assessment.takenAt ? trend : undefined;

  // a11y: on submit the wizard unmounts and this view mounts; move focus to the
  // result heading so keyboard / screen-reader users land on the new content.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      className="flex flex-col gap-4"
      data-slot="mental-health-result"
      data-instrument={instrument}
      data-band={band}
      aria-live="polite"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit"
        onClick={onBack}
        data-slot="result-back-to-landing"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("mentalHealth.backToList")}
      </Button>

      <PageHeader
        title={t(`mentalHealth.instrument.${key}`)}
        description={t(`mentalHealth.instrumentDescription.${key}`)}
        headingRef={headingRef}
        focusable
      />

      <p className="text-muted-foreground text-xs" role="status">
        {t("mentalHealth.saved")}
      </p>

      {result.crisis && <CrisisCard crisis={result.crisis} />}

      <Card>
        <CardHeader>
          <CardTitle>{t("mentalHealth.result.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">
              {t("mentalHealth.result.totalLabel")}
            </span>
            <span data-slot="result-score">
              <span className="text-2xl font-semibold tabular-nums">
                {integer(assessment.totalScore)}
              </span>{" "}
              <span className="text-muted-foreground text-xs">
                {t("mentalHealth.result.scoreOf", {
                  max: integer(def.maxScore),
                })}
              </span>
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">
              {t("mentalHealth.result.bandLabel")}
            </span>
            <span className="font-medium" data-slot="result-band">
              {t(`mentalHealth.band.${instrument}.${band}`)}
            </span>
          </div>
          <p data-slot="result-meaning">
            {t(`mentalHealth.bandMeaning.${instrument}.${band}`)}
          </p>
          {assessment.wording === "unvalidated_translation" && (
            <p
              className="text-muted-foreground text-xs"
              data-slot="result-wording-note"
            >
              {t("mentalHealth.wording.resultUnvalidated")}
            </p>
          )}
          {ownTrend && ownTrend.previous ? (
            <AssessmentTrendNote trend={ownTrend} />
          ) : ownTrend ? (
            <p className="text-muted-foreground" data-slot="result-first">
              {t("mentalHealth.result.firstCheckIn")}
            </p>
          ) : null}
          {needsFollowUp(instrument, assessment.totalScore) ? (
            <p
              className="bg-muted/40 rounded-md p-3"
              data-slot="result-follow-up-hint"
            >
              {t(`mentalHealth.followUpHint.${key}`)}
            </p>
          ) : (
            <p className="text-muted-foreground" data-slot="result-next-step">
              {t("mentalHealth.result.nextStep")}
            </p>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs leading-snug">
        <span className="font-medium">
          {t("mentalHealth.attributionLabel")}:
        </span>{" "}
        {def.attribution}
      </p>

      <Button variant="outline" onClick={onTakeAnother}>
        {t("mentalHealth.result.takeAnother")}
      </Button>
    </section>
  );
}
