"use client";

/**
 * v1.28 — the "Wirkung" tab body: a strictly-descriptive, association-only
 * view relating a medication to the outcome metric(s)/lab(s) its class is
 * prescribed to move, around its start. Reads the server-authoritative
 * efficacy DTO (`GET /api/medications/[id]/efficacy`) and renders it — it
 * never recomputes a delta, mean, or adherence rate. No verdict, no score, no
 * "working / not working" language, no dose advice: the copy is numbers +
 * neutral connective phrasing only, mirroring the adherence-storyline posture.
 */
import { MedicalDisclaimer } from "@/components/common/medical-disclaimer";
import { useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Minus,
  TrendingUp,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { Segmented } from "@/components/ui/segmented";
import { TileHeader } from "@/components/insights/tile-header";
import { Glp1PlateauNote } from "@/components/insights/glp1-plateau-note";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { TagChip } from "@/components/ui/tag-chip";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import type {
  MedicationEfficacyDTO,
  EfficacyTargetView,
} from "@/lib/medications/efficacy/build-efficacy";
import { EmptyState } from "@/components/ui/empty-state";
import {
  SEGMENTED_MIN_DAYS_PER_SIDE,
  SEGMENTED_MIN_SPAN_DAYS,
} from "@/lib/medications/efficacy/segmented-effect";
import { ChangeAtStartSummary } from "./change-at-start-summary";
import { RetargetSheet, useMayRetarget } from "./retarget-sheet";

// v1.30 UI audit (M8) — `EfficacyChart` mounts inside `TargetCard`'s own
// `<Card>` as a bare 220px `ResponsiveContainer` with no chrome of its own.
// The default `<ChartSkeleton>` fallback is a rounded-xl bordered card with
// faux header + a 240/280px band — a card nested in a card, then a ~100px
// height snap when the real chart mounts. A chrome-less skeleton sized to
// the actual chart avoids both.
const EfficacyChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.EfficacyChart,
    })),
  { ssr: false, loading: () => <Skeleton className="h-[220px] w-full" /> },
);

// v1.28.20 — the estimated active-substance curve (Wirkstoffverlauf) also
// surfaces here, additive to the Injektion tab. Same self-contained chart,
// same `next/dynamic` (client-only) load that keeps Recharts out of the
// initial bundle.
const DrugLevelChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.DrugLevelChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

export function EfficacyTab({
  medicationId,
  active,
  isGlp1 = false,
  medicationName,
  medicationDose,
}: {
  medicationId: string;
  active: boolean;
  /**
   * True when the parent already knows the medication is a (non-one-shot)
   * GLP-1 drug (`treatmentClass === "GLP1"`). Threaded from the detail-tabs
   * parent because the efficacy DTO carries the target class, not the raw
   * treatment class. Gates the estimated active-substance curve exactly the
   * way the Injektion tab does — no Research-Mode wrapper, GLP-1 alone.
   */
  isGlp1?: boolean;
  /** Brand/generic name the substance-curve chart resolves to a catalog id. */
  medicationName?: string;
  /** Headline dose string, the chart's per-intake dose fallback. */
  medicationDose?: string;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const [retargetOpen, setRetargetOpen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.medicationEfficacy(medicationId),
    queryFn: () =>
      apiGet<MedicationEfficacyDTO>(
        `/api/medications/${medicationId}/efficacy`,
      ),
    enabled: active,
    staleTime: 60_000,
  });
  const mayRetarget = useMayRetarget(data?.overrideOptions);

  if (isLoading) {
    return (
      <MedicationDetailSection
        titleId="medication-wirkung-heading"
        title={t("medications.efficacy.title")}
        dataSlot="medication-wirkung-section"
      >
        <ChartSkeleton />
      </MedicationDetailSection>
    );
  }

  // A failed fetch previously fell through to the loading skeleton forever
  // (the guard above checked `isLoading || !data`, and `data` never
  // arrives on error) — an honest retry surface instead of a silent hang.
  if (isError || !data) {
    return (
      <MedicationDetailSection
        titleId="medication-wirkung-heading"
        title={t("medications.efficacy.title")}
        dataSlot="medication-wirkung-section"
      >
        <QueryErrorCard error={error} onRetry={() => refetch()} />
      </MedicationDetailSection>
    );
  }

  // The tab is hidden upstream when ineligible; this is a defensive fallback.
  if (!data.eligible) {
    return (
      <MedicationDetailSection
        titleId="medication-wirkung-heading"
        title={t("medications.efficacy.title")}
        dataSlot="medication-wirkung-section"
      >
        <p className="text-muted-foreground text-sm">
          {t("medications.efficacy.notEligible")}
        </p>
      </MedicationDetailSection>
    );
  }

  return (
    <div className="space-y-6" data-slot="medication-wirkung-section">
      {mayRetarget && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => setRetargetOpen(true)}
            data-slot="medication-wirkung-retarget-open"
          >
            {t("medications.detail.overview.changeMetric")}
          </Button>
        </div>
      )}

      {data.targets.map((target, index) => (
        <TargetCard
          key={`${target.kind}:${target.key}`}
          target={target}
          dto={data}
          timezone={timezone}
          first={index === 0}
          showPrimary={data.targets.length > 1}
        />
      ))}

      {/* v1.28.20 — estimated active-substance curve for GLP-1 medications,
          mirroring the Injektion tab. Self-contained (own reads, own card,
          own estimate disclaimer). */}
      {isGlp1 && medicationName != null && medicationDose != null ? (
        <div className="space-y-6" data-slot="wirkung-drug-level-section">
          <DrugLevelChart
            medication={{
              id: medicationId,
              name: medicationName,
              dose: medicationDose,
            }}
          />
          {/* v1.28.21 — weight-plateau note (association only). Self-gating:
              renders nothing unless the server-side detector reports a
              plateau on the current dose. */}
          <Glp1PlateauNote />
        </div>
      ) : null}

      <MedicalDisclaimer variant="notCause" />

      {mayRetarget && (
        <RetargetSheet
          medicationId={medicationId}
          options={data.overrideOptions}
          isOverride={data.resolution.tier === "override"}
          open={retargetOpen}
          onOpenChange={setRetargetOpen}
        />
      )}
    </div>
  );
}

function TargetCard({
  target,
  dto,
  timezone,
  first,
  showPrimary,
}: {
  target: EfficacyTargetView;
  dto: MedicationEfficacyDTO;
  timezone: string;
  /** The first card carries the view's own explanation in its method fold. */
  first: boolean;
  /** Mark the primary target when there is more than one. */
  showPrimary: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [scaleMode, setScaleMode] = useState<"absolute" | "percent">(
    "absolute",
  );
  const startMs = dto.markers.start ? Date.parse(dto.markers.start) : null;
  const ba = target.beforeAfter;
  const direction = target.result?.direction ?? null;
  const DeltaIcon =
    direction === "lower"
      ? ArrowDown
      : direction === "higher"
        ? ArrowUp
        : Minus;

  return (
    <Card data-slot={`medication-wirkung-target-${target.kind}`}>
      <CardHeader>
        <TileHeader
          icon={TrendingUp}
          title={target.label}
          titleAs="h2"
          right={
            target.series.length > 0 ? (
              <div
                className="flex items-center gap-2"
                data-slot="chart-header-controls"
              >
                {showPrimary && target.primary && (
                  <TagChip>{t("medications.efficacy.primaryBadge")}</TagChip>
                )}
                <Segmented
                  size="sm"
                  mode="toggle"
                  value={scaleMode}
                  options={[
                    {
                      value: "absolute",
                      label:
                        target.unit ?? t("medications.efficacy.scaleAbsolute"),
                    },
                    {
                      value: "percent",
                      label: t("medications.efficacy.scalePercentSinceStart"),
                    },
                  ]}
                  onChange={setScaleMode}
                  label={t("medications.efficacy.scaleToggleLabel")}
                  slot="medication-wirkung-scale-toggle"
                />
              </div>
            ) : undefined
          }
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {target.result && (
          <p
            className="text-foreground text-base"
            data-slot="medication-wirkung-result"
          >
            {target.result.text}
          </p>
        )}
        {ba.present && ba.before && ba.after && ba.delta && (
          <p
            className="flex items-baseline gap-2"
            data-slot="medication-wirkung-beforeafter"
          >
            <span className="text-foreground text-3xl font-semibold tabular-nums">
              {fmt.number(ba.before.mean)}
            </span>
            <ArrowRight
              aria-label={t("medications.detail.overview.since")}
              className="text-muted-foreground size-4 self-center"
            />
            <span className="text-foreground text-3xl font-semibold tabular-nums">
              {fmt.number(ba.after.mean)}
            </span>
            {target.unit && (
              <span className="text-muted-foreground text-sm">
                {target.unit}
              </span>
            )}
            <span className="text-foreground ml-auto inline-flex items-center gap-0.5 text-sm tabular-nums">
              <DeltaIcon aria-hidden="true" className="size-4" />
              {fmt.number(Math.abs(ba.delta.mean))}
            </span>
          </p>
        )}
        {target.series.length > 0 ? (
          <EfficacyChart
            target={{
              label: target.label,
              unit: target.unit,
              referenceBand: target.referenceBand,
              series: target.series.map((p) => ({ t: p.t, value: p.value })),
            }}
            startMs={startMs}
            doseChanges={dto.markers.doseChanges}
            pauses={dto.markers.pauses}
            adherence={dto.adherence.map((a) => ({
              date: a.date,
              rate: a.rate,
            }))}
            timezone={timezone}
            startLabel={t("medications.efficacy.startMarker")}
            adherenceLabel={t("medications.efficacy.adherenceLane")}
            typicalRangeLabel={t("medications.efficacy.typicalRange")}
            mode={scaleMode}
          />
        ) : (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("medications.efficacy.noSeries")}
          />
        )}

        <Disclosure
          summary={t("medications.efficacy.method")}
          data-slot="medication-wirkung-method"
        >
          {first && (
            <p className="text-foreground text-sm">
              {t("medications.efficacy.intro")}
            </p>
          )}
          {first && dto.markers.startSource === "firstReading" && (
            <p className="text-foreground text-sm">
              {t("medications.efficacy.startFallback")}
            </p>
          )}
          {ba.present && ba.before && ba.after && (
            <p className="text-foreground text-sm">
              {t("medications.efficacy.beforeAfter.counts", {
                beforeCount: ba.before.count,
                afterCount: ba.after.count,
              })}
            </p>
          )}
          {target.segmented ? (
            <ChangeAtStartSummary
              segmented={target.segmented}
              unit={target.unit}
              minDays={SEGMENTED_MIN_DAYS_PER_SIDE}
              minSpanDays={SEGMENTED_MIN_SPAN_DAYS}
            />
          ) : null}
          {target.levelShift?.present &&
          target.levelShift.nearStart &&
          target.levelShift.at ? (
            <p
              className="text-foreground text-sm"
              data-slot="medication-wirkung-levelshift"
            >
              {t("medications.efficacy.levelShift", {
                date: fmt.date(target.levelShift.at),
              })}
            </p>
          ) : null}
        </Disclosure>
      </CardContent>
    </Card>
  );
}
