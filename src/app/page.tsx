"use client";

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  Activity,
  Droplet,
  Footprints,
  Gauge,
  Heart,
  Moon,
  Percent,
  Pill,
  Plus,
  Smile,
  Target,
  TrendingUp,
  Waves,
} from "lucide-react";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import { cn } from "@/lib/utils";
import {
  resolveDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import type { DataSummary as DataSummaryType } from "@/lib/analytics/trends";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MoodForm } from "@/components/mood/mood-form";
import { MedicationIntakeQuickAdd } from "@/components/dashboard/medication-intake-quick-add";
import { TrendCard } from "@/components/charts/trend-card";
import { TrendHint } from "@/components/charts/trend-hint";
import { summaryToTrend7Delta } from "@/lib/analytics/trend-delta";
import { GettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";
import { TourLauncher } from "@/components/onboarding/tour-launcher";
import { RecentAchievementsCard } from "@/components/gamification/recent-achievements-card";
import { RecentWorkoutsTile } from "@/components/dashboard/recent-workouts-tile";

const MoodChart = dynamic(
  () =>
    import("@/components/charts/mood-chart").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const MedicationComplianceChart = dynamic(
  () =>
    import("@/components/charts/medication-compliance-chart").then((mod) => ({
      default: mod.MedicationComplianceChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import type { DataSummary } from "@/lib/analytics/trends";
import { mergeSlimAndThickAnalytics } from "@/lib/analytics/merge-slim-thick";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  buildTrafficLightBands,
  buildTrafficRange,
  buildWeightBandsFromHeight,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
  type TrafficRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";

interface AnalyticsData {
  summaries: Record<string, DataSummary>;
  bpInTargetPct: number | null;
  /**
   * v1.4.18 A1 — share of paired BP readings inside target over the
   * last 7 / 30 days. Drive the BD-Zielbereich tile's `7T:` / `30T:`
   * sub-values; render "—" when the field is null (no paired readings
   * in the window).
   */
  bpInTargetPct7d?: number | null;
  bpInTargetPct30d?: number | null;
  /**
   * v1.4.22 A1 — long-arc all-time aggregate. After the headline
   * re-anchor to last-30-days the all-time number lives as a sub-value
   * on the BD-Zielbereich tile (alongside `7d` and `30d`).
   */
  bpInTargetPctAllTime?: number | null;
  /**
   * v1.4.22 W5 reconcile (Code-H2) — period-aligned prior-window
   * pcts. The BD-Zielbereich tile's comparison-overlay caption picks
   * `priorMonth` for `comparisonBaseline === "lastMonth"` and
   * `priorYear` for `lastYear` so the rendered "Δ X% vs. last month"
   * stays honest. Null when the prior window has no paired readings.
   */
  bpInTargetPctPriorMonth?: number | null;
  bpInTargetPctPriorYear?: number | null;
  glucoseByContext?: Record<string, DataSummaryType>;
  /**
   * v1.4.34 IW-B — per-type freshness map from `/api/analytics`. The
   * tile-strip helper reads `lastSeenByType[type]?.daysAgo` and forwards
   * it to each `<TrendCard staleDays>` so a metric the user hasn't
   * logged in a while keeps its tile visible (with an explicit
   * "Letzter Wert vor …" caption) instead of disappearing.
   */
  lastSeenByType?: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  >;
}

interface RangeDisplayConfig {
  range: TrafficRange | null;
}

function getHourForTimeZone(timeZone?: string): number {
  const now = new Date();
  if (!timeZone) return now.getHours();

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone,
    }).formatToParts(now);
    const hourPart = parts.find((part) => part.type === "hour")?.value;
    const parsed = hourPart ? Number(hourPart) : Number.NaN;
    return Number.isNaN(parsed) ? now.getHours() : parsed;
  } catch {
    return now.getHours();
  }
}

function getRangeColorClass(
  value: number | null | undefined,
  config: RangeDisplayConfig,
): string | undefined {
  const range = config.range;
  if (value == null || !range) return undefined;
  const inGreen = value >= range.greenMin && value <= range.greenMax;
  const inOrange =
    !inGreen && value >= range.orangeMin && value <= range.orangeMax;

  if (inGreen) return "text-green-400";
  if (inOrange) return "text-orange-400";
  return "text-red-400";
}

function getRangeHint(
  unit: string,
  config: RangeDisplayConfig,
  t: (key: string) => string,
  formatNumber: (value: number, fractionDigits?: number) => string,
): React.ReactNode | undefined {
  const range = config.range;
  if (!range) return undefined;

  const format = (value: number) => formatNumber(value, 1);

  return (
    <>
      <p>
        <span className="font-bold text-green-400">
          {t("charts.colorGreen")}
        </span>{" "}
        {format(range.greenMin)}-{format(range.greenMax)} {unit}
      </p>
      <p>
        <span className="font-bold text-orange-400">
          {t("charts.colorOrange")}
        </span>{" "}
        {format(range.orangeMin)}-{format(range.greenMin)} {t("common.or")}{" "}
        {format(range.greenMax)}-{format(range.orangeMax)} {unit}
      </p>
      <p>
        <span className="font-bold text-red-400">{t("charts.colorRed")}</span>{" "}
        {"< "}
        {format(range.orangeMin)} {t("common.or")} {"> "}
        {format(range.orangeMax)} {unit}
      </p>
    </>
  );
}

export default function DashboardPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [quickEntryDialog, setQuickEntryDialog] = useState<
    "measurement" | "mood" | "medicationIntake" | null
  >(null);
  // v1.4.27 R4 RC2 — DOM handles for the form action-row portal target
  // on each quick-entry sheet. The Sheet branch sticky-pins this slot.
  const [measurementFooterEl, setMeasurementFooterEl] =
    useState<HTMLDivElement | null>(null);
  const [moodFooterEl, setMoodFooterEl] = useState<HTMLDivElement | null>(null);
  // v1.4.37 W7b — medication-intake quick-add lives on the same Sheet
  // primitive as the other two quick-entries; the form's action row is
  // portalled into this slot so Save / Cancel stay reachable above the
  // mobile soft keyboard.
  const [medicationIntakeFooterEl, setMedicationIntakeFooterEl] =
    useState<HTMLDivElement | null>(null);

  // v1.4.29 M5 — the three inline dashboard queries default to a
  // 0-ms `staleTime`, so a tab-focus-and-return triggered a refetch
  // storm. None of these are real-time data; minute-scale staleness
  // is fine and the dashboard's chart queries already match this
  // cadence.
  const DASHBOARD_QUERY_OPTS = {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  } as const;

  // v1.4.39.2 — split the dashboard's analytics consumption so the
  // tile-strip paints from the slim slice and the BD-Zielbereich +
  // glucose tiles stream in from the thick slice afterwards.
  //
  // Pre-fix: a single `useAnalyticsQuery()` against `/api/analytics`
  // (thick slice) blocked every per-type tile until the heavy fan-out
  // resolved. Mood and medication tiles paint from their own dedicated
  // endpoints and arrived first; the per-type measurement tiles then
  // arrived as one burst once the full slice landed — Marc reported
  // this "blocked-then-burst" pattern as "etwas nervig".
  //
  // Post-fix: two parallel queries. The slim slice (`?slice=summaries`)
  // resolves the per-type DataSummary headlines + `lastSeenByType` and
  // typically returns in well under a second once the rollup tier is
  // warm; that paints every per-type tile in the strip. The thick
  // slice resolves `bpInTargetPct*` + `glucoseByContext` for the
  // BD-Zielbereich and glucose tiles, which stream in independently.
  // Both queries share `caches.analytics` server-side so warm hits
  // stay free, and TanStack's parallel-mounting keeps the network fan-
  // out flat.
  const analyticsSlimQuery = useAnalyticsQuery({ slice: "summaries" });
  const analyticsThickQuery = useAnalyticsQuery();
  const data = useMemo<AnalyticsData | undefined>(() => {
    // v1.4.39.3 — the merge moved to `mergeSlimAndThickAnalytics` so
    // the empty-slim-vs-populated-thick edge has direct unit
    // coverage. Pre-fix the inline `slim?.summaries ?? thick?.summaries`
    // short-circuited on a truthy-but-empty `{}` from the slim slice
    // and blanked the tile strip even when thick carried the full
    // payload — the regression Marc's v1.4.39.3 e2e CI flagged across
    // eight dashboard / chart specs. The helper falls back to thick
    // when slim resolves with no content and otherwise keeps the
    // v1.4.39.2 slim-wins-first progressive-paint contract.
    const merged = mergeSlimAndThickAnalytics(
      analyticsSlimQuery.data,
      analyticsThickQuery.data,
    );
    if (!merged) return undefined;
    return {
      summaries: merged.summaries,
      lastSeenByType: merged.lastSeenByType,
      bpInTargetPct: merged.bpInTargetPct,
      bpInTargetPct7d: merged.bpInTargetPct7d,
      bpInTargetPct30d: merged.bpInTargetPct30d,
      bpInTargetPctAllTime: merged.bpInTargetPctAllTime,
      bpInTargetPctPriorMonth: merged.bpInTargetPctPriorMonth,
      bpInTargetPctPriorYear: merged.bpInTargetPctPriorYear,
      glucoseByContext: merged.glucoseByContext as
        | Record<string, DataSummaryType>
        | undefined,
    };
  }, [analyticsSlimQuery.data, analyticsThickQuery.data]);

  const { data: layoutData } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      const res = await fetch("/api/dashboard/widgets");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as DashboardLayout;
    },
    enabled: isAuthenticated,
    ...DASHBOARD_QUERY_OPTS,
  });

  const { data: moodData } = useQuery({
    queryKey: queryKeys.moodAnalytics(),
    queryFn: async () => {
      const res = await fetch("/api/mood/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        entries: Array<{ date: string; score: number; samples: number }>;
        summary: DataSummary;
      };
    },
    enabled: isAuthenticated,
    ...DASHBOARD_QUERY_OPTS,
  });

  // v1.4.27 B1 — the dashboard's `<InsightsCardPreview>` retired (it
  // duplicated the much-richer `/insights` advisor surface). The advisor
  // query lives on `/insights` directly; the dashboard no longer needs
  // its own hook subscription, so the local `useInsightsAdvisorQuery`
  // call dropped with the preview.

  // v1.4.27 — per-tile availability gates live a few lines below as the
  // existing `hasWeight` / `hasBp` / `hasPulse` / `hasBodyFat` / `hasMood` /
  // `hasSleep` / `hasSteps` flags. They mirror `hasMetricData` from
  // `src/lib/insights/metric-availability.ts` for the routed Insights
  // surfaces — both branches read `summaries[METRIC].count > 0`.

  const w = data?.summaries?.WEIGHT;
  const sys = data?.summaries?.BLOOD_PRESSURE_SYS;
  const dia = data?.summaries?.BLOOD_PRESSURE_DIA;
  const p = data?.summaries?.PULSE;
  const bf = data?.summaries?.BODY_FAT;
  const sleepSummary = data?.summaries?.SLEEP_DURATION;
  const stepsSummary = data?.summaries?.ACTIVITY_STEPS;
  // v1.4.25 W8d — VO2 max secondary-metric tile. /api/analytics
  // auto-populates this summary because the route iterates over the
  // full measurementTypeEnum.options list; no backend change needed.
  const vo2Summary = data?.summaries?.VO2_MAX;
  const moodSummary = moodData?.summary;

  // Resolve full dashboard layout — controls visibility + order of every widget
  const layout = resolveDashboardLayout(layoutData);
  /**
   * v1.4.16 phase B8 — comparison baseline (Vormonat / Vorjahr) read
   * from the resolved layout so every chart + tile on the dashboard
   * receives the same value. "none" = comparison off (pre-B8 default).
   */
  const compareBaseline = layout.comparisonBaseline ?? "none";

  /**
   * v1.4.16 phase B8 — derive the tile-delta value (current 30d avg
   * minus prior-period 30d avg) for any DataSummary. Returns null
   * when comparison is off OR either side is missing data so the
   * tile can suppress the callout cleanly.
   */
  const tileCompareDelta = (
    summary: DataSummary | null | undefined,
  ): number | null => {
    if (!summary || compareBaseline === "none") return null;
    const current = summary.avg30 ?? null;
    const prior =
      compareBaseline === "lastMonth"
        ? (summary.avg30LastMonth ?? null)
        : (summary.avg30LastYear ?? null);
    if (current === null || prior === null) return null;
    return Math.round((current - prior) * 100) / 100;
  };

  /**
   * v1.4.34 IW-B — read the per-type freshness map and surface the
   * `daysAgo` value when the metric is older than a week. The
   * tile-strip below forwards the result to `<TrendCard staleDays>`
   * which picks the bucket-aware copy (Xd / X weeks / X months) and
   * paints the caption on the tile. Returns `null` for metrics with no
   * reading yet OR within the fresh window so call sites stay
   * undefined-safe and tiles with recent data paint byte-identical
   * with the pre-v1.4.34 contract.
   */
  const tileStaleDays = (
    type: string | null | undefined,
  ): number | null => {
    if (!type) return null;
    const entry = data?.lastSeenByType?.[type];
    if (!entry) return null;
    return entry.daysAgo > 7 ? entry.daysAgo : null;
  };
  /** Whether the widget's *chart* (lower row) shows. */
  const isChartVisible = (id: string) =>
    layout.widgets.find((widget) => widget.id === id)?.visible ?? false;
  /**
   * v1.4.15 Fix 5 — whether the widget's *tile* in the strip shows.
   * Independent of the chart visibility so the user can hide chart but
   * keep the tile (or vice versa) from Settings → Dashboard. Falls back
   * to chart visibility for layouts saved before v1.4.15.
   */
  const isTileVisible = (id: string) => {
    const widget = layout.widgets.find((w) => w.id === id);
    if (!widget) return false;
    return typeof widget.tileVisible === "boolean"
      ? widget.tileVisible
      : widget.visible;
  };
  const widgetOrder = (id: string) =>
    layout.widgets.find((widget) => widget.id === id)?.order ?? 999;

  // Data-floor gates (widget shows iff visible AND has data)
  const hasWeight = (w?.count ?? 0) > 0;
  const hasBp = (sys?.count ?? 0) > 0 || (dia?.count ?? 0) > 0;
  const hasPulse = (p?.count ?? 0) > 0;
  const hasBodyFat = (bf?.count ?? 0) > 0;
  const hasMood = (moodSummary?.count ?? 0) > 0;
  const hasSleep = (sleepSummary?.count ?? 0) > 0;
  const hasSteps = (stepsSummary?.count ?? 0) > 0;
  const hasVo2 = (vo2Summary?.count ?? 0) > 0;
  /**
   * v1.4.33 F4 — gate the BD-Zielbereich tile so a literal "0,0 %"
   * placeholder doesn't ride on the dashboard when none of the user's
   * paired readings sit inside the target band. The historical
   * behaviour (`!= null`) painted the tile whenever the analytics
   * route emitted a numeric percentage, including the legitimate-but-
   * misleading zero. The corrected gate requires at least one window
   * (7d, 30d, all-time) to report a non-zero share. When every
   * window is zero, the tile is hidden — the user sees the BP charts
   * + the `/targets` Blutdruck card for the deeper analysis instead.
   * The audit's F4 reproduction sat on 540 BP samples with all sub-
   * windows reading 0 % because the seed data straddled the target
   * ceiling; the tile keeps its place once even one sub-window
   * crosses zero.
   */
  const hasBpInTarget =
    data?.bpInTargetPct != null &&
    [
      data?.bpInTargetPct,
      data?.bpInTargetPct7d,
      data?.bpInTargetPct30d,
      data?.bpInTargetPctAllTime,
    ].some((pct) => pct != null && pct > 0);

  // Tile (strip) gates — controlled by the new `tileVisible` flag.
  const showWeightTile = isTileVisible("weight") && hasWeight;
  const showBpTiles = isTileVisible("bp") && hasBp;
  const showPulseTile = isTileVisible("pulse") && hasPulse;
  const showBodyFatTile = isTileVisible("bodyFat") && hasBodyFat;
  const showMoodTile = isTileVisible("mood") && hasMood;
  const showSleepTile = isTileVisible("sleep") && hasSleep;
  const showStepsTile = isTileVisible("steps") && hasSteps;
  const showVo2Tile = isTileVisible("vo2Max") && hasVo2;
  const showBpInTargetTile = isTileVisible("bpInTarget") && hasBpInTarget;

  // Chart (lower row) gates — controlled by the legacy `visible` flag.
  const showWeightChart = isChartVisible("weight") && hasWeight;
  const showBpCharts = isChartVisible("bp") && hasBp;
  const showPulseChart = isChartVisible("pulse") && hasPulse;
  const showBodyFatChart = isChartVisible("bodyFat") && hasBodyFat;
  const showMoodChart = isChartVisible("mood") && hasMood;
  const showSleepChart = isChartVisible("sleep") && hasSleep;
  const showStepsChart = isChartVisible("steps") && hasSteps;
  const showMedicationsCard = isChartVisible("medications");
  // v1.4.15 phase-B4 — recent unlocks dashboard surface. The card itself
  // self-handles the empty state (CTA → /achievements), so we only need
  // the layout-toggle gate here. No data-floor check (the empty card is
  // intentional — the maintainer wants the user to discover the feature).
  const showAchievementsCard = isChartVisible("achievements");
  // v1.4.32 — recent workouts dashboard tile. Self-gates on the
  // workouts query response so we only need the layout toggle here;
  // the tile renders an Apple-Health-onboarding hint when empty.
  const showRecentWorkoutsTile = isChartVisible("recentWorkouts");

  // Glucose widget — visible iff layout enables it AND at least one reading exists.
  // Glucose has no separate chart slot today, so the tile flag is the
  // single source of truth for it.
  const glucoseWidgetVisible = isTileVisible("glucose");
  const displayGlucoseUnit = resolveGlucoseUnit(user?.glucoseUnit ?? null);
  const glucoseByContext = data?.glucoseByContext ?? {};
  const glucoseContexts = [
    "FASTING",
    "POSTPRANDIAL",
    "RANDOM",
    "BEDTIME",
  ] as const;
  const glucoseSummariesPresent = glucoseContexts.filter(
    (ctx) => (glucoseByContext[ctx]?.count ?? 0) > 0,
  );
  const showGlucoseCards =
    glucoseWidgetVisible && glucoseSummariesPresent.length > 0;
  const glucoseLabelKey: Record<string, string> = {
    FASTING: "targets.glucoseFasting",
    POSTPRANDIAL: "targets.glucosePostprandial",
    RANDOM: "targets.glucoseRandom",
    BEDTIME: "targets.glucoseBedtime",
  };
  const bpTargets =
    user?.dateOfBirth != null ? getBpTargets(new Date(user.dateOfBirth)) : null;
  const pulseAge = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const pulseTarget = getPersonalizedPulseTarget(
    pulseAge,
    (user?.gender as "MALE" | "FEMALE" | null | undefined) ?? null,
  );
  const bodyFatRange = getBodyFatTargetRange(user?.gender);
  const weightRange = user?.heightCm
    ? buildWeightRangeFromHeight(user.heightCm)
    : null;
  const weightBands = user?.heightCm
    ? buildWeightBandsFromHeight(user.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : undefined;
  const bpTargetZones = bpTargets
    ? [
        {
          min: bpTargets.sysLow,
          max: bpTargets.sysHigh,
          color: "#ff79c6",
          opacity: 0.21,
          label: t("charts.systolic"),
          textColor: "#ff79c6",
          lineOpacity: 0.24,
        },
        {
          min: bpTargets.diaLow,
          max: bpTargets.diaHigh,
          color: "#8be9fd",
          opacity: 0.21,
          label: t("charts.diastolic"),
          textColor: "#8be9fd",
          lineOpacity: 0.24,
        },
      ]
    : undefined;
  const bpSysRange = bpTargets
    ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh)
    : null;
  const bpDiaRange = bpTargets
    ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh)
    : null;
  const pulseDisplayRange = {
    greenMin: pulseTarget.greenMin,
    greenMax: pulseTarget.greenMax,
    orangeMin: pulseTarget.orangeMin,
    orangeMax: pulseTarget.orangeMax,
  };
  const pulseBands = [
    { min: 30, max: pulseTarget.orangeMin, color: "#ff5555", opacity: 0.16 },
    {
      min: pulseTarget.orangeMin,
      max: pulseTarget.greenMin,
      color: "#ffb86c",
      opacity: 0.18,
    },
    {
      min: pulseTarget.greenMin,
      max: pulseTarget.greenMax,
      color: "#50fa7b",
      opacity: 0.2,
    },
    {
      min: pulseTarget.greenMax,
      max: pulseTarget.orangeMax,
      color: "#ffb86c",
      opacity: 0.18,
    },
    { min: pulseTarget.orangeMax, max: 220, color: "#ff5555", opacity: 0.16 },
  ].filter((band) => band.max > band.min);
  const bodyFatBands = buildTrafficLightBands(
    bodyFatRange.min,
    bodyFatRange.max,
    {
      lowerBound: 2,
      upperBound: 55,
    },
  );
  const hour = user?.timezone ? getHourForTimeZone(user.timezone) : null;
  const timeGreeting =
    hour == null
      ? t("dashboard.greeting.day")
      : hour >= 5 && hour < 12
        ? t("dashboard.greeting.morning")
        : hour >= 12 && hour < 18
          ? t("dashboard.greeting.day")
          : t("dashboard.greeting.evening");
  const welcomeText =
    user?.username && user.username.trim().length > 0
      ? t("dashboard.welcomeBackWithName", {
          greeting: timeGreeting,
          name: user.username,
        })
      : t("dashboard.welcomeBack", { greeting: timeGreeting });

  return (
    <div className="space-y-6">
      {/* v1.4.37 W4a item 7 — centre-align the Hinzufügen button
          against the 2-line title block on mobile (< sm). The
          `welcomeText` line wraps under the title at < 380 px so the
          button used to float at the top of the row without a
          baseline anchor; `items-center sm:items-start` keeps the
          mobile vertical centre while preserving the original
          top-aligned posture on sm+ (where the title is one line). */}
      <div className="flex items-center justify-between gap-4 sm:items-start">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("dashboard.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">{welcomeText}</p>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* v1.4.33 maintainer-item-7 — restore proportional sizing
                  across viewports. The v1.4.27 fix pinned a `size="sm"
                  min-h-11` combo to hit WCAG 2.5.5's 44 px touch-target
                  contract on mobile, but `size="sm"` is h-8 (32 px) and
                  the `min-h-11` override stretched the cap vertically
                  while keeping the small horizontal padding — the
                  button read as klobig on Pixel 5. Switch to
                  `size="default"` (h-10 = 40 px) on mobile with a
                  responsive `min-h-11 sm:min-h-9` so the button is
                  44 px tall under finger pressure and shrinks back to
                  the desktop-friendly 36 px on `sm:` upwards. The icon
                  + label keep the same visual contract. */}
              <Button
                size="default"
                className="min-h-11 sm:min-h-9"
                data-tour-id="dashboard-quick-add"
              >
                <Plus className="mr-1 h-4 w-4" />
                {t("common.add")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-w-[calc(100vw-2rem)]"
            >
              {/* Menu items must each carry a self-contained verb-phrase
                  ("Log measurement", "Log mood") — the trigger above already
                  says "Add", and the icon is `aria-hidden`, so the visible
                  text is the only thing distinguishing the rows. v1.4.15
                  phase-A3 fix #1 hardened this with a unit guard at
                  `src/app/__tests__/quick-add-labels.test.ts` — both labels
                  must differ from each other AND from `common.add`. */}
              <DropdownMenuItem
                onClick={() => setQuickEntryDialog("measurement")}
              >
                <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("dashboard.quickAddMeasurement")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setQuickEntryDialog("mood")}>
                <Waves className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("dashboard.quickAddMood")}
              </DropdownMenuItem>
              {/* v1.4.37 W7b — third quick-add row: medication intake.
                  Same Sheet-on-mobile / Dialog-on-desktop primitive as
                  the other two; the menu label is a self-contained
                  verb-phrase so it doesn't collide with the trigger or
                  the sibling rows (cf. quick-add-labels.test.ts). */}
              <DropdownMenuItem
                onClick={() => setQuickEntryDialog("medicationIntake")}
              >
                <Pill className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("dashboard.quickAddMedicationIntake")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* v1.4: Getting-started checklist for brand-new users.
       * Self-gates visibility on (onboardingCompletedAt == null
       * || measurementCount < 5) and disappears once dismissed
       * or fully complete. See B2 in the v1.4 discovery summary. */}
      <GettingStartedChecklist />

      {/* v1.4.15 Phase B5 — spotlight tour for first-time users.
       * Self-gates on `user.onboardingTourCompleted` (DB flag) plus
       * a session-storage dismiss guard. We pass `ready=true` only
       * after analytics has resolved — the tour anchors to the tile
       * strip and we don't want the cutout snapping to a 0×0
       * placeholder before tiles render. The launcher mounts a no-op
       * `null` when the user has already seen the tour, so this
       * line is free for established users. */}
      <TourLauncher ready={data !== undefined} />

      {/* Quick Entry Sheets — bottom-sheet on `<md`, centred Dialog on `md+`. */}
      <ResponsiveSheet
        open={quickEntryDialog === "measurement"}
        onOpenChange={(open) => !open && setQuickEntryDialog(null)}
        title={t("measurements.addMeasurement")}
        footer={
          <div ref={setMeasurementFooterEl} className="flex w-full" />
        }
      >
        <MeasurementForm
          onSuccess={() => setQuickEntryDialog(null)}
          onCancel={() => setQuickEntryDialog(null)}
          footerSlot={measurementFooterEl}
        />
      </ResponsiveSheet>
      <ResponsiveSheet
        open={quickEntryDialog === "mood"}
        onOpenChange={(open) => !open && setQuickEntryDialog(null)}
        title={t("mood.addEntry")}
        footer={<div ref={setMoodFooterEl} className="flex w-full" />}
      >
        <MoodForm
          onSuccess={() => setQuickEntryDialog(null)}
          onCancel={() => setQuickEntryDialog(null)}
          footerSlot={moodFooterEl}
        />
      </ResponsiveSheet>
      {/* v1.4.37 W7b — third Sheet: medication intake. Same
          ResponsiveSheet contract as the two above; the form's footer
          (Cancel + Save) portals into the sticky-pinned slot so it
          stays reachable above the soft keyboard on mobile. */}
      <ResponsiveSheet
        open={quickEntryDialog === "medicationIntake"}
        onOpenChange={(open) => !open && setQuickEntryDialog(null)}
        title={t("dashboard.medicationIntakeQuickAdd.sheetTitle")}
        description={t("dashboard.medicationIntakeQuickAdd.sheetDescription")}
        footer={
          <div ref={setMedicationIntakeFooterEl} className="flex w-full" />
        }
      >
        <MedicationIntakeQuickAdd
          onSuccess={() => setQuickEntryDialog(null)}
          onCancel={() => setQuickEntryDialog(null)}
          footerSlot={medicationIntakeFooterEl}
        />
      </ResponsiveSheet>

      {(() => {
        type TrendEntry = { id: string; order: number; node: React.ReactNode };
        const trendCards: TrendEntry[] = [];

        if (showWeightTile) {
          trendCards.push({
            id: "weight",
            order: widgetOrder("weight"),
            node: (
              <TrendCard
                key="weight"
                label={t("dashboard.weightShort")}
                latest={w?.latest ?? null}
                unit="kg"
                avg7={w?.avg7 ?? null}
                avg30={w?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(w?.avg7, {
                  range: weightRange,
                })}
                avg30ColorClass={getRangeColorClass(w?.avg30, {
                  range: weightRange,
                })}
                avg7Hint={getRangeHint(
                  "kg",
                  { range: weightRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "kg",
                  { range: weightRange },
                  t,
                  fmt.number,
                )}
                slope30={w?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(w)}
                icon={Activity}
                directionSentiment="up-bad"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(w)}
                staleDays={tileStaleDays("WEIGHT")}
              />
            ),
          });
        }
        if (showBpTiles) {
          // BP is conceptually one signal but visually two tiles (sys + dia)
          // so the user sees both numbers side by side at the same size as
          // every other tile in the strip. v1.4.3 first attempted a
          // combined tile with `secondary` values — the maintainer preferred two
          // distinct tiles with consistent symmetric widths.
          trendCards.push({
            id: "bp-sys",
            order: widgetOrder("bp"),
            node: (
              <TrendCard
                key="bp-sys"
                label={t("dashboard.bloodPressureSysShort")}
                latest={sys?.latest ?? null}
                unit="mmHg"
                avg7={sys?.avg7 ?? null}
                avg30={sys?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(sys?.avg7, {
                  range: bpSysRange,
                })}
                avg30ColorClass={getRangeColorClass(sys?.avg30, {
                  range: bpSysRange,
                })}
                avg7Hint={getRangeHint(
                  "mmHg",
                  { range: bpSysRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "mmHg",
                  { range: bpSysRange },
                  t,
                  fmt.number,
                )}
                slope30={sys?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(sys)}
                icon={Heart}
                directionSentiment="up-bad"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(sys)}
                staleDays={tileStaleDays("BLOOD_PRESSURE_SYS")}
              />
            ),
          });
          trendCards.push({
            id: "bp-dia",
            // Sub-order keeps dia immediately after sys; the +0.001 leaves
            // headroom for any future BP-related tile slotted between them.
            order: widgetOrder("bp") + 0.001,
            node: (
              <TrendCard
                key="bp-dia"
                label={t("dashboard.bloodPressureDiaShort")}
                latest={dia?.latest ?? null}
                unit="mmHg"
                avg7={dia?.avg7 ?? null}
                avg30={dia?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(dia?.avg7, {
                  range: bpDiaRange,
                })}
                avg30ColorClass={getRangeColorClass(dia?.avg30, {
                  range: bpDiaRange,
                })}
                avg7Hint={getRangeHint(
                  "mmHg",
                  { range: bpDiaRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "mmHg",
                  { range: bpDiaRange },
                  t,
                  fmt.number,
                )}
                slope30={dia?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(dia)}
                icon={Heart}
                directionSentiment="up-bad"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(dia)}
                staleDays={tileStaleDays("BLOOD_PRESSURE_DIA")}
              />
            ),
          });
        }
        if (showPulseTile) {
          trendCards.push({
            id: "pulse",
            order: widgetOrder("pulse"),
            node: (
              <TrendCard
                key="pulse"
                label={t("dashboard.pulseShort")}
                latest={p?.latest ?? null}
                unit="bpm"
                avg7={p?.avg7 ?? null}
                avg30={p?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(p?.avg7, {
                  range: pulseDisplayRange,
                })}
                avg30ColorClass={getRangeColorClass(p?.avg30, {
                  range: pulseDisplayRange,
                })}
                avg7Hint={getRangeHint(
                  "bpm",
                  { range: pulseDisplayRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "bpm",
                  { range: pulseDisplayRange },
                  t,
                  fmt.number,
                )}
                slope30={p?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(p)}
                icon={TrendingUp}
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(p)}
                staleDays={tileStaleDays("PULSE")}
              />
            ),
          });
        }
        if (showBodyFatTile) {
          trendCards.push({
            id: "bodyFat",
            order: widgetOrder("bodyFat"),
            node: (
              <TrendCard
                key="bodyFat"
                label={t("dashboard.bodyFatShort")}
                latest={bf?.latest ?? null}
                unit="%"
                avg7={bf?.avg7 ?? null}
                avg30={bf?.avg30 ?? null}
                slope30={bf?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(bf)}
                icon={Percent}
                directionSentiment="up-bad"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(bf)}
                staleDays={tileStaleDays("BODY_FAT")}
              />
            ),
          });
        }
        if (showMoodTile) {
          trendCards.push({
            id: "mood",
            order: widgetOrder("mood"),
            node: (
              <TrendCard
                key="mood"
                label={t("dashboard.moodShort")}
                latest={moodSummary?.latest ?? null}
                unit="/ 5"
                avg7={moodSummary?.avg7 ?? null}
                avg30={moodSummary?.avg30 ?? null}
                slope30={moodSummary?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(moodSummary)}
                icon={Smile}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(moodSummary)}
              />
            ),
          });
        }
        if (showSleepTile) {
          trendCards.push({
            id: "sleep",
            order: widgetOrder("sleep"),
            node: (
              <TrendCard
                key="sleep"
                label={t("dashboard.sleepShort") ?? "Sleep"}
                latest={sleepSummary?.latest ?? null}
                unit="h"
                avg7={sleepSummary?.avg7 ?? null}
                avg30={sleepSummary?.avg30 ?? null}
                slope30={sleepSummary?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(sleepSummary)}
                icon={Moon}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(sleepSummary)}
                staleDays={tileStaleDays("SLEEP_DURATION")}
              />
            ),
          });
        }
        if (showStepsTile) {
          trendCards.push({
            id: "steps",
            order: widgetOrder("steps"),
            node: (
              <TrendCard
                key="steps"
                label={t("dashboard.stepsShort") ?? "Steps"}
                latest={stepsSummary?.latest ?? null}
                unit=""
                avg7={stepsSummary?.avg7 ?? null}
                avg30={stepsSummary?.avg30 ?? null}
                slope30={stepsSummary?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(stepsSummary)}
                icon={Footprints}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(stepsSummary)}
                staleDays={tileStaleDays("ACTIVITY_STEPS")}
              />
            ),
          });
        }
        // v1.4.25 W8d — VO2 max trend tile. Self-gates on the
        // `vo2Max` widget being enabled (Settings → Dashboard) AND
        // the analytics summary carrying at least one sample. Higher
        // VO2 max is better, so the directionSentiment is up-good and
        // an upward 30-day slope renders the green arrow. Unit
        // matches the canonical DB unit in
        // src/lib/validations/measurement.ts.
        if (showVo2Tile) {
          trendCards.push({
            id: "vo2Max",
            order: widgetOrder("vo2Max"),
            node: (
              <TrendCard
                key="vo2Max"
                label={t("dashboard.vo2MaxShort") ?? "VO₂ max"}
                latest={vo2Summary?.latest ?? null}
                unit={t("dashboard.vo2MaxUnit") ?? "mL/(kg·min)"}
                avg7={vo2Summary?.avg7 ?? null}
                avg30={vo2Summary?.avg30 ?? null}
                slope30={vo2Summary?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(vo2Summary)}
                icon={Gauge}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(vo2Summary)}
                staleDays={tileStaleDays("VO2_MAX")}
              />
            ),
          });
        }
        if (showBpInTargetTile) {
          /* v1.4.22 A2 — feature parity with every other tile.
             Synthesise a slope from the difference between the 7-day
             and 30-day in-target shares: when the recent week is
             above the recent month, the metric is improving (up-good
             ⇒ green arrow); when below, it's slipping. The
             trend7Delta is the same number as the arrow's underlying
             signal, surfaced as "(+5)" next to `7d:` so the tile
             matches the (weight / BP / pulse) call-site contract.
             Comparison overlay routes through the same global
             `compareBaseline` / `tileCompareDelta` pipeline as every
             other tile; we only have a single % series for the BP
             tile (no DataSummary) so the prior-period delta uses
             `bpInTargetPctAllTime` as the long-arc baseline — when
             comparison is off the field stays null. */
          // v1.4.28 FB-C1 + FB-C2 — rewrite the BD-Zielbereich tile
          // against the shared `<TrendCard>` primitive so it matches
          // the Weight / BP / Pulse sibling tiles exactly. The
          // synthetic `bpSlope30 = bpTrendDelta / 30` block produced a
          // small fractional float that the TrendCard's date-shaped
          // formatter pipeline rendered as "1.1." — the regression the
          // maintainer flagged in the post-v1.4.27 walk-through. The
          // all-time aggregate moves to the `/targets` BP card which
          // already shows the same number with more context; the
          // dashboard tile no longer needs to carry it. `avgAllTime`
          // also retires from the TrendCard API (this was its only
          // consumer).
          const bp7 = data?.bpInTargetPct7d ?? null;
          const bp30 = data?.bpInTargetPct30d ?? null;
          const bpPriorMonth = data?.bpInTargetPctPriorMonth ?? null;
          const bpPriorYear = data?.bpInTargetPctPriorYear ?? null;
          const bpTrendDelta =
            bp7 !== null && bp30 !== null ? bp7 - bp30 : null;
          const bpComparePrior =
            compareBaseline === "lastMonth"
              ? bpPriorMonth
              : compareBaseline === "lastYear"
                ? bpPriorYear
                : null;
          const bpCompareDelta =
            compareBaseline === "none" ||
            bp30 === null ||
            bpComparePrior === null
              ? null
              : Math.round((bp30 - bpComparePrior) * 10) / 10;
          trendCards.push({
            id: "bpInTarget",
            order: widgetOrder("bpInTarget"),
            node: (
              <TrendCard
                key="bpInTarget"
                label={t("dashboard.bpInTargetShort")}
                latest={data?.bpInTargetPct ?? null}
                unit="%"
                avg7={bp7}
                avg30={bp30}
                slope30={null}
                trend7Delta={bpTrendDelta}
                icon={Target}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={bpCompareDelta}
              />
            ),
          });
        }
        if (showGlucoseCards) {
          const glucoseOrder = widgetOrder("glucose");
          glucoseSummariesPresent.forEach((ctx, idx) => {
            const s = glucoseByContext[ctx];
            trendCards.push({
              id: `glucose-${ctx}`,
              // sub-order so all glucose cards stay in a block and order stable
              order: glucoseOrder + idx / 1000,
              node: (
                <TrendCard
                  key={`glucose-${ctx}`}
                  label={t(glucoseLabelKey[ctx])}
                  latest={
                    s.latest != null
                      ? convertGlucose(s.latest, displayGlucoseUnit)
                      : null
                  }
                  unit={displayGlucoseUnit}
                  avg7={
                    s.avg7 != null
                      ? convertGlucose(s.avg7, displayGlucoseUnit)
                      : null
                  }
                  avg30={
                    s.avg30 != null
                      ? convertGlucose(s.avg30, displayGlucoseUnit)
                      : null
                  }
                  slope30={s.slope30 ?? null}
                  icon={Droplet}
                  staleDays={tileStaleDays("BLOOD_GLUCOSE")}
                />
              ),
            });
          });
        }

        trendCards.sort((a, b) => a.order - b.order);

        type ChartEntry = {
          id: string;
          order: number;
          node: React.ReactNode;
          /**
           * Total raw readings for this metric. <5 surfaces a contextual
           * "First trend after 5 readings" hint underneath the chart;
           * undefined disables the hint (e.g. medications card).
           */
          count?: number;
        };
        const charts: ChartEntry[] = [];
        if (showWeightChart) {
          charts.push({
            id: "weight-chart",
            order: widgetOrder("weight"),
            count: w?.count ?? 0,
            node: (
              <HealthChartDynamic
                key="weight-chart"
                chartKey="weight"
                types={["WEIGHT"]}
                title={t("dashboard.weight")}
                colors={["#bd93f9"]}
                unit="kg"
                valueBands={weightBands}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
          if (user?.heightCm) {
            charts.push({
              id: "bmi-chart",
              order: widgetOrder("weight") + 0.5,
              node: (
                <HealthChartDynamic
                  key="bmi-chart"
                  chartKey="bmi"
                  types={["WEIGHT"]}
                  title={t("targets.bmi")}
                  colors={["#f1fa8c"]}
                  unit="kg/m²"
                  valueMode="bmi"
                  valueBands={[
                    { min: 0, max: 17, color: "#ff5555", opacity: 0.16 },
                    { min: 17, max: 18.5, color: "#ffb86c", opacity: 0.18 },
                    { min: 18.5, max: 24.9, color: "#50fa7b", opacity: 0.2 },
                    { min: 24.9, max: 29.9, color: "#ffb86c", opacity: 0.18 },
                    { min: 29.9, max: 120, color: "#ff5555", opacity: 0.16 },
                  ]}
                  compareBaseline={compareBaseline}
                />
              ),
            });
          }
        }
        if (showBpCharts) {
          charts.push({
            id: "bp-chart",
            order: widgetOrder("bp"),
            count: Math.max(sys?.count ?? 0, dia?.count ?? 0),
            node: (
              <HealthChartDynamic
                key="bp-chart"
                chartKey="bp"
                types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
                title={t("dashboard.bloodPressure")}
                colors={["#ff79c6", "#8be9fd"]}
                unit="mmHg"
                yAxisUnit="Hg"
                targetZones={bpTargetZones}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showPulseChart) {
          charts.push({
            id: "pulse-chart",
            order: widgetOrder("pulse"),
            count: p?.count ?? 0,
            node: (
              <HealthChartDynamic
                key="pulse-chart"
                chartKey="pulse"
                types={["PULSE"]}
                title={t("dashboard.pulse")}
                colors={["#50fa7b"]}
                unit="bpm"
                valueBands={pulseBands}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showBodyFatChart) {
          charts.push({
            id: "bodyFat-chart",
            order: widgetOrder("bodyFat"),
            count: bf?.count ?? 0,
            node: (
              <HealthChartDynamic
                key="bodyFat-chart"
                chartKey="bodyFat"
                types={["BODY_FAT"]}
                title={t("dashboard.bodyFat")}
                colors={["#ffb86c"]}
                unit="%"
                valueBands={bodyFatBands}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showMoodChart) {
          charts.push({
            id: "mood-chart",
            order: widgetOrder("mood"),
            count: moodSummary?.count ?? 0,
            node: (
              <MoodChart
                key="mood-chart"
                compareBaseline={compareBaseline}
                chartKey="mood"
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showSleepChart) {
          charts.push({
            id: "sleep-chart",
            order: widgetOrder("sleep"),
            count: sleepSummary?.count ?? 0,
            node: (
              <HealthChartDynamic
                key="sleep-chart"
                chartKey="sleep"
                types={["SLEEP_DURATION"]}
                title={t("dashboard.sleep") ?? "Sleep"}
                colors={["#8be9fd"]}
                unit="h"
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showStepsChart) {
          charts.push({
            id: "steps-chart",
            order: widgetOrder("steps"),
            count: stepsSummary?.count ?? 0,
            node: (
              <HealthChartDynamic
                key="steps-chart"
                chartKey="steps"
                types={["ACTIVITY_STEPS"]}
                title={t("dashboard.steps") ?? "Steps"}
                colors={["#50fa7b"]}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showMedicationsCard) {
          // v1.4.15 Fix 2: the toggle existed since v1.1 but the dashboard
          // slot only rendered a static placeholder (icon + title), so
          // flipping the layout switch on did nothing visible. Wire the
          // real chart that consumes
          // `/api/medications/intake?scope=compliance&days=N`.
          charts.push({
            id: "medications",
            order: widgetOrder("medications"),
            node: (
              <MedicationComplianceChart
                key="medications"
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showAchievementsCard) {
          // v1.4.15 phase-B4 — slotted at the user's chosen position via
          // the layout `order`. Default order from
          // `DEFAULT_DASHBOARD_LAYOUT` puts it last (below the chart row)
          // which matches the maintainer's brief "below the chart row".
          charts.push({
            id: "achievements",
            order: widgetOrder("achievements"),
            node: <RecentAchievementsCard key="achievements" />,
          });
        }
        if (showRecentWorkoutsTile) {
          // v1.4.32 — slotted via the same `order` mechanism. Self-gates
          // on the workouts query response inside the tile itself.
          charts.push({
            id: "recentWorkouts",
            order: widgetOrder("recentWorkouts"),
            node: <RecentWorkoutsTile key="recentWorkouts" />,
          });
        }

        charts.sort((a, b) => a.order - b.order);

        // v1.4.15 phase-C5: dashboard fully-empty state. When no tile
        // and no chart has data the dashboard would otherwise paint a
        // 0-px tile strip with the welcome banner above it — visually
        // looked like a half-broken page. Render an EmptyState that
        // re-uses the existing quick-entry dialog so the user has a
        // single click into "Log measurement" without leaving the page.
        // The GettingStartedChecklist above renders its own self-gated
        // surface for very-new accounts; this empty state covers the
        // case where the checklist has been dismissed but no data was
        // logged afterwards.
        if (trendCards.length === 0 && charts.length === 0) {
          return (
            <EmptyState
              icon={<Activity className="size-6" />}
              title={t("dashboard.emptyTitle")}
              description={t("dashboard.emptyDescription")}
              action={
                <Button
                  size="sm"
                  onClick={() => setQuickEntryDialog("measurement")}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  {t("dashboard.emptyAddMeasurement")}
                </Button>
              }
            />
          );
        }

        return (
          <>
            {/* v1.4: dashboard tiles are *always* a single row.
             * maintainer-explicit (per feedback_dashboard_one_row.md): a 2-row
             * tile strip breaks the visual hierarchy and reads like an
             * Excel grid. Total width caps at the parent container —
             * exactly the chart-width below. When the active tile count
             * exceeds what fits the viewport, the strip horizontal-scrolls
             * instead of wrapping; the user trims the set in
             * Settings → Dashboard (`/settings/dashboard`).
             * Each tile keeps a `min-w-[10rem]` so a single tile still
             * looks substantial on a wide screen, and `snap-x snap-mandatory`
             * makes the scroll feel deliberate rather than arbitrary on
             * touch.
             */}
            {/* v1.4.16 Fix A5: hide the strip entirely when the user
                turned off every tile. Until v1.4.15 the wrapper rendered
                an empty grid even with zero tiles — visually a thin gap
                the maintainer described as "awkward". Charts below still render so
                the page is not empty; the tile-strip just goes away.
                The constraint the maintainer named — "immer die gesamte Spalte
                breit und immer der gleichen Höhe" — is preserved by the
                CSS-grid `auto-fit + minmax + auto-rows-fr` track that
                continues to give every visible tile equal width / equal
                height for any non-zero count. */}
            {trendCards.length > 0 && (
              <div
                // v1.4.33 A3 Win 2 + F3 — collapse the bifurcated
                // mobile-flex / desktop-grid layout into one
                // responsive grid track. The v1.4.27 MB7 fix pinned a
                // `flex overflow-x-auto` row at `<sm` so tiles
                // scrolled horizontally rather than wrapping to 3-4
                // rows on a 280 px Galaxy Fold; the v1.4.33 audit
                // (Win 2) called the side-scroll an unwanted
                // regression for the Pixel 5 / iPhone-13-mini
                // viewports where two tiles per row fit naturally.
                // One grid track for every breakpoint:
                //
                //   `repeat(auto-fit, minmax(min(100%, 11rem), 1fr))`
                //
                // - Galaxy Fold (280 px) → 1 column, tiles stretch
                //   full width.
                // - Pixel 5 / iPhone-13-mini (375 px) → 2 columns,
                //   strip wraps to a second row when needed.
                // - 1440×900 desktop → 6 columns (1440 / 220 ≈ 6.5),
                //   widens the value column from the v1.4.27
                //   `9rem` floor so the headline number stops
                //   truncating to `8…` / `1.` (audit F3). 11 rem
                //   ≈ 176 px gives every tile ~220 px including
                //   gutter — comfortably wider than `text-3xl`
                //   digits plus the unit + arrow.
                // - 1920+ desktop → 8 columns, no horizontal slack.
                //
                // `auto-rows-fr` keeps the row height deterministic
                // so a 7-tile run still shares one baseline across
                // the wrap, regardless of which tile renders a
                // callout.
                className={cn(
                  "grid auto-rows-fr gap-3",
                  "[grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]",
                )}
                data-slot="dashboard-tile-strip"
                data-tour-id="dashboard-tile-strip"
                data-tile-count={trendCards.length}
              >
                {trendCards.map((entry) => (
                  <div key={entry.id} className="flex min-w-0">
                    {entry.node}
                  </div>
                ))}
              </div>
            )}
            {charts.map((entry) => (
              <div key={entry.id} className="space-y-2">
                {entry.node}
                {entry.count != null ? <TrendHint count={entry.count} /> : null}
              </div>
            ))}
          </>
        );
      })()}
    </div>
  );
}
