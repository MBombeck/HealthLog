"use client";

import { useMemo } from "react";

import {
  pickHrvSummary,
  resolveGlucoseTiles,
} from "@/components/dashboard/dashboard-gates";
import type { AuthUser } from "@/hooks/use-auth";
import {
  useUnitDisplayOnceMounted,
  type UnitDisplay,
} from "@/hooks/use-unit-display";
import { resolveWeightTargetOverride } from "@/lib/analytics/effective-range";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  buildDashboardBands,
  viewerBandProfile,
  type DashboardTargetBands,
} from "@/lib/dashboard/bands";
import type { DashboardLayout } from "@/lib/dashboard-layout";
import { resolveGlucoseUnit } from "@/lib/glucose";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { TrendDirectionSentiment } from "@/lib/insights/trend-sentiment";
import { toProfileSex } from "@/lib/profile/sex";
import {
  resolveWeightTrend,
  weightTrendReferenceKg,
} from "@/lib/targets/weight-trend";

import type { DashboardData } from "./use-dashboard-data";

/**
 * The resolved bands in the shape the tiles and charts draw them: weight in
 * the display unit, blood pressure as the chart's two target zones.
 */
function bandsForDisplay(
  bands: DashboardTargetBands,
  unitDisplay: UnitDisplay,
  t: (key: string) => string,
) {
  const weightRange = bands.weightRange;
  // The range hint prints its bounds in the display unit, so the kg
  // thresholds scale by the weight factor (offset-free). The colour classing
  // stays canonical: it compares a canonical average against the canonical
  // range.
  const weightHintRange = weightRange
    ? {
        greenMin: unitDisplay.toDisplay("WEIGHT", weightRange.greenMin),
        greenMax: unitDisplay.toDisplay("WEIGHT", weightRange.greenMax),
        orangeMin: unitDisplay.toDisplay("WEIGHT", weightRange.orangeMin),
        orangeMax: unitDisplay.toDisplay("WEIGHT", weightRange.orangeMax),
      }
    : weightRange;
  const weightBands = bands.weightBands ?? undefined;
  // The kg chart bands scaled into the display unit so the shaded zone
  // tracks the converted line (factor only; weight has no offset).
  const weightDisplayBands =
    weightBands && unitDisplay.preference === "imperial"
      ? weightBands.map((band) => ({
          ...band,
          min: unitDisplay.toDisplay("WEIGHT", band.min),
          max: unitDisplay.toDisplay("WEIGHT", band.max),
        }))
      : weightBands;
  const bpTargets = bands.bpTargets;
  const bpTargetZones = bpTargets
    ? [
        {
          min: bpTargets.sysLow,
          max: bpTargets.sysHigh,
          color: "var(--chart-3)",
          opacity: 0.21,
          label: t("charts.systolic"),
          textColor: "var(--chart-3)",
          lineOpacity: 0.24,
        },
        {
          min: bpTargets.diaLow,
          max: bpTargets.diaHigh,
          color: "var(--chart-4)",
          opacity: 0.21,
          label: t("charts.diastolic"),
          textColor: "var(--chart-4)",
          lineOpacity: 0.24,
        },
      ]
    : undefined;

  return {
    weightRange,
    weightHintRange,
    weightDisplayBands,
    bpTargetZones,
    bpSysRange: bands.bpSysRange,
    bpDiaRange: bands.bpDiaRange,
    pulseDisplayRange: bands.pulseDisplayRange,
    pulseBands: bands.pulseBands,
    bodyFatBands: bands.bodyFatBands,
  };
}

/**
 * What every dashboard tile reads: the summaries, the resolved layout, the
 * display units and the target bands, each derived once per render here so a
 * tile definition stays a function of this object and nothing else.
 */
export function useDashboardTileContext({
  dashboard,
  user,
}: {
  dashboard: DashboardData;
  user: AuthUser | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // Metric / imperial display choke point. `td` converts an ABSOLUTE
  // reading (affine, so a temperature picks up the °F offset); `tdd`
  // converts a DELTA or slope (factor only, so a Δ never inherits the
  // offset). Metric users take the identity path.
  const unitDisplay = useUnitDisplayOnceMounted();
  const td = (type: string, value: number | null | undefined): number | null =>
    value == null ? null : unitDisplay.toDisplay(type, value);
  const tdd = (
    type: string,
    value: number | null | undefined,
  ): number | null =>
    value == null ? null : unitDisplay.toDisplayDelta(type, value);

  const { data, layout, layoutData, moodData, snapshot, snapshotEnabled } =
    dashboard;
  const summaries = data?.summaries;
  const compareBaseline = layout.comparisonBaseline ?? "none";

  /**
   * The tile delta (current 30-day average minus the prior period's) for a
   * summary. Null when comparison is off or either side is missing, so the
   * tile suppresses the callout.
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
   * Days since the metric's last reading when that is more than a week, for
   * `<TrendCard staleDays>`; null for a fresh metric or one with no reading.
   */
  const tileStaleDays = (type: string | null | undefined): number | null => {
    if (!type) return null;
    const entry = data?.lastSeenByType?.[type];
    if (!entry) return null;
    return entry.daysAgo > 7 ? entry.daysAgo : null;
  };
  /** Whether the widget's chart (lower row) shows. */
  const isChartVisible = (id: string) =>
    layout.widgets.find((widget) => widget.id === id)?.visible ?? false;
  /**
   * Whether the widget's tile in the strip shows. Independent of the chart,
   * falling back to the chart flag for layouts saved before the two split.
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

  // `layoutData` is undefined until the real layout (snapshot or legacy
  // widgets) resolves, and the fallback layout shows cards a person may have
  // switched off. Cards gated on the layout alone wait for the real one.
  const layoutResolved = layoutData != null;

  // Band and target numbers come resolved from the snapshot (`targetBands`).
  // The client copy below is computed from the profile through the SAME
  // `buildDashboardBands` the server uses, so a still-loading snapshot frame
  // keeps real bands rather than blank charts and the two cannot disagree.
  // The profile it reads is the caller's, and under a switch the caller is
  // the delegate: `viewerBandProfile` then draws no client band at all and
  // waits for the snapshot's, which resolve against the record. Keyed on the
  // `user` identity so the React Compiler can preserve the memo.
  const inSharedRecord = user?.accountAccess?.active != null;
  const thresholdsData = dashboard.thresholdsData;
  const clientBandProfile = useMemo(
    () =>
      viewerBandProfile(
        {
          dateOfBirth: user?.dateOfBirth ? new Date(user.dateOfBirth) : null,
          gender: toProfileSex(user?.gender),
          heightCm: user?.heightCm ?? null,
          thresholdsJson: thresholdsData?.overrides ?? null,
        },
        inSharedRecord,
      ),
    [user, thresholdsData, inSharedRecord],
  );
  const clientBands = useMemo(
    () => buildDashboardBands(clientBandProfile),
    [clientBandProfile],
  );
  const serverBands = snapshotEnabled ? snapshot?.targetBands : undefined;
  const bands = serverBands ?? clientBands;

  // Which way a weight change counts as progress against the stored target.
  // The snapshot carries the server's answer; the fallback asks the same
  // resolver from the same profile the band fallback reads.
  const weight = summaries?.WEIGHT;
  const weightTrend =
    (snapshotEnabled ? snapshot?.tiles.weightTrend : undefined) ??
    resolveWeightTrend(
      resolveWeightTargetOverride(clientBandProfile.thresholdsJson),
      weightTrendReferenceKg(weight),
    );
  // Every other tile's direction comes resolved from the server against the
  // record's own targets. The snapshot-disabled path has no resolved answer
  // and renders neutral rather than guessing a polarity.
  const tileDirections = snapshotEnabled
    ? snapshot?.tiles.directions
    : undefined;
  const directionOf = (key: string): TrendDirectionSentiment =>
    tileDirections?.[key]?.direction ?? "neutral";

  // Glucose has no chart slot; the tile flag is its single source of truth.
  // Eligibility walks the untagged bucket beside the four named contexts, so
  // an account whose source never writes a meal-time tag still sees a tile.
  const displayGlucoseUnit = resolveGlucoseUnit(user?.glucoseUnit ?? null);
  const glucoseTiles = resolveGlucoseTiles(data?.glucoseByContext ?? {});

  return {
    t,
    fmt,
    unitDisplay: unitDisplay as UnitDisplay,
    td,
    tdd,
    user,
    data,
    summaries,
    moodSummary: moodData?.summary,
    hrv: pickHrvSummary(summaries),
    layout: layout as DashboardLayout,
    layoutResolved,
    compareBaseline,
    tileCompareDelta,
    tileStaleDays,
    isChartVisible,
    isTileVisible,
    widgetOrder,
    directionOf,
    weightTrend,
    ...bandsForDisplay(bands, unitDisplay, t),
    displayGlucoseUnit,
    glucoseTiles,
  };
}

export type DashboardTileContext = ReturnType<typeof useDashboardTileContext>;
