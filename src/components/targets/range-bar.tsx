"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.25 W3e — extracted from `src/app/targets/page.tsx` (the page
 * was 790 lines; the redesign breaks it into focused primitives so
 * each component carries its own contract + test suite).
 *
 * A horizontal range bar with green/yellow/red zones showing where
 * the current value falls relative to a target range. The marker dot
 * carries a tooltip with the current value + the target range + a
 * delta sentence (e.g. "6 mmHg above target band").
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
}

export function RangeBar({
  value,
  min,
  max,
  unit,
  orangeMin,
  orangeMax,
}: RangeBarProps) {
  const { t } = useTranslations();

  const span = max - min;
  const defaultOrangeWidth = span * 0.3;
  const computedOrangeMin = min - defaultOrangeWidth;
  const computedOrangeMax = max + defaultOrangeWidth;
  const effectiveOrangeMin =
    orangeMin != null ? Math.min(orangeMin, min) : computedOrangeMin;
  const effectiveOrangeMax =
    orangeMax != null ? Math.max(orangeMax, max) : computedOrangeMax;

  const orangeSpan = Math.max(1, effectiveOrangeMax - effectiveOrangeMin);
  const sidePadding = Math.max(1, orangeSpan * 0.18);
  const visualMin = effectiveOrangeMin - sidePadding;
  const visualMax = effectiveOrangeMax + sidePadding;
  const visualSpan = visualMax - visualMin;
  const clampedValue = Math.max(visualMin, Math.min(visualMax, value));
  const rawPosition = ((clampedValue - visualMin) / visualSpan) * 100;
  const EDGE_PADDING_PERCENT = 4;
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

  const markerColor = inGreen
    ? "var(--dracula-green)"
    : inYellow
      ? "var(--dracula-orange)"
      : "var(--dracula-red)";
  const minLabelPosition = Math.max(5, Math.min(95, greenStart));
  const maxLabelPosition = Math.max(5, Math.min(95, greenEnd));

  // Delta to target range
  const delta = value < min ? min - value : value > max ? value - max : 0;
  const deltaText =
    delta > 0
      ? value < min
        ? t("targets.belowTarget", { delta: delta.toFixed(1), unit })
        : t("targets.aboveTarget", { delta: delta.toFixed(1), unit })
      : t("targets.inTarget");

  return (
    <div className="space-y-1.5" data-slot="target-range-bar">
      <div className="bg-muted/50 relative h-3 w-full overflow-hidden rounded-full">
        {/* Red background (full bar) — Dracula `--dracula-red` so the
            chart palette stays aligned with PR-badge, alerts, and the
            marker dot itself. Raw Tailwind palettes drift from the
            theme over time and never get dark-mode tuned. */}
        <div className="bg-dracula-red/10 absolute inset-0 rounded-full" />
        {/* Orange (caution) side zones — `--dracula-orange` matches the
            marker's out-of-band tint. */}
        <div
          className="bg-dracula-orange/15 absolute top-0 h-full"
          style={{
            left: `${yellowLeftStart}%`,
            width: `${greenStart - yellowLeftStart}%`,
          }}
        />
        <div
          className="bg-dracula-orange/15 absolute top-0 h-full"
          style={{
            left: `${greenEnd}%`,
            width: `${yellowRightEnd - greenEnd}%`,
          }}
        />
        {/* In-band green zone — `--dracula-green`. */}
        <div
          className="bg-dracula-green/20 absolute top-0 h-full"
          style={{
            left: `${greenStart}%`,
            width: `${greenEnd - greenStart}%`,
          }}
        />
        {/* Current value marker with tooltip */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-2 shadow-sm"
                style={{
                  left: `${position}%`,
                  backgroundColor: markerColor,
                  borderColor: markerColor,
                }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs font-medium">
                {t("targets.currentValue", { value: String(value), unit })}
              </p>
              <p className="text-xs">
                {t("targets.targetRangeValue", {
                  min: String(min),
                  max: String(max),
                  unit,
                })}
              </p>
              <p className="text-xs font-medium">{deltaText}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="text-muted-foreground relative h-4 text-xs">
        <span
          className="absolute -translate-x-1/2"
          style={{ left: `${minLabelPosition}%` }}
        >
          {min} {unit}
        </span>
        <span
          className="absolute -translate-x-1/2"
          style={{ left: `${maxLabelPosition}%` }}
        >
          {max} {unit}
        </span>
      </div>
    </div>
  );
}
