"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import {
  useDisplayTimezone,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { dateOnlyKey, isNoonUtcAnchor } from "@/lib/tz/date-only";

import { RichChartTooltip, type RichTooltipRow } from "../charts/chart-tooltip";
import { TooltipDayAction, useCoarsePointer } from "../day/chart-day";
import { openDay, useOpenDay } from "../day/day-layer-controller";
import { dateKeyOfInstant } from "../day/day-url";
import type { LabResultDto } from "./types";
import { useLabNumber } from "./use-lab-format";

/**
 * v1.18.1 — per-biomarker trend chart, in the dashboard's visual language.
 *
 * Replaces the hand-rolled 72×20 SVG sparkline with a proper Recharts
 * `ComposedChart`: a single line over time, the catalog reference window
 * painted as a shaded `ReferenceArea` band with dashed bound lines, range
 * tabs (30 / 90 / 365 / all), and the shared rich tooltip. The band uses a
 * MUTED primary fill — never a danger colour — honouring the no-alarming-
 * colour rule. Every reading carries the same y-axis unit because a chart is
 * one biomarker only.
 *
 * A SECOND band draws the window a source report printed, when the readings in
 * view carry one. It is visually distinct from the catalog band — an outlined
 * band in the chart's secondary hue against the catalog's filled primary — and
 * both stay muted; the in/out verdict is the badge's job, never the chart's
 * colour. The source window is a per-reading fact, so the band is drawn from
 * the NEWEST reading in view that carries one and the legend dates it. When
 * the readings in view carry more than one distinct printed window the legend
 * says so rather than implying one window covered the whole series.
 */

const RANGE_DAYS = [
  { key: "30", days: 30 },
  { key: "90", days: 90 },
  { key: "365", days: 365 },
  { key: "all", days: 0 },
] as const;

type RangeKey = (typeof RANGE_DAYS)[number]["key"];

interface ChartPoint {
  /** The reading's id, to find the one before it for the day's focus. */
  id: string;
  timestamp: number;
  value: number;
  /** The window this reading was judged against, for the tooltip. */
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceOrigin: LabResultDto["referenceOrigin"];
  sourceReferenceText: string | null;
}

/** The source window drawn as the second band, resolved from the readings in view. */
interface SourceBand {
  low: number | null;
  high: number | null;
  /** The reading the band was taken from. */
  takenAt: number;
  /** True when the readings in view printed more than one distinct window. */
  mixed: boolean;
}

/** Identity of a printed window, for counting distinct ones. */
function bandKey(low: number | null, high: number | null): string {
  return `${low ?? ""}|${high ?? ""}`;
}

export function LabBiomarkerChart({
  readings,
  unit,
  lowerBound,
  upperBound,
}: {
  /** Readings for this biomarker, any order (sorted internally). */
  readings: LabResultDto[];
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
}) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  const fmt = useFormatters();
  // A reading from a report that states only its date is stored at noon UTC
  // and is dated by that calendar date; one typed with its time of day is
  // dated in the reader's zone (the rule `useLabDate` applies to the lists).
  const labShortDate = (value: number | string) => {
    const instant = new Date(value);
    return isNoonUtcAnchor(instant)
      ? fmt.dateShortSmartCalendar(instant)
      : fmt.dateShortSmart(instant);
  };
  const [range, setRange] = useState<RangeKey>("365");
  // v1.42 — a reading opens its day: a click on a fine pointer, the
  // tooltip's button on a touch screen. The open day's reading is ringed.
  const timeZone = useDisplayTimezone();
  const coarse = useCoarsePointer();
  const openDayKey = useOpenDay();
  const dayOf = (timestamp: number) => {
    const instant = new Date(timestamp);
    return isNoonUtcAnchor(instant)
      ? dateOnlyKey(instant)
      : dateKeyOfInstant(instant, timeZone);
  };
  const openReadingDay = (point: ChartPoint | undefined) => {
    if (!point) return;
    const ordered = [...readings]
      .filter((r) => r.value !== null)
      .sort(
        (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
      );
    const at = ordered.findIndex((r) => r.id === point.id);
    const before = at > 0 ? ordered[at - 1] : undefined;
    const date = dayOf(point.timestamp);
    openDay(date, {
      focus: {
        date,
        label: readings[0]?.analyte ?? "",
        value: labNumber(point.value),
        unit,
        compare:
          before && before.value !== null
            ? {
                label: t("day.previousReading", {
                  date: labShortDate(before.takenAt),
                }),
                value: `${labNumber(before.value)} ${unit}`.trim(),
              }
            : undefined,
      },
    });
  };
  // Capture "now" once at mount so the recency filter stays pure across
  // re-renders (an inline `Date.now()` in render is impure).
  const [nowMs] = useState(() => Date.now());

  const points = useMemo<ChartPoint[]>(() => {
    // v1.18.9 — qualitative readings (numeric value null) have nothing to plot;
    // drop them so the line never renders a NaN / zero point. A series of only
    // qualitative readings yields no points → the honest empty state below.
    const sorted = [...readings]
      .filter((r): r is LabResultDto & { value: number } => r.value !== null)
      .sort(
        (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
      );
    const days = RANGE_DAYS.find((r) => r.key === range)?.days ?? 0;
    const filtered =
      days > 0
        ? sorted.filter((r) => {
            const ageMs = nowMs - new Date(r.takenAt).getTime();
            return ageMs <= days * 24 * 60 * 60 * 1000;
          })
        : sorted;
    return filtered.map((r) => ({
      id: r.id,
      timestamp: new Date(r.takenAt).getTime(),
      value: r.value,
      referenceLow: r.referenceLow,
      referenceHigh: r.referenceHigh,
      referenceOrigin: r.referenceOrigin,
      sourceReferenceText: r.sourceReferenceText,
    }));
  }, [readings, range, nowMs]);

  // The source band: the newest in-view reading whose report printed a window
  // with usable bounds. Readings without one contribute nothing — an absent
  // window is absent, not a reason to widen or narrow the band.
  const sourceBand = useMemo<SourceBand | null>(() => {
    const withWindow = points.filter(
      (p) =>
        p.referenceOrigin === "source" &&
        (p.referenceLow !== null || p.referenceHigh !== null),
    );
    if (withWindow.length === 0) return null;
    const newest = withWindow.reduce((a, b) =>
      b.timestamp > a.timestamp ? b : a,
    );
    const distinct = new Set(
      withWindow.map((p) => bandKey(p.referenceLow, p.referenceHigh)),
    );
    return {
      low: newest.referenceLow,
      high: newest.referenceHigh,
      takenAt: newest.timestamp,
      mixed: distinct.size > 1,
    };
  }, [points]);

  // Y domain wraps both the data and the reference window so the band is
  // always visible even when every reading sits inside it.
  const yDomain = useMemo<[number, number]>(() => {
    const values = points.map((p) => p.value);
    const candidates = [...values];
    if (lowerBound != null) candidates.push(lowerBound);
    if (upperBound != null) candidates.push(upperBound);
    // The source band has to fit too, or the second band is drawn off-canvas
    // and the chart silently shows one window while claiming two.
    if (sourceBand?.low != null) candidates.push(sourceBand.low);
    if (sourceBand?.high != null) candidates.push(sourceBand.high);
    if (candidates.length === 0) return [0, 1];
    const min = Math.min(...candidates);
    const max = Math.max(...candidates);
    const pad = (max - min || Math.abs(max) || 1) * 0.1;
    // A reference window that starts at 0 (LDL "0–130") must not drag the
    // axis below zero: a concentration cannot be negative, and a "-13" tick
    // reads as a value. The pad only stays below zero when the data already is.
    return [min >= 0 ? Math.max(0, min - pad) : min - pad, max + pad];
  }, [points, lowerBound, upperBound, sourceBand]);

  const animate = !prefersReducedMotion();
  const primary = "var(--primary)";
  // A second muted hue from the chart palette. Distinct from the primary band
  // by hue AND by treatment (outline vs fill), so the two are told apart
  // without relying on colour alone.
  const secondary = "var(--chart-2)";

  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-1">
        {RANGE_DAYS.map((r) => (
          <Button
            key={r.key}
            size="sm"
            variant={range === r.key ? "secondary" : "ghost"}
            aria-pressed={range === r.key}
            className="h-7 px-2 text-xs"
            onClick={() => setRange(r.key)}
          >
            {t(`labs.chart.range.${r.key}`)}
          </Button>
        ))}
      </div>

      {points.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          {t("labs.chart.empty")}
        </p>
      ) : (
        <div>
          <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
            <ComposedChart
              data={points}
              margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
              className={coarse ? undefined : "cursor-pointer"}
              onClick={
                coarse
                  ? undefined
                  : (state) => {
                      const index = Number(state?.activeTooltipIndex);
                      if (Number.isInteger(index))
                        openReadingDay(points[index]);
                    }
              }
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                vertical={false}
              />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(ts: number) => labShortDate(ts)}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                stroke="var(--border)"
                minTickGap={32}
              />
              <YAxis
                domain={yDomain}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                stroke="var(--border)"
                width={44}
                tickFormatter={(v: number) => labNumber(v)}
              />
              {/* Reference window — muted band + dashed bounds. No alarm
                  colour: the in/out verdict is shown by the neutral badge,
                  not by painting the chart red. */}
              {lowerBound != null && upperBound != null ? (
                <ReferenceArea
                  y1={lowerBound}
                  y2={upperBound}
                  fill={primary}
                  fillOpacity={0.1}
                  stroke="none"
                />
              ) : null}
              {lowerBound != null ? (
                <ReferenceLine
                  y={lowerBound}
                  stroke={primary}
                  strokeOpacity={0.4}
                  strokeDasharray="4 4"
                />
              ) : null}
              {upperBound != null ? (
                <ReferenceLine
                  y={upperBound}
                  stroke={primary}
                  strokeOpacity={0.4}
                  strokeDasharray="4 4"
                />
              ) : null}
              {/* The source window — outlined, not filled, so it reads as a
                  second band over the catalog one rather than a second fill
                  competing with it. Same no-alarm-colour rule. */}
              {sourceBand &&
              sourceBand.low != null &&
              sourceBand.high != null ? (
                <ReferenceArea
                  y1={sourceBand.low}
                  y2={sourceBand.high}
                  fill={secondary}
                  fillOpacity={0.06}
                  stroke={secondary}
                  strokeOpacity={0.5}
                  strokeDasharray="2 3"
                />
              ) : null}
              {sourceBand &&
              sourceBand.low != null &&
              sourceBand.high == null ? (
                <ReferenceLine
                  y={sourceBand.low}
                  stroke={secondary}
                  strokeOpacity={0.6}
                  strokeDasharray="2 3"
                />
              ) : null}
              {sourceBand &&
              sourceBand.high != null &&
              sourceBand.low == null ? (
                <ReferenceLine
                  y={sourceBand.high}
                  stroke={secondary}
                  strokeOpacity={0.6}
                  strokeDasharray="2 3"
                />
              ) : null}
              <Tooltip
                trigger={coarse ? "click" : "hover"}
                wrapperStyle={
                  coarse ? { pointerEvents: "auto", zIndex: 20 } : undefined
                }
                content={(props) => {
                  const active = props.active ?? false;
                  const payload = props.payload as
                    ReadonlyArray<{ payload?: ChartPoint }> | undefined;
                  const point = payload?.[0]?.payload;
                  if (!active || !point) {
                    return <RichChartTooltip active={false} rows={[]} />;
                  }
                  const rows: RichTooltipRow[] = [
                    {
                      name: t("labs.chart.valueLabel"),
                      value: `${labNumber(point.value)} ${unit}`,
                      color: primary,
                    },
                  ];
                  // Name the window THIS reading was judged against. Two
                  // readings on one chart can carry different printed windows,
                  // so the band alone cannot answer it per point.
                  if (point.referenceOrigin === "source") {
                    rows.push({
                      name: t("labs.chart.sourceRangeLabel"),
                      value:
                        point.sourceReferenceText ??
                        `${formatReferenceRange(
                          point.referenceLow,
                          point.referenceHigh,
                          labNumber,
                        )} ${unit}`.trim(),
                      color: secondary,
                    });
                  }
                  return (
                    <RichChartTooltip
                      active
                      label={labShortDate(point.timestamp)}
                      rows={rows}
                      action={
                        coarse ? (
                          <TooltipDayAction
                            onOpen={() => openReadingDay(point)}
                          />
                        ) : undefined
                      }
                    />
                  );
                }}
              />
              {points
                .filter(
                  (point) =>
                    openDayKey !== null &&
                    dayOf(point.timestamp) === openDayKey,
                )
                .map((point) => (
                  <ReferenceDot
                    key={`open-day-${point.id}`}
                    x={point.timestamp}
                    y={point.value}
                    r={6.5}
                    fill="var(--card)"
                    stroke={primary}
                    strokeWidth={2.5}
                    ifOverflow="discard"
                  />
                ))}
              <Line
                type="monotone"
                dataKey="value"
                stroke={primary}
                strokeWidth={2}
                dot={{ r: 3, fill: primary }}
                activeDot={{ r: 5 }}
                isAnimationActive={animate}
              />
            </ComposedChart>
          </ResponsiveContainer>
          {sourceBand ? (
            <p className="text-muted-foreground mt-2 text-xs">
              {sourceBand.mixed
                ? t("labs.chart.sourceBandMixed")
                : t("labs.chart.sourceBandLegend", {
                    date: labShortDate(sourceBand.takenAt),
                  })}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
