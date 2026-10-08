"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Loader2, Pill } from "lucide-react";

import { useAiCapability } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { nextStatusPollInterval } from "@/hooks/use-insight-status";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ComplianceHeatmap } from "@/components/charts/compliance-heatmap";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { MedicationEfficacySummary } from "@/components/insights/medication-efficacy-summary";
import { Glp1SubstanceCurveSummary } from "@/components/insights/glp1-substance-curve-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { TileHeader } from "@/components/insights/tile-header";
import { apiGet } from "@/lib/api/api-fetch";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";

/**
 * v1.4.25 W4 — `/insights/medications`.
 *
 * Routed Medication-Compliance sub-page. Mirrors the per-medication
 * grid from the v1.4.24 mother page (compliance bars + heatmap +
 * per-med assistant sentence) plus the section-level assessment.
 *
 * No `<HealthChart>` here — medication compliance is event-driven, so
 * the data path runs through `/api/insights/comprehensive` +
 * `/api/medications/[id]/compliance` instead of the measurement-series
 * Prisma path.
 *
 * Empty-state: zero medications → big "Add your first medication" CTA.
 */

interface MedicationEntry {
  id: string;
  name: string;
  dose: string;
  /** A built-in category value or `custom:<uuid>` (v1.40). */
  category: string;
  /** v1.40 — the label of a custom category; null for a built-in one. */
  categoryLabel?: string | null;
  compliance7: number;
  compliance30: number;
  streak: number;
  taken7: number;
  skipped7: number;
  missed7: number;
}

interface ComprehensiveMedicationData {
  medications: MedicationEntry[];
}

interface MedicationComplianceStatusData {
  hasProvider: boolean;
  summary: string | null;
  medications: Array<{ medicationId: string; text: string }>;
  cached: boolean;
  updatedAt: string | null;
  // v1.8.3 — read-only route returns preparing:true with summary:null on a
  // cache miss while the worker warms the assessment; the card polls until
  // it lands. See `use-insight-status.ts` for the shared rationale.
  preparing?: boolean;
  // v1.9.0 — last-good narrative served while a refresh is in flight; the
  // card keeps polling (bounded) so the open page upgrades in-session.
  revalidating?: boolean;
}

// v1.8.3 — client ceiling on the round-trip, mirroring the shared
// `use-insight-status` hook so the medication-compliance card never awaits
// an uncapped LLM round-trip on navigation. The preparing-poll cadence and
// its attempt ceiling come from the shared `nextStatusPollInterval` helper.
const MED_STATUS_TIMEOUT_MS = 8_000;

interface MedicationDailyData {
  expected: number;
  taken: number;
  skipped: number;
  onTime?: number;
  late?: number;
  veryLate?: number;
}

interface MedicationComplianceDailyResponse {
  dailyCompliance: Record<string, MedicationDailyData>;
}

export default function InsightsMedikamentePage() {
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();
  // The compliance summary and the per-medication sentences are status notes:
  // read only while the `statusText` capability is available.
  const statusText = useAiCapability("statusText");

  const {
    data: comprehensive,
    isLoading: isComprehensiveLoading,
    isError: isComprehensiveError,
    refetch: refetchComprehensive,
  } = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      return apiGet<ComprehensiveMedicationData>("/api/insights/comprehensive");
    },
    enabled: isAuthenticated,
  });

  const { data: status, isLoading: isStatusLoading } = useQuery({
    queryKey: queryKeys.insightsMedicationComplianceStatus(locale),
    queryFn: async () => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        MED_STATUS_TIMEOUT_MS,
      );
      try {
        return apiGet<MedicationComplianceStatusData>(
          `/api/insights/medication-compliance-status?locale=${locale}`,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    enabled: isAuthenticated && statusText.available,
    staleTime: 60 * 1000,
    retry: 0,
    // v1.8.4 — bounded preparing poll: stop after the shared attempt
    // ceiling so a persistently failing generation can't poll an open
    // page forever.
    refetchInterval: (query) =>
      nextStatusPollInterval(
        query.state.data?.preparing,
        query.state.dataUpdateCount,
        query.state.data?.revalidating,
      ),
  });

  const medications = comprehensive?.medications ?? [];
  const medicationSummaryById = new Map(
    (status?.medications ?? []).map((entry) => [
      entry.medicationId,
      entry.text,
    ]),
  );

  if (isComprehensiveLoading) {
    return (
      <SubPageShell
        title={t("insights.medicationCompliance")}
        explainerMetric="medications"
      >
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        </div>
      </SubPageShell>
    );
  }

  // A failed comprehensive read leaves `medications` empty, which is
  // indistinguishable from an account that tracks none — and the empty state
  // then invites someone on five daily medications to add the medications the
  // app already holds. A read failure gets its own branch, before the length
  // check, mirroring the sibling overview at `/insights`.
  if (isComprehensiveError) {
    return (
      <SubPageShell
        title={t("insights.medicationCompliance")}
        explainerMetric="medications"
      >
        <QueryErrorCard
          description={t("insights.loadError")}
          onRetry={() => refetchComprehensive()}
        />
      </SubPageShell>
    );
  }

  if (medications.length === 0) {
    // v1.4.27 F17 — medication compliance is event-driven so the
    // gate reads `medications.length > 0`. CTA targets `/medications`
    // (the dedicated medication-management surface).
    return (
      <SubPageShell
        title={t("insights.medicationCompliance")}
        explainerMetric="medications"
      >
        <EmptyState
          icon={<Pill className="size-6" />}
          title={t("insights.emptyState.medication.title")}
          description={t("insights.emptyState.medication.description")}
          ctaSize="lg"
          action={
            <Button size="sm" asChild>
              <Link href="/medications">
                {t("insights.emptyState.medication.cta")}
              </Link>
            </Button>
          }
        />
        <CoachLaunchButton
          prefill={t("insights.medicationsEmpty.coachPrefill")}
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.medicationCompliance")}
      description={t("insights.subPage.medikamenteDescription")}
      explainerMetric="medications"
      coachLaunch
    >
      {/* No `<MetricRangeControls>` here: medication compliance is
          event-driven, not a MeasurementType series, so the period-over-period
          range read has nothing to aggregate. */}
      <div
        className={
          medications.length >= 2 ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"
        }
      >
        {medications.map((med) => {
          const medicationSummary = medicationSummaryById.get(med.id);
          // v1.12.6 — the per-medication compliance card harmonises with
          // the rest of the Insights tiles: its header runs through the
          // canonical `<TileHeader>` (Pill glyph + med name as the white
          // heading), and the dose + category + streak fold into one
          // compact muted line below it. Every datum the previous, taller
          // card carried (7d/30d bars, taken/skipped/missed, heatmap,
          // per-med assistant sentence) stays — only the vertical rhythm
          // tightens.
          const categoryLabel = getMedicationCategoryLabel(
            med.category,
            t,
            med.categoryLabel,
          );
          return (
            <Card key={med.id} className="gap-2 py-3 md:py-4">
              <CardHeader>
                <TileHeader icon={Pill} title={med.name} />
                <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium tabular-nums">{med.dose}</span>
                  <span aria-hidden="true">·</span>
                  <span>{categoryLabel}</span>
                  {med.streak > 0 ? (
                    <Badge
                      variant="outline"
                      className="ml-auto shrink-0 text-xs"
                    >
                      {med.streak === 1
                        ? t("insights.dayStreakOne", { count: med.streak })
                        : t("insights.dayStreak", { count: med.streak })}
                    </Badge>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span>{t("insights.compliance7d")}</span>
                    <span className="font-medium">{med.compliance7}%</span>
                  </div>
                  {/* v1.4.33 IW9 — aria-label so the bar has an
                      accessible name (Lighthouse a11y 91/94). */}
                  <Progress
                    value={med.compliance7}
                    className="h-1.5"
                    aria-label={t("insights.compliance7d")}
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span>{t("insights.compliance30d")}</span>
                    <span className="font-medium">{med.compliance30}%</span>
                  </div>
                  <Progress
                    value={med.compliance30}
                    className="h-1.5"
                    aria-label={t("insights.compliance30d")}
                  />
                </div>
                <div className="text-muted-foreground flex justify-between text-xs">
                  <span>
                    <span className="text-success">{med.taken7}</span>{" "}
                    {t("insights.taken")}
                  </span>
                  <span>
                    <span className="text-warning">{med.skipped7}</span>{" "}
                    {t("insights.skipped")}
                  </span>
                  <span>
                    <span className="text-destructive">{med.missed7}</span>{" "}
                    {t("insights.missed")}
                  </span>
                </div>
                <MedicationComplianceCalendar medicationId={med.id} />
                {medicationSummary ? (
                  <p className="text-foreground text-sm leading-6">
                    {medicationSummary}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* v1.28 — compact efficacy summary: reuses the same server-computed
          efficacy DTO the detail-page "Wirkung" tab reads (never a second
          computation), association-only, linking through to the full view. */}
      <MedicationEfficacySummary
        medications={medications.map((m) => ({ id: m.id, name: m.name }))}
      />

      {/* v1.28.20 — estimated active-substance curve for GLP-1 medications
          (additive; renders nothing when the user has no GLP-1 medication). */}
      <Glp1SubstanceCurveSummary
        medications={medications.map((m) => ({
          id: m.id,
          name: m.name,
          dose: m.dose,
        }))}
      />

      <MetricTargetSummary slug="medications" />

      {/* v1.12.2 — the assessment is the LAST block on every bespoke
          metric-detail page, matching the canonical spine the generic
          scaffold renders. This card reads the medication-compliance
          status route, which carries a richer envelope (`summary` +
          per-medication `text`) than the standard `text`-only generators,
          so it keeps its inline wiring rather than the shared
          `<SlugInsightStatusCard>` seam. */}
      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<Pill className="h-5 w-5" />}
        text={status?.summary ?? null}
        hasProvider={status?.hasProvider ?? false}
        updatedAt={status?.updatedAt ?? null}
        coachQuestion={t("insights.coach.assessmentPrompt", {
          metric: t("insights.medicationCompliance"),
        })}
        coachScope={{ metric: "compliance" }}
        coachAutoSend
        loading={isStatusLoading}
        preparing={status?.preparing ?? false}
      />
    </SubPageShell>
  );
}

function MedicationComplianceCalendar({
  medicationId,
}: {
  medicationId: string;
}) {
  const { t } = useTranslations();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.medicationComplianceChart(medicationId),
    queryFn: async () => {
      try {
        return await apiGet<MedicationComplianceDailyResponse>(
          `/api/medications/${medicationId}/compliance`,
        );
      } catch {
        // The calendar simply doesn't render — same as the raw
        // `if (!res.ok) return null` did.
        return null;
      }
    },
    enabled: !!medicationId,
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="text-primary h-4 w-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!data?.dailyCompliance) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-xs">
        {t("insights.complianceNoData")}
      </div>
    );
  }

  return (
    <div className="w-full">
      <ComplianceHeatmap dailyCompliance={data.dailyCompliance} stretch />
    </div>
  );
}
