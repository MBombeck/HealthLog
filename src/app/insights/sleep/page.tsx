"use client";

import Link from "next/link";
import { Loader2, Moon } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useModulePageGuard } from "@/hooks/use-module-page-guard";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricStatusCard } from "@/components/insights/metric-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SleepOverview } from "@/components/insights/sleep-overview";
import { SleepRhythmSection } from "@/components/insights/sleep/sleep-rhythm-section";
import { ChronotypeSection } from "@/components/insights/sleep/chronotype-section";
import { AverageSleepSection } from "@/components/insights/sleep/average-sleep-section";
import { SleepQualitySection } from "@/components/insights/sleep/sleep-quality-section";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useSleepRhythm } from "@/components/insights/sleep/use-sleep-rhythm";

/**
 * v1.4.25 W4c — `/insights/sleep`.
 *
 * The Sleep sub-page surfaces the per-stage breakdown + duration trend
 * the v1.4.23 schema gained but never rendered. All charts live inside
 * `<SleepOverview>` so the page-level scaffold stays trivial; data
 * fetches and empty-state handling are encapsulated in the component.
 *
 * v1.4.27 F17 — when `summaries.SLEEP_DURATION.count === 0` (no
 * Apple-Health / Withings sleep rows yet), the page short-circuits
 * to an empty-state CTA pointing at `/settings/integrations` so the
 * user can connect a sleep source.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — analytics fetch + empty-state
 * render consume the shared hook + primitive.
 */
export default function InsightsSchlafPage() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const { ready } = useModulePageGuard("sleep");

  const { isEmpty } = useInsightsAnalytics("SLEEP_DURATION");
  // The three rhythm cards share one `["sleep-rhythm"]` read, so a failure used
  // to paint the same sentence three times, none of them offering a way out.
  // The page owns the shared state and renders one notice with a retry; the
  // cards no longer carry their own copy of it.
  const { isError: rhythmError, refetch: refetchRhythm } = useSleepRhythm(
    Boolean(user) && !isEmpty,
  );

  // v1.18.0 B1 — bounce a direct URL hit on a disabled-sleep account to
  // /insights instead of half-rendering the sleep surface.
  if (!ready) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.sleep.title")}
        description={t("insights.sleep.description")}
        explainerMetric="sleep"
      >
        <MetricEmptyState
          icon={<Moon className="size-6" />}
          title={t("insights.emptyState.sleep.title")}
          description={t("insights.emptyState.sleep.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/settings/integrations">
                {t("insights.emptyState.sleep.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I don't have any sleep data yet — why does sleep tracking matter, and what should I know before I connect a source?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.sleep.title")}
      description={t("insights.sleep.description")}
      explainerMetric="sleep"
      coachLaunch
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType="SLEEP_DURATION"
          metricLabel={t("insights.sleep.title")}
          timeZone={user?.timezone ?? undefined}
        />
      }
      captureType="SLEEP_DURATION"
      showAllValuesType="SLEEP_DURATION"
      /* No `statStrip`: `<SleepOverview>` already leads with the average
         nightly total + per-stage breakdown, so a duration-in-minutes
         min / max / median / mean strip would duplicate it and read in an
         awkward unit. */
    >
      <SleepOverview />

      {/*
        v1.8.7.1 — the duration/architecture assessment lands via the generic
        metric-status route (`?metric=SLEEP_DURATION`). The shared
        `<MetricStatusCard>` owns the hook + card; only the icon differs from
        the HealthKit scaffold (Moon vs Sparkles).

        v1.18.1 — moved up to sit DIRECTLY with the duration/architecture chart
        group it describes (`<SleepOverview>`).

        v1.25 — this is now the page's SINGLE assessment. The sleep-quality
        block below used to carry a second SLEEP_SCORE assessment that mostly
        never generated (no wearable score), leaving a duplicate "connect an AI
        provider" / empty card at the foot of the page. That bottom assessment
        is gone; the quality block keeps its score tiles only. The card mounts
        only on this data-bearing branch, so a source-less account never
        fetches.
      */}
      <MetricStatusCard
        metric="SLEEP_DURATION"
        icon={<Moon className="h-5 w-5" />}
        enabled={!isEmpty}
      />

      {/*
        v1.17.0 — sleep-debt headline + v1.18.7 W-D chronotype, paired in one
        shared row. Both read the same server-authoritative `["sleep-rhythm"]`
        cache (one fetch), so the grid adds no round-trip. They stack on narrow
        viewports and sit side-by-side from `sm` up; each card keeps its own
        internals (the debt headline and the chronotype band treatment).
      */}
      {rhythmError ? (
        <QueryErrorCard
          description={t("insights.sleep.rhythm.loadError")}
          onRetry={() => void refetchRhythm()}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SleepRhythmSection enabled={!isEmpty} />
          <AverageSleepSection enabled={!isEmpty} />
          <ChronotypeSection enabled={!isEmpty} />
        </div>
      )}

      {/*
        v1.17.1 — "Sleep quality" block. Surfaces the WHOOP / Oura nightly
        sleep-quality scores (efficiency / performance / consistency / need /
        disturbance count + the Oura sleep score) that were ingested but never
        rendered. Each tile is data-gated, so the block is invisible for
        non-wearable users and collapses metric-by-metric. Server-authoritative
        — the tiles render stored values. v1.25 — score tiles only; the page's
        single assessment is the SLEEP_DURATION card above.
      */}
      <SleepQualitySection enabled={!isEmpty} />

      <MetricTargetSummary slug="sleep" />
    </SubPageShell>
  );
}
