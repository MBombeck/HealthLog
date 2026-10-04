"use client";

import { RangeBar } from "@/components/targets/range-bar";
import { cn } from "@/lib/utils";

import { useLabNumber } from "./use-lab-format";

/**
 * v1.37.34 — compact reference-range visualization for saved lab readings.
 *
 * The adapter keeps lab-specific data rules out of the shared target bar:
 * qualitative readings are omitted, one-sided limits get a bounded visual
 * scale, and invalid ranges remain text-only.
 */
export function LabReferenceRangeBar({
  value,
  referenceLow,
  referenceHigh,
  unit,
  className,
}: {
  value: number | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  unit: string;
  /** Extra classes on the bar's wrapper; it caps itself at 12rem by default. */
  className?: string;
}) {
  const labNumber = useLabNumber();
  const hasLow = referenceLow !== null && Number.isFinite(referenceLow);
  const hasHigh = referenceHigh !== null && Number.isFinite(referenceHigh);
  if (
    value === null ||
    !Number.isFinite(value) ||
    (!hasLow && !hasHigh) ||
    (hasLow && hasHigh && referenceLow! >= referenceHigh!)
  ) {
    return null;
  }

  // A missing endpoint gets a synthetic opposite edge only for positioning;
  // the visible label still shows the original one-sided limit.
  const scale = Math.max(Math.abs(referenceLow ?? referenceHigh!), 1);
  const min = referenceLow ?? referenceHigh! - scale;
  const max = referenceHigh ?? referenceLow! + scale;
  const rangeLabel = !hasLow
    ? `≤${labNumber(referenceHigh!)} ${unit}`
    : !hasHigh
      ? `≥${labNumber(referenceLow!)} ${unit}`
      : `${labNumber(referenceLow!)}–${labNumber(referenceHigh!)} ${unit}`;

  return (
    <div
      data-slot="lab-reference-range-bar"
      className={cn("w-full max-w-48 shrink-0", className)}
      aria-label={rangeLabel}
    >
      <RangeBar
        value={value}
        min={min}
        max={max}
        unit={unit}
        compact
        tone="lab"
        formatValue={labNumber}
        minLabel={referenceLow === null ? null : undefined}
        maxLabel={referenceHigh === null ? null : undefined}
      />
    </div>
  );
}
