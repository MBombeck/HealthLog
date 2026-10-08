"use client";

import Link from "next/link";
import { ArrowRight, Gauge, Heart } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { useChartDomainStats } from "@/hooks/use-chart-domain-stats";
import { Button } from "@/components/ui/button";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { CoachReadStrip } from "@/components/insights/derived/coach-read-strip";
import { MetricCorrelationCard } from "@/components/insights/metric-correlation-card";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { EcgCrossLink } from "@/components/insights/ecg-cross-link";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { TileHeader } from "@/components/insights/tile-header";
import dynamic from "next/dynamic";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";

// Load the intraday area chart through the shared chart-runtime boundary (the
// one recharts chunk), not as a direct import — a direct `from "recharts"`
// import would mint a second recharts fingerprint chunk and trip the bundle
// budget. Same `dynamic(() => import("@/components/charts/chart-runtime"))`
// pattern every other chart uses.
const IntradayPulseChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.IntradayPulseChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

/**
 * v1.4.25 W4 — `/insights/pulse`.
 *
 * Routed Pulse sub-page. Renders the raw/workout-inclusive pulse chart
 * plus the per-section AI assessment. Note: `chartKey="pulse"` so the
 * chart-cog can override the comparison-overlay independently from the
 * dashboard pulse card; the MeasurementType filter is `PULSE` (the same
 * field used elsewhere in the codebase).
 *
 * v1.32.1 (issue #584) — this page no longer paints the personalized
 * resting-pulse target band (`getPersonalizedPulseTarget()`, CDC/NCHS
 * resting-pulse percentiles) behind the chart: that band is calibrated
 * to steady-state resting readings and would misreport an expected
 * workout spike in the raw PULSE series as "out of target". The
 * personal target + its band belong on the dedicated
 * `/insights/resting-pulse` page, against the clean resting series.
 *
 * Analytics fetch + empty-state branch consume `useInsightsAnalytics()`
 * + `<MetricEmptyState>`. VO₂ max is a cardio-fitness metric, so the page
 * links across to the dedicated `/insights/cardio-fitness` surface (which
 * owns the full chart + assessment) rather than rendering a second view.
 */
export default function InsightsPulsPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data: analytics, isEmpty } = useInsightsAnalytics("PULSE");
  // VO₂ max rides on the same `/api/analytics` bundle; we only need the
  // sample count to decide whether to surface the cross-link to the
  // dedicated cardio-fitness page.
  const hasVo2 = (analytics?.summaries?.VO2_MAX?.count ?? 0) > 0;
  const pulseSummary = analytics?.summaries?.PULSE ?? null;
  // v1.32.1 (issue #584) — this page is titled, captured, and stat-stripped
  // as PULSE throughout; the chart must chart PULSE too. `hasRestingHr` used
  // to swap the ENTIRE primary chart + Coach read to RESTING_HEART_RATE
  // whenever any resting row existed, which silently showed a different
  // metric than the page's own title/stat-strip/capture action claimed.
  // RESTING_HEART_RATE now only ever appears as a second, clearly-labelled
  // series alongside PULSE (same multi-series pattern the blood-pressure
  // page uses for systolic/diastolic) — never a full swap. The dedicated
  // `/insights/resting-pulse` page owns the resting-only view + its target
  // band.
  const hasRestingHr =
    (analytics?.summaries?.RESTING_HEART_RATE?.count ?? 0) > 0;

  // v1.12.8 — visible-range stats shared between the pulse chart and the
  // strip (the VO2 chart-row below keeps its own full-range read).
  const { statsByType, onVisibleStats } = useChartDomainStats();

  // v1.4.27 F17 — gate the sub-page on at least one pulse observation.
  // Brand-new accounts (no manual logs, no Apple-Health upload yet)
  // see a one-line empty-state with a CTA into
  // `/measurements?add=PULSE` rather than a chart skeleton over a
  // blank target band. v1.4.27 MB6 — query-param replaces the dead
  // `/measurements/new` route.
  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.pulseSectionTitle")}
        description={t("insights.subPage.pulsDescription")}
        explainerMetric="pulse"
      >
        <MetricEmptyState
          icon={<Heart className="size-6" />}
          title={t("insights.emptyState.pulse.title")}
          description={t("insights.emptyState.pulse.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/measurements?add=PULSE">
                {t("insights.emptyState.pulse.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I haven't recorded any resting pulse yet — why does it matter, and what should I know before I start?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.pulseSectionTitle")}
      description={t("insights.subPage.pulsDescription")}
      explainerMetric="pulse"
      statStrip={
        <MetricStatStrip
          summary={pulseSummary}
          unit="bpm"
          seriesLabel={t("insights.pulseSectionTitle")}
          icon={Heart}
          windowStats={statsByType?.PULSE ?? null}
        />
      }
      coachReadStrip={
        <CoachReadStrip metricType="PULSE" unit="bpm" fractionDigits={0} />
      }
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType="PULSE"
          metricLabel={t("insights.pulseSectionTitle")}
          timeZone={user?.timezone ?? undefined}
        />
      }
      coachLaunch
      captureType="PULSE"
      showAllValuesType="PULSE"
    >
      <HealthChartDynamic
        chartKey="pulse"
        types={hasRestingHr ? ["PULSE", "RESTING_HEART_RATE"] : ["PULSE"]}
        title={t("charts.pulse")}
        titleIcon={Heart}
        colors={
          hasRestingHr
            ? ["var(--success)", "var(--destructive)"]
            : ["var(--success)"]
        }
        unit="bpm"
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
        onVisibleStats={onVisibleStats}
        showDataTable
        dayLinks
      />

      {/* S11 — the intraday "shape of the day" layer: 10-minute mean heart
          rate with the resting baseline and any cautious elevated-at-rest
          window. Computed on demand from raw for today; non-diagnostic. */}
      <IntradayPulseChart userTimezone={user?.timezone} />

      <MetricTargetSummary slug="pulse" />

      {/* v1.12.0 — Pulse owns the mood × pulse correlation (relocated off
          the overview onto its metric page). */}
      <MetricCorrelationCard slug="pulse" />

      {/* v1.12.8 — the Einschätzung (assessment) sits ABOVE the cardio-fitness
          CTA so the plain-language read of the pulse data leads, and the
          cross-link to the dedicated VO₂ max page trails it. */}
      <SlugInsightStatusCard
        slug="pulse"
        icon={<Heart className="h-5 w-5" />}
      />

      {/* S10 — device-attributed pointer into the ECG viewer, in the
          resting-HR / pulse context. Un-mounts when the user has no ECG
          recordings; surfaces only that recordings exist + the device's own
          latest result, never a HealthLog interpretation. */}
      <EcgCrossLink enabled={isAuthenticated} />

      {/* VO₂ max is a cardio-fitness metric (Apple's Health app surfaces it
          under "Heart"), so the pulse page links across to its dedicated
          `/insights/cardio-fitness` page — the single surface that carries
          the full chart plus the plain-language assessment — rather than
          duplicating a second, divergent VO₂ max view here.

          v1.12.8 — the card now leads with the canonical `<TileHeader>` so the
          `Gauge` glyph reads in the foreground colour at the same size and
          position as every other tile header, with the body + CTA beneath. */}
      {hasVo2 ? (
        <Link
          href="/insights/cardio-fitness"
          data-slot="vo2-cardio-link"
          className="bg-card hover:bg-accent/40 focus-visible:ring-ring/50 block space-y-1.5 rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none md:p-6"
        >
          <TileHeader
            icon={Gauge}
            title={t("insights.vo2Max.cardioLinkTitle")}
          />
          <span className="text-muted-foreground block text-xs leading-snug">
            {t("insights.vo2Max.cardioLinkBody")}
          </span>
          <span className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-medium">
            {t("insights.vo2Max.cardioLinkCta")}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </span>
        </Link>
      ) : null}
    </SubPageShell>
  );
}
