"use client";

import type { ComponentProps, ReactNode } from "react";
import dynamic from "next/dynamic";

import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { RecentWorkoutsTile } from "@/components/dashboard/recent-workouts-tile";
import { RecentAchievementsCard } from "@/components/gamification/recent-achievements-card";
import { VorsorgeDashboardCard } from "@/components/measurement-reminders/vorsorge-dashboard-card";
import { BATCH_COVERAGE_DAYS } from "@/lib/dashboard/batch-chart-types";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import { importWithRetry } from "@/lib/retry-import";

import type { DashboardTileContext } from "./tile-context";
import type { BatchedSeriesRow } from "./use-dashboard-data";

// The loaders retry a rejected chunk import once (a lazy import caches its
// rejection for good, so a transient 404 from a stale shell would brick the
// card for the session), and each mount sits in a `<ChartErrorBoundary>` so a
// chunk that still fails degrades to one error card instead of the route's
// `error.tsx`.
const MoodChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.MoodChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const MoodChart = (props: ComponentProps<typeof MoodChartLazy>) => (
  <ChartErrorBoundary>
    <MoodChartLazy {...props} />
  </ChartErrorBoundary>
);
const MedicationComplianceChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.MedicationComplianceChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const MedicationComplianceChart = (
  props: ComponentProps<typeof MedicationComplianceChartLazy>,
) => (
  <ChartErrorBoundary>
    <MedicationComplianceChartLazy {...props} />
  </ChartErrorBoundary>
);

// Warm the shared `chart-runtime` chunk during hydration. The charts mount
// through `ssr: false` dynamics, which start their import only at mount;
// firing it at module evaluation lets the download overlap hydration. The
// dynamics resolve through the same `importWithRetry` promise.
if (typeof window !== "undefined") {
  void importWithRetry(() => import("@/components/charts/chart-runtime"));
}

/** What a chart card needs beyond the tile context. */
export interface ChartTileContext extends DashboardTileContext {
  preloadedSeries: Record<string, BatchedSeriesRow[]> | undefined;
  markChartReady: (id: string) => void;
}

/** One card in the chart row, positioned by `order`. */
export interface ChartEntry {
  id: string;
  order: number;
  node: ReactNode;
  /**
   * Total raw readings for the metric. Under five, a "first trend after 5
   * readings" hint sits under the chart; undefined disables the hint.
   */
  count?: number;
  /**
   * The cell holds its skeleton until every gated chart's data settled (or
   * the reveal timeout fired). Data-backed charts set this; the cards that
   * skeleton themselves do not.
   */
  revealGated?: boolean;
}

/**
 * A chart-row card: the layout widget that switches and orders it, the card's
 * own rule (a data floor, a module, a resolved layout), and the card itself.
 * Unlike the strip, the chart row reads the widget's chart flag (`visible`),
 * which `buildChartEntries` applies for every card.
 */
interface ChartTile {
  id: string;
  widget: string;
  orderOffset?: number;
  revealGated?: boolean;
  visible: (ctx: DashboardTileContext) => boolean;
  count?: (ctx: DashboardTileContext) => number;
  render: (ctx: ChartTileContext) => ReactNode;
}

const countOf = (summary: { count?: number } | null | undefined) =>
  summary?.count ?? 0;

const BMI_BANDS = [
  { min: 0, max: 17, color: "var(--destructive)", opacity: 0.16 },
  { min: 17, max: 18.5, color: "var(--warning)", opacity: 0.18 },
  { min: 18.5, max: 24.9, color: "var(--success)", opacity: 0.2 },
  { min: 24.9, max: 29.9, color: "var(--warning)", opacity: 0.18 },
  { min: 29.9, max: 120, color: "var(--destructive)", opacity: 0.16 },
];

const hasRestingHr = (ctx: DashboardTileContext) =>
  countOf(ctx.summaries?.RESTING_HEART_RATE) > 0;

/**
 * A measurement chart card with the props every dashboard chart shares: its
 * reveal report, the comparison baseline, day doors and, unless the card
 * says otherwise, the batched series slice and the profile time zone.
 */
function metricChart(
  ctx: ChartTileContext,
  id: string,
  props: Omit<
    ComponentProps<typeof HealthChartDynamic>,
    "onDataReady" | "compareBaseline" | "dayLinks"
  >,
  { batched = true, timezone = true } = {},
): ReactNode {
  return (
    <HealthChartDynamic
      key={id}
      onDataReady={() => ctx.markChartReady(id)}
      {...(batched
        ? {
            preloadedSeries: ctx.preloadedSeries,
            preloadedCoverageDays: BATCH_COVERAGE_DAYS,
          }
        : {})}
      compareBaseline={ctx.compareBaseline}
      {...(timezone ? { userTimezone: ctx.user?.timezone } : {})}
      dayLinks
      {...props}
    />
  );
}

/** Every chart-row card, in the order the cards are collected. */
export const CHART_TILES: readonly ChartTile[] = [
  {
    id: "weight-chart",
    widget: "weight",
    revealGated: true,
    visible: (ctx) => countOf(ctx.summaries?.WEIGHT) > 0,
    count: (ctx) => ctx.summaries?.WEIGHT?.count ?? 0,
    render: (ctx) =>
      metricChart(ctx, "weight-chart", {
        chartKey: "weight",
        types: ["WEIGHT"],
        title: ctx.t("dashboard.weight"),
        colors: ["var(--chart-1)"],
        unit: ctx.unitDisplay.unitFor("WEIGHT"),
        valueBands: ctx.weightDisplayBands,
        valueScale: ctx.unitDisplay.transformFor("WEIGHT").factor,
      }),
  },
  {
    // BMI rides the weight widget, right behind its chart, and only for a
    // profile that carries a height.
    id: "bmi-chart",
    widget: "weight",
    orderOffset: 0.5,
    revealGated: true,
    visible: (ctx) =>
      countOf(ctx.summaries?.WEIGHT) > 0 && Boolean(ctx.user?.heightCm),
    render: (ctx) =>
      metricChart(
        ctx,
        "bmi-chart",
        {
          chartKey: "bmi",
          types: ["WEIGHT"],
          title: ctx.t("targets.bmi"),
          colors: ["var(--dracula-yellow)"],
          unit: "kg/m²",
          valueMode: "bmi",
          valueBands: BMI_BANDS,
        },
        { timezone: false },
      ),
  },
  {
    id: "bp-chart",
    widget: "bp",
    revealGated: true,
    visible: (ctx) =>
      countOf(ctx.summaries?.BLOOD_PRESSURE_SYS) > 0 ||
      countOf(ctx.summaries?.BLOOD_PRESSURE_DIA) > 0,
    count: (ctx) =>
      Math.max(
        ctx.summaries?.BLOOD_PRESSURE_SYS?.count ?? 0,
        ctx.summaries?.BLOOD_PRESSURE_DIA?.count ?? 0,
      ),
    render: (ctx) =>
      metricChart(ctx, "bp-chart", {
        chartKey: "bp",
        types: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
        title: ctx.t("dashboard.bloodPressure"),
        colors: ["var(--chart-3)", "var(--chart-4)"],
        unit: "mmHg",
        targetZones: ctx.bpTargetZones,
      }),
  },
  {
    // The resting series against the resting band when there is one;
    // otherwise raw heart rate WITHOUT the band, which would mark expected
    // workout heart rate as outside target.
    id: "pulse-chart",
    widget: "pulse",
    revealGated: true,
    visible: (ctx) =>
      countOf(ctx.summaries?.PULSE) > 0 ||
      countOf(ctx.summaries?.RESTING_HEART_RATE) > 0,
    count: (ctx) => ctx.summaries?.PULSE?.count ?? 0,
    render: (ctx) =>
      metricChart(ctx, "pulse-chart", {
        chartKey: "pulse",
        types: hasRestingHr(ctx) ? ["RESTING_HEART_RATE"] : ["PULSE"],
        title: hasRestingHr(ctx)
          ? ctx.t(MEASUREMENT_TYPE_LABEL_KEYS.RESTING_HEART_RATE)
          : ctx.t("dashboard.pulse"),
        colors: ["var(--success)"],
        unit: "bpm",
        valueBands: hasRestingHr(ctx) ? ctx.pulseBands : undefined,
      }),
  },
  {
    id: "bodyFat-chart",
    widget: "bodyFat",
    revealGated: true,
    visible: (ctx) => countOf(ctx.summaries?.BODY_FAT) > 0,
    count: (ctx) => ctx.summaries?.BODY_FAT?.count ?? 0,
    render: (ctx) =>
      metricChart(ctx, "bodyFat-chart", {
        chartKey: "bodyFat",
        types: ["BODY_FAT"],
        title: ctx.t("dashboard.bodyFat"),
        colors: ["var(--warning)"],
        unit: "%",
        valueBands: ctx.bodyFatBands,
      }),
  },
  {
    id: "mood-chart",
    widget: "mood",
    revealGated: true,
    visible: (ctx) => countOf(ctx.moodSummary) > 0,
    count: (ctx) => ctx.moodSummary?.count ?? 0,
    render: (ctx) => (
      <MoodChart
        key="mood-chart"
        onDataReady={() => ctx.markChartReady("mood-chart")}
        compareBaseline={ctx.compareBaseline}
        chartKey="mood"
        dayLinks
      />
    ),
  },
  {
    // Sleep is never batched: it reads its own per-night series.
    id: "sleep-chart",
    widget: "sleep",
    revealGated: true,
    visible: (ctx) => countOf(ctx.summaries?.SLEEP_DURATION) > 0,
    count: (ctx) => ctx.summaries?.SLEEP_DURATION?.count ?? 0,
    render: (ctx) =>
      metricChart(
        ctx,
        "sleep-chart",
        {
          chartKey: "sleep",
          types: ["SLEEP_DURATION"],
          title: ctx.t("dashboard.sleep") ?? "Sleep",
          colors: ["var(--chart-4)"],
          unit: "h",
        },
        { batched: false },
      ),
  },
  {
    id: "steps-chart",
    widget: "steps",
    revealGated: true,
    visible: (ctx) => countOf(ctx.summaries?.ACTIVITY_STEPS) > 0,
    count: (ctx) => ctx.summaries?.ACTIVITY_STEPS?.count ?? 0,
    render: (ctx) =>
      metricChart(ctx, "steps-chart", {
        chartKey: "steps",
        types: ["ACTIVITY_STEPS"],
        title: ctx.t("dashboard.steps") ?? "Steps",
        colors: ["var(--success)"],
      }),
  },
  {
    // Adherence over `/api/medications/intake?scope=compliance&days=N`.
    id: "medications",
    widget: "medications",
    revealGated: true,
    visible: () => true,
    render: (ctx) => (
      <MedicationComplianceChart
        key="medications"
        onDataReady={() => ctx.markChartReady("medications")}
        compareBaseline={ctx.compareBaseline}
        userTimezone={ctx.user?.timezone}
        dayLinks
      />
    ),
  },
  {
    // The preventive-care summary: fetches its own list and skeletons itself,
    // so it stays out of the reveal gate.
    id: "vorsorge",
    widget: "vorsorge",
    visible: () => true,
    render: () => <VorsorgeDashboardCard key="vorsorge" />,
  },
  {
    // No data floor (the empty card is how the feature is discovered), so it
    // waits for the real layout: on the fallback layout it would flash in and
    // retract for a person who switched it off.
    id: "achievements",
    widget: "achievements",
    visible: (ctx) => ctx.layoutResolved,
    render: () => <RecentAchievementsCard key="achievements" />,
  },
  {
    // Same layout wait as the achievements card; the tile gates on its own
    // query and shows the Apple Health hint when empty.
    id: "recentWorkouts",
    widget: "recentWorkouts",
    visible: (ctx) =>
      ctx.layoutResolved && ctx.user?.modules?.workouts !== false,
    render: () => <RecentWorkoutsTile key="recentWorkouts" />,
  },
];

/** The chart-row cards whose widget chart flag is on and whose rule passes. */
export function visibleChartTiles(
  ctx: DashboardTileContext,
): readonly ChartTile[] {
  return CHART_TILES.filter(
    (tile) => ctx.isChartVisible(tile.widget) && tile.visible(ctx),
  );
}

/** The ids the shared chart reveal waits for, in card order. */
export function revealChartIds(tiles: readonly ChartTile[]): string[] {
  return tiles.filter((tile) => tile.revealGated).map((tile) => tile.id);
}

/** The chart row for this render, sorted by layout order. */
export function buildChartEntries(
  tiles: readonly ChartTile[],
  ctx: ChartTileContext,
): ChartEntry[] {
  const entries: ChartEntry[] = tiles.map((tile) => ({
    id: tile.id,
    order: ctx.widgetOrder(tile.widget) + (tile.orderOffset ?? 0),
    ...(tile.count ? { count: tile.count(ctx) } : {}),
    ...(tile.revealGated ? { revealGated: true } : {}),
    node: tile.render(ctx),
  }));
  entries.sort((a, b) => a.order - b.order);
  return entries;
}
