"use client";

/**
 * v1.28 — the "Wirkung" target chart. Recharts consumer, so it is exported
 * through `chart-runtime` and loaded via `next/dynamic` at the call site (the
 * one-shared-chunk rule). Renders the target series over a span around the
 * medication's start with:
 *   - a faint population reference band (context, never a goal line),
 *   - shaded pause bands,
 *   - a vertical start marker + quiet dose-change markers,
 *   - the target line,
 *   - a faint adherence lane on a hidden right axis.
 * Strictly descriptive — no colour-coded verdict, no "good/bad" zones.
 */
import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { makeFormatters } from "@/lib/format-locale";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";

export interface EfficacyChartTarget {
  label: string;
  unit: string | null;
  referenceBand: { low: number; high: number } | null;
  series: { t: string; value: number }[];
}

export interface EfficacyChartProps {
  target: EfficacyChartTarget;
  startMs: number | null;
  doseChanges: { at: string; label: string }[];
  pauses: { from: string; to: string | null }[];
  adherence: { date: string; rate: number }[];
  timezone: string;
  startLabel: string;
  adherenceLabel: string;
  typicalRangeLabel: string;
  /**
   * "absolute" plots the raw target values on the target's own unit;
   * "percent" reindexes the series to a percentage of a start-anchored
   * baseline and hides the (now meaningless) population reference band.
   */
  mode?: "absolute" | "percent";
}

const toMs = (iso: string): number => Date.parse(iso);

export function EfficacyChart({
  target,
  startMs,
  doseChanges,
  pauses,
  adherence,
  timezone,
  startLabel,
  adherenceLabel,
  typicalRangeLabel,
  mode = "absolute",
}: EfficacyChartProps) {
  const { locale } = useTranslations();
  // Issue #922 — the axis ticks and the tooltip label follow the profile's
  // date order. The hour cycle is AUTO on purpose: this formatter renders
  // days only (`fmt.date`), never a clock.
  const dateFormat = useDateFormatPreference();
  const fmt = useMemo(
    () => makeFormatters(locale, timezone, "AUTO", dateFormat),
    [locale, timezone, dateFormat],
  );

  const seriesData = useMemo(
    () =>
      target.series
        .map((p) => ({ t: toMs(p.t), value: p.value }))
        .filter((p) => Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t),
    [target.series],
  );
  const adherenceData = useMemo(
    () =>
      adherence
        .map((p) => ({ t: toMs(p.date), rate: p.rate }))
        .filter((p) => Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t),
    [adherence],
  );

  const domain = useMemo<[number, number] | null>(() => {
    const xs = [
      ...seriesData.map((p) => p.t),
      ...adherenceData.map((p) => p.t),
    ];
    if (xs.length === 0) return null;
    return [Math.min(...xs), Math.max(...xs)];
  }, [seriesData, adherenceData]);

  // The plotted target series. In "percent" mode each point is reindexed to a
  // percentage of the baseline value at/nearest the start (first point when
  // the start is unknown), so a small relative trend reads at full scale.
  const displaySeries = useMemo(() => {
    if (mode !== "percent" || seriesData.length === 0) return seriesData;
    const baselinePoint =
      startMs === null
        ? seriesData[0]
        : seriesData.reduce((best, p) =>
            Math.abs(p.t - startMs) < Math.abs(best.t - startMs) ? p : best,
          );
    const baseline = baselinePoint.value;
    // A zero/non-finite baseline can't anchor a ratio; leave the series
    // untouched rather than emit Infinity/NaN (target values are ~never 0).
    if (!Number.isFinite(baseline) || baseline === 0) return seriesData;
    return seriesData.map((p) => ({
      t: p.t,
      value: Math.round((p.value / baseline) * 1000) / 10,
    }));
  }, [seriesData, mode, startMs]);

  // Padded data-range domain for the target axis, computed from the currently
  // displayed series (never the reference band) so a real trend fills the plot
  // instead of compressing against a zero-based axis. The band may clip.
  const targetDomain = useMemo<[number, number]>(() => {
    const values = displaySeries.map((p) => p.value);
    if (values.length === 0) return [0, 1];
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) return [min - 1, max + 1];
    const pad = Math.max((max - min) * 0.12, 1);
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  }, [displaySeries]);

  if (seriesData.length === 0 || !domain) return null;

  const unitSuffix = mode === "percent" ? "%" : target.unit;

  // An open pause runs to the chart's right edge (the latest datum); using the
  // domain max keeps the render pure (no `Date.now()` in the render body).
  const rightEdge = domain[1];
  return (
    <div className="touch-pan-y">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.5}
          />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={domain}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmt.date(new Date(v))}
          />
          <YAxis
            yAxisId="target"
            domain={targetDomain}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={40}
            unit={unitSuffix ? ` ${unitSuffix}` : undefined}
          />
          <YAxis
            yAxisId="adherence"
            orientation="right"
            domain={[0, 100]}
            hide
          />

          {/* Population reference band — faint context, labelled "typical
              range", explicitly NOT a target line. Hidden in percent mode:
              an absolute band is meaningless once the series is normalized. */}
          {mode === "absolute" && target.referenceBand ? (
            <ReferenceArea
              yAxisId="target"
              y1={target.referenceBand.low}
              y2={target.referenceBand.high}
              fill="var(--muted-foreground)"
              fillOpacity={0.08}
              stroke="none"
              label={{
                value: typicalRangeLabel,
                position: "insideTopLeft",
                fill: "var(--muted-foreground)",
                fontSize: 10,
              }}
            />
          ) : null}

          {/* Shaded pause bands. An open pause runs to now. */}
          {pauses.map((p, i) => (
            <ReferenceArea
              key={`pause-${i}`}
              yAxisId="target"
              x1={toMs(p.from)}
              x2={p.to ? toMs(p.to) : rightEdge}
              fill="var(--foreground)"
              fillOpacity={0.06}
              stroke="none"
            />
          ))}

          {/* Adherence lane — faint, hidden right axis. */}
          <Line
            yAxisId="adherence"
            data={adherenceData}
            dataKey="rate"
            name={adherenceLabel}
            type="stepAfter"
            stroke="var(--chart-4)"
            strokeWidth={1.5}
            strokeOpacity={0.5}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />

          {/* The target series. */}
          <Line
            yAxisId="target"
            data={displaySeries}
            dataKey="value"
            name={target.label}
            type="monotone"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={{ r: 2, fill: "var(--chart-1)" }}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
          />

          {/* Start marker. */}
          {startMs !== null ? (
            <ReferenceLine
              yAxisId="target"
              x={startMs}
              stroke="var(--primary)"
              strokeWidth={1.5}
              label={{
                value: startLabel,
                position: "insideTopRight",
                fill: "var(--foreground)",
                fontSize: 10,
              }}
            />
          ) : null}

          {/* Dose-change markers — quiet, dashed. */}
          {doseChanges.map((d, i) => (
            <ReferenceLine
              key={`dose-${i}`}
              yAxisId="target"
              x={toMs(d.at)}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.6}
            />
          ))}

          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.8125rem",
            }}
            labelFormatter={(v) => fmt.date(new Date(Number(v)))}
            formatter={(value, name) => {
              const num = Number(value);
              if (name === adherenceLabel) {
                return [`${Math.round(num)}%`, String(name)];
              }
              const text =
                mode === "percent"
                  ? `${num}%`
                  : `${num}${target.unit ? ` ${target.unit}` : ""}`;
              return [text, String(name)];
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
