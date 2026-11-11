"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

/**
 * A horizontal range bar with green/yellow/red zones showing where
 * the current value falls relative to a target range. A tap on the marker
 * dot shows the current value + the target range + a delta sentence (e.g.
 * "6 mmHg above target band").
 *
 * Behaviour is unchanged from the v1.4.22 inline version; only the
 * file boundary moves.
 */
export interface RangeBarProps {
  value: number;
  min: number;
  max: number;
  unit: string;
  orangeMin?: number;
  orangeMax?: number;
  compact?: boolean;
  tone?: "target" | "lab";
  minLabel?: string | null;
  maxLabel?: string | null;
  /**
   * How a value or bound is printed. Defaults to the reader's locale number
   * format; a surface with its own precision rule (lab values trim to two
   * decimals) passes it here so the bar and the row beside it agree.
   */
  formatValue?: (value: number) => string;
}

/**
 * How far from either end the value marker is allowed to sit, in percent.
 *
 * Module scope rather than the render body so the test can assert against the
 * same number the component clamps with, instead of a copy that can drift.
 */
export const EDGE_PADDING_PERCENT = 4;

/**
 * The bar can sit in a list row that is itself a link: a tap on the marker
 * or its popover opens the popover, not the row.
 */
function keepTapInside(event: React.MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

export function RangeBar({
  value,
  min,
  max,
  unit,
  orangeMin,
  orangeMax,
  compact = false,
  tone = "target",
  minLabel,
  maxLabel,
  formatValue,
}: RangeBarProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // Every printed number goes through the locale formatter: a German reader
  // sees "61,3 kg", not "61.3 kg".
  const show = formatValue ?? ((v: number) => fmt.number(v));
  const isLab = tone === "lab";

  const span = max - min;
  const defaultOrangeWidth = span * (isLab ? 0.12 : 0.3);
  const computedOrangeMin = min - defaultOrangeWidth;
  const computedOrangeMax = max + defaultOrangeWidth;
  const effectiveOrangeMin =
    orangeMin != null ? Math.min(orangeMin, min) : computedOrangeMin;
  const effectiveOrangeMax =
    orangeMax != null ? Math.max(orangeMax, max) : computedOrangeMax;

  // Keep zero-width ranges from producing invalid percentages. The lab
  // adapter currently avoids this by adding a synthetic bound when needed.
  const orangeSpan = Math.max(
    isLab ? Number.EPSILON : 1,
    effectiveOrangeMax - effectiveOrangeMin,
  );
  const sidePadding = Math.max(
    isLab ? Number.EPSILON : 1,
    orangeSpan * (isLab ? 0.06 : 0.18),
  );
  const baseVisualMin = effectiveOrangeMin - sidePadding;
  const baseVisualMax = effectiveOrangeMax + sidePadding;
  // Lab values can sit far outside a narrow reference window (for example
  // vitamin D at 6.8 against a minimum of 30). Expand the visible scale to
  // include the actual value instead of pinning its marker to the edge.
  const baseVisualSpan = Math.max(
    baseVisualMax - baseVisualMin,
    Number.EPSILON,
  );
  const outlierPadding = Math.max(baseVisualSpan * 0.06, Number.EPSILON);
  const visualMin = isLab
    ? Math.min(baseVisualMin, value - outlierPadding)
    : baseVisualMin;
  const visualMax = isLab
    ? Math.max(baseVisualMax, value + outlierPadding)
    : baseVisualMax;
  const visualSpan = visualMax - visualMin;
  const clampedValue = Math.max(visualMin, Math.min(visualMax, value));
  const rawPosition = ((clampedValue - visualMin) / visualSpan) * 100;
  const position = Math.max(
    EDGE_PADDING_PERCENT,
    Math.min(100 - EDGE_PADDING_PERCENT, rawPosition),
  );

  // Zone boundaries (percent of visual bar)
  const greenStart = Math.max(0, ((min - visualMin) / visualSpan) * 100);
  const greenEnd = Math.min(100, ((max - visualMin) / visualSpan) * 100);
  const yellowLeftStart = Math.max(
    0,
    ((effectiveOrangeMin - visualMin) / visualSpan) * 100,
  );
  const yellowRightEnd = Math.min(
    100,
    ((effectiveOrangeMax - visualMin) / visualSpan) * 100,
  );

  // Determine marker color
  const inGreen = value >= min && value <= max;
  const inYellow =
    !inGreen && value >= effectiveOrangeMin && value <= effectiveOrangeMax;

  const markerColor = isLab
    ? inGreen
      ? "var(--success)"
      : value < min
        ? "var(--info)"
        : "var(--warning)"
    : inGreen
      ? "var(--success)"
      : inYellow
        ? "var(--warning)"
        : "var(--destructive)";
  const minLabelPosition = Math.max(5, Math.min(95, greenStart));
  const maxLabelPosition = Math.max(5, Math.min(95, greenEnd));

  // Delta to target range
  const delta = value < min ? min - value : value > max ? value - max : 0;
  const deltaText =
    delta > 0
      ? value < min
        ? t("targets.belowTarget", { delta: fmt.number(delta, 1), unit })
        : t("targets.aboveTarget", { delta: fmt.number(delta, 1), unit })
      : t("targets.inTarget");

  // The same three strings the popover shows, as the marker's name.
  const markerAriaLabel = [
    t("targets.currentValue", { value: show(value), unit }),
    t("targets.targetRangeValue", { min: show(min), max: show(max), unit }),
    deltaText,
  ].join(". ");

  return (
    <div
      className={compact ? "space-y-0.5" : "space-y-1.5"}
      data-slot="target-range-bar"
    >
      <div
        className={`bg-muted/50 relative w-full overflow-hidden rounded-full ${
          compact ? "h-2" : "h-3"
        }`}
      >
        {/* Full-track tint stays muted for lab ranges and alarm-coloured for
            target ranges; both use semantic theme tokens. */}
        <div
          className={`absolute inset-0 rounded-full ${
            isLab ? "bg-muted/70" : "bg-destructive/10"
          }`}
        />
        {/* Side zones use the lab's calm information palette or the target
            range's caution palette. */}
        <div
          className={`absolute top-0 h-full ${
            isLab ? "bg-info/35" : "bg-warning/15"
          }`}
          style={{
            left: isLab ? "0%" : `${yellowLeftStart}%`,
            width: isLab
              ? `${greenStart}%`
              : `${greenStart - yellowLeftStart}%`,
          }}
        />
        <div
          className={`absolute top-0 h-full ${
            isLab ? "bg-warning/35" : "bg-warning/15"
          }`}
          style={{
            left: `${greenEnd}%`,
            width: isLab
              ? `${100 - greenEnd}%`
              : `${yellowRightEnd - greenEnd}%`,
          }}
        />
        {/* In-band zone — `--success` remains the shared positive signal. */}
        <div
          className={`absolute top-0 h-full ${
            isLab ? "bg-success/35" : "bg-success/20"
          }`}
          style={{
            left: `${greenStart}%`,
            width: `${greenEnd - greenStart}%`,
          }}
        />
        {/* Current value marker; a tap shows its numbers. */}
        <span className="contents" onClick={keepTapInside}>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={markerAriaLabel}
                className={`focus-visible:ring-ring absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full shadow-sm focus-visible:ring-2 focus-visible:outline-none ${
                  compact ? "h-5 w-1 border" : "h-5 w-5 border-2"
                }`}
                style={{
                  left: `${position}%`,
                  backgroundColor: markerColor,
                  borderColor: markerColor,
                }}
              />
            </PopoverTrigger>
            <PopoverContent>
              <p className="text-xs font-medium">
                {t("targets.currentValue", { value: show(value), unit })}
              </p>
              <p className="text-xs">
                {t("targets.targetRangeValue", {
                  min: show(min),
                  max: show(max),
                  unit,
                })}
              </p>
              <p className="text-xs font-medium">{deltaText}</p>
            </PopoverContent>
          </Popover>
        </span>
      </div>
      <div
        className={`text-muted-foreground relative ${
          compact ? "h-3 text-[10px]" : "h-4 text-xs"
        }`}
      >
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${minLabelPosition}%` }}
        >
          {minLabel === null ? null : (minLabel ?? `${show(min)} ${unit}`)}
        </span>
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${maxLabelPosition}%` }}
        >
          {maxLabel === null ? null : (maxLabel ?? `${show(max)} ${unit}`)}
        </span>
      </div>
    </div>
  );
}
