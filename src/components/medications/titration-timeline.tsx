"use client";

/**
 * v1.18.5 — dose-escalation (titration) timeline for injectable meds.
 *
 * Companion to `DoseStrengthCurve`. Where the curve plots the logged
 * dose-strength history as a step chart, this surface renders the dose
 * STEPS as a vertical timeline — each `MedicationDoseChange` row as one
 * step (2.5 mg → 5 mg → 7.5 mg …) with its effective date — and splits
 * the list at "now" into completed steps and the planned escalation
 * ahead. A "you are here" marker sits at the boundary so the current
 * strength reads at a glance against what is still to come.
 *
 * Data contract: the same `GET /api/medications/[id]/glp1` stream the
 * curve consumes (`doseChanges`, ordered `effectiveFrom asc`). A row with
 * a future `effectiveFrom` is a PLANNED step; the table already accepts
 * future-dated rows, so no schema change is needed to express a plan.
 *
 * Neutral palette only — completed steps in foreground/muted, the current
 * step on the `--primary` accent, planned steps muted with a dashed
 * connector. No alarming colour (med-card rule): nothing here turns
 * red/green by state.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, MapPin } from "lucide-react";

import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { cn } from "@/lib/utils";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { EmptyState } from "@/components/ui/empty-state";

interface DoseChange {
  id: string;
  effectiveFrom: string;
  doseValue: number;
  doseUnit: string;
  note?: string | null;
}

interface Glp1DetailsResponse {
  doseChanges: DoseChange[];
}

export interface TitrationTimelineProps {
  medicationId: string;
  /** Override "now" for deterministic snapshot tests. */
  asOf?: Date;
}

export interface TitrationStep {
  id: string;
  effectiveFrom: number;
  doseValue: number;
  doseUnit: string;
  note?: string | null;
  /** Past-or-now effective date. */
  isPast: boolean;
  /** The latest step whose effective date is at or before "now". */
  isCurrent: boolean;
}

/**
 * Sort the dose-change stream by effective date, classify each row as
 * past / current / planned against `asOf`, and tag the single current
 * step (the latest one already in effect). Exported for the unit test.
 */
export function buildTitrationSteps(
  doseChanges: readonly DoseChange[],
  asOf: Date,
): TitrationStep[] {
  const nowMs = asOf.getTime();
  const sorted = doseChanges
    .map((dc) => ({
      id: dc.id,
      effectiveFrom: Date.parse(dc.effectiveFrom),
      doseValue: dc.doseValue,
      doseUnit: dc.doseUnit,
      note: dc.note ?? null,
    }))
    .filter(
      (p) => Number.isFinite(p.effectiveFrom) && Number.isFinite(p.doseValue),
    )
    .sort((a, b) => a.effectiveFrom - b.effectiveFrom);

  // The current step is the last one whose effective date is <= now.
  let currentIndex = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].effectiveFrom <= nowMs) currentIndex = i;
  }

  return sorted.map((p, i) => ({
    ...p,
    isPast: p.effectiveFrom <= nowMs,
    isCurrent: i === currentIndex,
  }));
}

export function TitrationTimeline({
  medicationId,
  asOf,
}: TitrationTimelineProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data: details } = useQuery<Glp1DetailsResponse | null>({
    queryKey: queryKeys.medicationGlp1Details(medicationId),
    queryFn: async () => {
      try {
        return await apiGet<Glp1DetailsResponse>(
          `/api/medications/${medicationId}/glp1`,
        );
      } catch {
        return null;
      }
    },
    staleTime: 60 * 1000,
  });

  const now = useMemo(() => asOf ?? new Date(), [asOf]);
  const steps = useMemo(
    () => buildTitrationSteps(details?.doseChanges ?? [], now),
    [details, now],
  );

  // Need at least two steps for an escalation to read as a plan; a lone
  // step is just the current dose and the curve / status row already
  // carry it.
  const hasPlan = steps.length >= 2;
  const currentIdx = steps.findIndex((s) => s.isCurrent);
  // Marker sits after the current step (or at the very top when every
  // step is still planned — nothing in effect yet).
  const markerAfter = currentIdx;

  return (
    <MedicationDetailSection
      titleId="titration-timeline-title"
      title={t("medications.titration.title")}
      dataSlot="titration-timeline"
    >
      {!hasPlan ? (
        <EmptyState
          variant="plain"
          title={t("medications.titration.empty")}
          data-slot="titration-timeline-empty"
        />
      ) : (
        <ol className="relative space-y-0" data-slot="titration-timeline-list">
          {steps.map((step, i) => (
            <li key={step.id} data-slot="titration-step">
              {/* "You are here" marker between the current step and the
                  first planned step (or at the top when nothing is yet
                  in effect). */}
              {markerAfter === i - 1 && i > 0 && (
                <TitrationMarker
                  label={t("medications.titration.youAreHere")}
                />
              )}
              {markerAfter === -1 && i === 0 && (
                <TitrationMarker
                  label={t("medications.titration.youAreHere")}
                />
              )}
              <div
                className="flex items-start gap-3 py-2.5"
                data-slot={
                  step.isCurrent
                    ? "titration-step-current"
                    : step.isPast
                      ? "titration-step-past"
                      : "titration-step-planned"
                }
              >
                {/* Connector node + dashed line for planned segments. */}
                <div className="flex flex-col items-center self-stretch pt-1">
                  <span
                    className={cn(
                      "grid h-5 w-5 shrink-0 place-items-center rounded-full border",
                      step.isCurrent
                        ? "border-primary bg-primary/15 text-primary"
                        : step.isPast
                          ? "border-border bg-muted text-muted-foreground"
                          : "border-border text-muted-foreground border-dashed",
                    )}
                    aria-hidden="true"
                  >
                    {step.isPast ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    )}
                  </span>
                  {i < steps.length - 1 && (
                    <span
                      className={cn(
                        "mt-1 w-px flex-1",
                        steps[i + 1].isPast
                          ? "bg-border"
                          : "border-border/60 border-l border-dashed",
                      )}
                      aria-hidden="true"
                    />
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-0.5 pb-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p
                      className={cn(
                        "text-sm font-medium tabular-nums",
                        step.isCurrent ? "text-primary" : "text-foreground",
                      )}
                    >
                      {t("medications.titration.doseStep", {
                        dose: fmt.number(step.doseValue),
                        unit: step.doseUnit,
                      })}
                    </p>
                    <p className="text-muted-foreground shrink-0 text-xs">
                      {step.isPast
                        ? fmt.dateShortSmart(new Date(step.effectiveFrom))
                        : t("medications.titration.plannedFor", {
                            date: fmt.dateShortSmart(
                              new Date(step.effectiveFrom),
                            ),
                          })}
                    </p>
                  </div>
                  {step.note ? (
                    <p className="text-muted-foreground text-xs">{step.note}</p>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </MedicationDetailSection>
  );
}

function TitrationMarker({ label }: { label: string }) {
  return (
    <div
      className="text-primary flex items-center gap-1.5 py-1.5 text-xs font-medium"
      data-slot="titration-you-are-here"
    >
      <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {label}
    </div>
  );
}
