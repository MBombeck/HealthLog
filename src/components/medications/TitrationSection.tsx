"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ExternalLink } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";

/**
 * v1.4.25 W19f — GLP-1 titration-ladder section.
 *
 * Sits between `<SchedulingSection>` (W19e) and `<IntakeHistoryList>`
 * on the medication detail page. Same chrome as the W19d / W19e
 * sections so the Wave-4b panels read as one visual group — chrome is
 * now composed via the shared `<MedicationDetailSection>` wrapper.
 *
 * Layout:
 *   - Header: drug INN + "Standard ladder (EMA reference)"
 *   - Vertical step list (mobile) — same nodes laid horizontally
 *     from `sm` upwards. Each step shows dose, typical-weeks badge,
 *     and a status dot (current / past / upcoming).
 *   - Current-step ring with "You are here" caption.
 *   - Next-step caption + observational dwell hint when the EMA
 *     dwell-time has elapsed. Copy is strictly observational; the
 *     ladder is a *reference*, never a prescription (MDR boundary).
 *   - Disclaimer + EMA-source link.
 *
 * v1.4.25 W21 Fix-N — dropped the hand-rolled `templateFill` helper;
 * the i18n `t()` function already accepts the `params` bag with
 * `{key}` placeholder substitution. One source of truth for the
 * template-fill semantics.
 *
 * Data comes from `/api/medications/[id]/titration`; that route owns
 * the prisma queries and delegates math to the pure ladder helpers.
 */

interface TitrationStep {
  stepIndex: number;
  doseMg: number;
  typicalWeeks: number;
}

interface TitrationResponse {
  drugId: string;
  drugInn: string;
  ladder: TitrationStep[];
  currentStep: TitrationStep | null;
  currentStepIndex: number | null;
  weeksOnCurrentStep: number;
  nextStep: TitrationStep | null;
  escalationDue: boolean;
  sourceEMA: string;
}

interface TitrationSectionProps {
  medicationId: string;
}

export function TitrationSection({ medicationId }: TitrationSectionProps) {
  const { t } = useTranslations();

  const { data, isLoading, error } = useQuery({
    queryKey: ["medications", medicationId, "titration"],
    queryFn: async (): Promise<TitrationResponse> => {
      const res = await fetch(`/api/medications/${medicationId}/titration`);
      if (!res.ok) {
        throw new Error(`Failed to load titration: ${res.status}`);
      }
      const json = await res.json();
      return json.data as TitrationResponse;
    },
  });

  const hasLadder = !!data && data.ladder.length > 0;
  const currentIdx = data?.currentStepIndex ?? null;

  // Compose the optional dwell hint AND the next-step caption. The
  // dwell hint is strictly observational — no "you should step up";
  // the boolean only gates *display*, never *action*.
  const dwellHint = useMemo(() => {
    if (!data || data.currentStep === null) return null;
    if (data.weeksOnCurrentStep <= 0) return null;
    if (data.escalationDue) {
      return t("medications.titration.escalationDueHint", {
        weeks: data.weeksOnCurrentStep,
        typical: data.currentStep.typicalWeeks,
      });
    }
    return t("medications.titration.currentStepDwell", {
      weeks: data.weeksOnCurrentStep,
    });
  }, [data, t]);

  const nextStepCaption = useMemo(() => {
    if (!data) return null;
    if (!data.nextStep) return null;
    return t("medications.titration.nextStepCaption", {
      dose: data.nextStep.doseMg,
      weeks: data.currentStep?.typicalWeeks ?? data.nextStep.typicalWeeks,
    });
  }, [data, t]);

  const headerExtras = data ? (
    <span
      className="text-muted-foreground text-[10px] uppercase tracking-wide"
      data-slot="titration-drug-inn"
    >
      {data.drugInn}
    </span>
  ) : null;

  return (
    <MedicationDetailSection
      titleId="titration-heading"
      title={t("medications.titration.section")}
      headerExtras={headerExtras}
      dataSlot="titration-section"
    >
      {isLoading && (
        <div className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("medications.titration.loading")}</span>
        </div>
      )}

      {!!error && !isLoading && (
        <p className="text-destructive">
          {t("medications.titration.loadFailed")}
        </p>
      )}

      {data && !isLoading && (
        <div className="space-y-3">
          <p className="text-muted-foreground text-[11px] uppercase tracking-wide">
            {t("medications.titration.drugLadderHeader")}
          </p>

          {hasLadder ? (
            <ol
              className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch"
              aria-label={t("medications.titration.drugLadderHeader")}
            >
              {data.ladder.map((step) => {
                const isCurrent = currentIdx === step.stepIndex;
                const isPast =
                  currentIdx !== null && step.stepIndex < currentIdx;
                return (
                  <li
                    key={step.stepIndex}
                    className={[
                      "border-border/70 flex flex-1 flex-col rounded-md border px-2.5 py-2 sm:min-w-[7rem]",
                      isCurrent
                        ? "border-primary ring-primary/40 ring-2"
                        : "",
                    ].join(" ")}
                    aria-current={isCurrent ? "step" : undefined}
                    data-slot="titration-step"
                    data-step-index={step.stepIndex}
                    data-step-state={
                      isCurrent ? "current" : isPast ? "past" : "upcoming"
                    }
                  >
                    <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
                      {t("medications.titration.stepLabel", {
                        n: step.stepIndex + 1,
                      })}
                    </span>
                    <span className="text-foreground text-sm font-medium">
                      {step.doseMg} {t("medications.titration.doseUnitMg")}
                    </span>
                    <span className="text-muted-foreground text-[10px]">
                      {t("medications.titration.typicalWeeksOnStep", {
                        weeks: step.typicalWeeks,
                      })}
                    </span>
                    {isCurrent && (
                      <span className="text-primary mt-1 text-[10px] font-medium uppercase tracking-wide">
                        {t("medications.titration.youAreHere")}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-muted-foreground">
              {t("medications.titration.emptyState")}
            </p>
          )}

          {data.currentStep === null && hasLadder && (
            <p className="text-muted-foreground">
              {t("medications.titration.nonStandardDose")}
            </p>
          )}

          {dwellHint && (
            <p
              className="text-muted-foreground"
              data-slot="titration-dwell-hint"
            >
              {dwellHint}
            </p>
          )}

          {nextStepCaption && (
            <p className="text-muted-foreground">{nextStepCaption}</p>
          )}

          {data.nextStep === null && data.currentStep !== null && (
            <p className="text-muted-foreground">
              {t("medications.titration.ceilingMessage")}
            </p>
          )}

          <div className="border-border/60 border-t pt-2">
            <p className="text-muted-foreground text-[10px]">
              {t("medications.titration.disclaimer")}
            </p>
            <a
              href={data.sourceEMA}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground/80 hover:text-foreground mt-1 inline-flex items-center gap-1 text-[10px] underline-offset-2 hover:underline"
            >
              {t("medications.titration.emaSourceCta")}
              <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      )}
    </MedicationDetailSection>
  );
}
