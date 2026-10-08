"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Smile } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import {
  MoodInsightsSections,
  useMoodInsights,
} from "@/components/insights/mood/mood-insights-sections";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import {
  SubPageAddButton,
  SubPageShell,
} from "@/components/insights/sub-page-shell";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * The mood form, loaded only when the header plus opens it: the route's first
 * paint is the calendar and the chart, and the form's tag catalogue is heavy.
 */
const MoodForm = dynamic(
  () =>
    import("@/components/mood/mood-form").then((mod) => ({
      default: mod.MoodForm,
    })),
  { ssr: false, loading: () => null },
);

/**
 * v1.4.25 W4 — `/insights/mood`.
 *
 * Routed Mood sub-page. Unlike the mother page (which hid the mood
 * section entirely when no mood data existed), a dedicated sub-page
 * cannot just blank itself — we'd land on an empty white page. Instead,
 * the sub-page surfaces a clear empty-state CTA into `/mood` so the
 * user can log their first entry, matching the Apple Health "No data"
 * convention (research §1.1).
 */
const MoodChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

/**
 * The day's two readings. Deferred like every other block on this route that
 * is not the first paint: it reads its own endpoint and renders below the
 * calendar, so nothing about it belongs in the eager graph of a page whose
 * first paint is a heatmap. This route sits close to its bundle ceiling and
 * every addition to it goes through the same treatment.
 */
const MoodPrognosisCard = dynamic(
  () =>
    import("@/components/insights/mood/mood-prognosis-card").then((mod) => ({
      default: mod.MoodPrognosisCard,
    })),
  { ssr: false, loading: () => null },
);

interface ComprehensiveMoodData {
  moodSummary: { count: number } | null;
}

export default function InsightsMoodPageClient() {
  const { user, isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);
  // A mood entry is a MANAGE create under the mind section, as on `/mood`.
  const { canManageDomain } = useRecordCapabilities();
  const canAddMood = canManageDomain("mind") && user?.modules?.mood !== false;
  const [addOpen, setAddOpen] = useState(false);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);

  // v1.42 — the calendar and the line chart appear together. The chart says
  // when its read has settled (`onDataReady`, the dashboard's reveal gate);
  // the calendar's read is the shared mood-insights cell. Until both are in,
  // each holds its final-height skeleton, so the reveal moves nothing.
  const [chartSettled, setChartSettled] = useState(false);
  const markChartSettled = useCallback(() => setChartSettled(true), []);
  const insights = useMoodInsights();
  const topRevealed = chartSettled && !insights.isPending;

  // Reuse the mother-page comprehensive query — TanStack Query
  // dedups so this is a free cache read for the common case.
  const { data: comprehensive } = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      return apiGet<ComprehensiveMoodData>("/api/insights/comprehensive");
    },
    enabled: isAuthenticated,
  });

  const moodCount = comprehensive?.moodSummary?.count ?? 0;

  // v1.4.27 F17 — Mood is event-driven so the gate reads
  // `hasMood = moodCount > 0`. CTA targets `/mood` (the dedicated
  // mood-logging surface) — short-circuits the user to the quickest
  // path to log their first entry.
  //
  // v1.4.28 R3d (BK-F-M1) — empty-state render delegates to the shared
  // `<MetricEmptyState>` primitive. The mood data path stays on
  // `/api/insights/comprehensive` because the `moodSummary.count`
  // signal is event-driven, not sensor-aggregated.
  if (isAuthenticated && comprehensive && moodCount === 0) {
    return (
      <SubPageShell
        title={t("insights.moodSectionTitle")}
        description={t("insights.subPage.stimmungDescription")}
        explainerMetric="mood"
      >
        <MetricEmptyState
          icon={<Smile className="size-6" />}
          title={t("insights.emptyState.mood.title")}
          description={t("insights.emptyState.mood.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/mood">{t("insights.emptyState.mood.cta")}</Link>
            </Button>
          }
          coachPrefill="I haven't logged any mood entries yet — why does mood tracking matter, and how should I start?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.moodSectionTitle")}
      description={t("insights.subPage.stimmungDescription")}
      explainerMetric="mood"
      coachLaunch
      headerAction={
        canAddMood ? (
          <SubPageAddButton
            label={t("insights.mood.logLink")}
            onClick={() => setAddOpen(true)}
            slot="insights-mood-add"
          />
        ) : null
      }
    >
      {canAddMood ? (
        <ResponsiveSheet
          open={addOpen}
          onOpenChange={setAddOpen}
          title={t("mood.addEntry")}
          footer={<div ref={setFooterEl} className="flex w-full" />}
        >
          {addOpen ? (
            <MoodForm
              onSuccess={() => setAddOpen(false)}
              onCancel={() => setAddOpen(false)}
              footerSlot={footerEl}
            />
          ) : null}
        </ResponsiveSheet>
      ) : null}

      {/* v1.12.7 — operator spine: heading + summary (the shell above), then
          the Stimmungskalender, then the line chart, then the Ziel card, then
          the better-days Einschätzung, then the classification + breakdowns.
          The heatmap and the assessment are lifted out of `MoodInsightsSections`
          into their own regions so they land in this exact order; all three
          regions share one `moodInsights` query (TanStack dedups the fetch). */}

      {/* v1.42 — the "log a mood entry" and "take a check-in" text links that
          sat here are gone: logging is the header plus, the same control every
          other Insights page carries, and the check-in has its own entry in
          the navigation. */}
      <MoodInsightsSections region="heatmap" reveal={topRevealed} />

      {/* No `<MetricRangeControls>` here: mood is event-driven, not a
          MeasurementType series, so the period-over-period range read
          (`/api/analytics/range`, keyed on a MeasurementType enum) has
          nothing to aggregate. */}
      {/* Held invisible under its own skeleton until the calendar above is
          ready too; it keeps its place in the flow the whole time, so the
          page below never moves. */}
      <div data-slot="insights-mood-chart" className="relative">
        {!topRevealed ? (
          <ChartSkeleton className="absolute inset-0 z-10" />
        ) : null}
        <div
          className={topRevealed ? undefined : "invisible"}
          aria-hidden={topRevealed ? undefined : true}
        >
          <MoodChart
            chartKey="mood"
            compareBaseline={compareBaseline}
            onDataReady={markChartSettled}
            dayLinks
          />
        </div>
      </div>

      <MetricTargetSummary slug="mood" />

      {/* The day's own rating beside what the account's past days imply. It
          sits high because the self-assessment is the leading value on this
          page, and directly under the line chart because that is where a
          reader has just seen the rating it leads with. */}
      <MoodPrognosisCard />

      {/* The better-days Einschätzung sits directly under the Ziel card,
          ahead of the classification tiles and breakdowns. */}
      <MoodInsightsSections region="assessment" />

      <MoodInsightsSections region="rest" />

      {/* v1.12.2 — the assessment is the LAST block on every bespoke
          metric-detail page, matching the canonical spine the generic
          scaffold (weight / bmi / pulse / blood-pressure) renders. The
          reader sees the trend and the breakdown sections first, then the
          narration of them at the foot. */}
      <SlugInsightStatusCard slug="mood" icon={<Smile className="h-5 w-5" />} />
    </SubPageShell>
  );
}
