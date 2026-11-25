"use client";

import { useMemo } from "react";

import { sourceDisplayName } from "@/components/insights/sleep-source-discrepancy-marker";
import type { HypnogramOverlayLine } from "@/components/insights/sleep/sleep-hypnogram-chart";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import type {
  SleepNightOverlayMetric,
  SleepNightOverlays,
} from "@/hooks/use-sleep-night";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  NIGHT_OVERLAY_MAX_BRIDGE_MINUTES,
  nextOverlaySelection,
  type NightOverlayKind,
} from "@/lib/sleep/night-overlay-kinds";
import { cn } from "@/lib/utils";

/**
 * The night metrics over the timeline (#1419): which lines the chart draws,
 * the toggles that choose them, and the night's single values.
 *
 * The server sends each metric the night holds, already resolved to one
 * source and bucketed on one grid (`overlays` on `GET /api/sleep/night`).
 * A metric with a series gets a toggle; a metric with one value a night
 * (Garmin's HRV, Oura's SpO2) is listed as a number under the chart, never
 * drawn as a line. At most two lines show at once: choosing a third drops
 * the one chosen first. The choice is the account's, kept in the chart
 * preferences (`chartOverlayPrefs.sleepNight.overlayLines`) so it follows
 * the person to another device; none is chosen until they pick one.
 *
 * Line colours go by slot, not by metric: the first line is the foreground
 * colour and the second `--chart-5`, the two tokens the stage palette does
 * not use, so a line never disappears into a stage band of its own hue.
 */

const SLOT_COLORS = ["var(--foreground)", "var(--chart-5)"] as const;

/** Types whose readings read as whole numbers. */
const WHOLE_NUMBER_TYPES = new Set([
  "PULSE",
  "HEART_RATE_VARIABILITY",
  "HRV_RMSSD",
  "OXYGEN_SATURATION",
]);

const KIND_LABEL_KEYS: Record<NightOverlayKind, string> = {
  pulse: "insights.sleep.hypnogram.overlay.kinds.pulse",
  hrv: "insights.sleep.hypnogram.overlay.kinds.hrv",
  respiration: "insights.sleep.hypnogram.overlay.kinds.respiration",
  spo2: "insights.sleep.hypnogram.overlay.kinds.spo2",
  skinTemperature: "insights.sleep.hypnogram.overlay.kinds.skinTemperature",
  roomTemperature: "insights.sleep.hypnogram.overlay.kinds.roomTemperature",
};

export interface NightOverlayState {
  /** Metrics with a series: the toggles. */
  series: SleepNightOverlayMetric[];
  /** Metrics with one value for the night. */
  nightValues: SleepNightOverlayMetric[];
  /** The kinds drawn, in the order chosen; each one has a series. */
  shown: NightOverlayKind[];
  toggle: (kind: NightOverlayKind) => void;
  /** The chart's `overlay` prop; undefined when no line is shown. */
  chartOverlay:
    | { gridFromMs: number; bucketMs: number; lines: HypnogramOverlayLine[] }
    | undefined;
  labelOf: (metric: SleepNightOverlayMetric) => string;
  /** A value of `metric` in the reader's units, with its unit unless `bare`. */
  format: (
    metric: SleepNightOverlayMetric,
    value: number,
    bare?: boolean,
  ) => string;
  colorOf: (kind: NightOverlayKind) => string | null;
}

export function useNightOverlays(
  overlays: SleepNightOverlays | null | undefined,
  enabled: boolean,
): NightOverlayState {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const units = useUnitDisplay();
  const { prefs, setPrefs } = useChartOverlayPrefs(
    enabled ? "sleepNight" : null,
  );
  const chosen = useMemo(() => prefs.overlayLines ?? [], [prefs.overlayLines]);

  return useMemo(() => {
    const metrics = overlays?.metrics ?? [];
    const series = metrics.filter((m) => m.points.length > 0);
    const nightValues = metrics.filter(
      (m) => m.points.length === 0 && m.nightValue !== null,
    );
    const shown = chosen.filter((kind) => series.some((m) => m.kind === kind));

    const labelOf = (metric: SleepNightOverlayMetric) =>
      t(KIND_LABEL_KEYS[metric.kind]);
    const format = (
      metric: SleepNightOverlayMetric,
      value: number,
      bare = false,
    ) => {
      const display = units.toDisplay(metric.type, value);
      const digits = WHOLE_NUMBER_TYPES.has(metric.type)
        ? 0
        : units.decimalsFor(metric.type);
      const number = fmt.number(display, digits);
      const signed =
        metric.type === "BODY_TEMPERATURE_DEVIATION" && display > 0
          ? `+${number}`
          : number;
      const unit = bare ? "" : units.unitFor(metric.type);
      return unit ? `${signed} ${unit}` : signed;
    };
    const colorOf = (kind: NightOverlayKind) => {
      const slot = shown.indexOf(kind);
      return slot === -1 ? null : SLOT_COLORS[slot]!;
    };
    const toggle = (kind: NightOverlayKind) => {
      const next = nextOverlaySelection(chosen, shown, kind);
      setPrefs({ ...prefs, overlayLines: next });
    };

    const lines: HypnogramOverlayLine[] = shown.map((kind) => {
      const metric = series.find((m) => m.kind === kind)!;
      return {
        key: kind,
        label: labelOf(metric),
        color: colorOf(kind)!,
        points: metric.points.map((p) => ({ at: p.at, value: p.value })),
        maxBridgeMinutes: NIGHT_OVERLAY_MAX_BRIDGE_MINUTES[kind],
        format: (value) => format(metric, value),
      };
    });
    const chartOverlay =
      overlays && lines.length > 0
        ? {
            gridFromMs: Date.parse(overlays.from),
            bucketMs: overlays.bucketMinutes * 60_000,
            lines,
          }
        : undefined;

    return {
      series,
      nightValues,
      shown,
      toggle,
      chartOverlay,
      labelOf,
      format,
      colorOf,
    };
  }, [overlays, chosen, prefs, setPrefs, t, fmt, units]);
}

/**
 * The toggles under the chart, one per metric with a series. A chosen
 * toggle shows its line's colour and the range its scale spans, which is
 * how a line without an axis of its own is read.
 */
export function SleepNightOverlayChips({
  state,
}: {
  state: NightOverlayState;
}) {
  const { t } = useTranslations();
  if (state.series.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("insights.sleep.hypnogram.overlay.group")}
      data-slot="sleep-hypnogram-overlay-chips"
      className="flex flex-wrap items-center gap-1.5"
    >
      {state.series.map((metric) => {
        const color = state.colorOf(metric.kind);
        const on = color !== null;
        const label = state.labelOf(metric);
        return (
          <button
            key={metric.kind}
            type="button"
            aria-pressed={on}
            data-kind={metric.kind}
            title={t("insights.sleep.hypnogram.source", {
              source: sourceDisplayName(metric.source, null, t),
            })}
            onClick={() => state.toggle(metric.kind)}
            className={cn(
              "focus-visible:ring-input-focus inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none sm:min-h-8",
              on
                ? "border-border text-foreground"
                : "border-border/60 text-muted-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block size-2 rounded-full",
                on ? "" : "border-muted-foreground/60 border",
              )}
              style={on ? { backgroundColor: color } : undefined}
            />
            <span>{label}</span>
            {on && metric.summary ? (
              <span className="text-muted-foreground tabular-nums">
                {t("insights.sleep.hypnogram.overlay.range", {
                  min: state.format(metric, metric.summary.min, true),
                  max: state.format(metric, metric.summary.max),
                })}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The night's single values as numbers, and for a screen reader every
 * metric of the night in words: lowest, highest and average for a series,
 * the value for a single one. The chart is an image to assistive
 * technology, so this list is where its lines are read.
 */
export function SleepNightOverlayFacts({
  state,
}: {
  state: NightOverlayState;
}) {
  const { t } = useTranslations();
  if (state.series.length === 0 && state.nightValues.length === 0) return null;
  return (
    <>
      {state.nightValues.length > 0 ? (
        <p
          aria-hidden="true"
          data-slot="sleep-hypnogram-night-values"
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs"
        >
          <span className="text-muted-foreground">
            {t("insights.sleep.hypnogram.overlay.nightValues")}
          </span>
          {state.nightValues.map((metric) => (
            <span key={metric.kind} data-kind={metric.kind}>
              <span className="text-muted-foreground">
                {state.labelOf(metric)}
              </span>{" "}
              <span className="text-foreground tabular-nums">
                {state.format(metric, metric.nightValue!)}
              </span>
            </span>
          ))}
        </p>
      ) : null}
      <ul className="sr-only" data-slot="sleep-hypnogram-overlay-summary">
        {state.series.map((metric) => (
          <li key={metric.kind}>
            {t("insights.sleep.hypnogram.overlay.srSeries", {
              metric: state.labelOf(metric),
              min: state.format(metric, metric.summary!.min),
              max: state.format(metric, metric.summary!.max),
              avg: state.format(metric, metric.summary!.avg),
            })}
          </li>
        ))}
        {state.nightValues.map((metric) => (
          <li key={metric.kind}>
            {t("insights.sleep.hypnogram.overlay.srNight", {
              metric: state.labelOf(metric),
              value: state.format(metric, metric.nightValue!),
            })}
          </li>
        ))}
      </ul>
    </>
  );
}
