"use client";

import { useTranslations } from "@/lib/i18n/context";
import type { TimeInRangeDistribution } from "@/lib/analytics/glucose-metrics";

/**
 * v1.17.0 — Battelino 2019 time-in-range stacked bar.
 *
 * A single horizontal 100%-width bar split into the five consensus bands
 * (very low / low / in range / high / very high), bottom-to-top severity
 * read left-to-right with the in-range band centred and dominant. Fractions
 * arrive already computed by the server engine — this component only renders
 * them, it never re-derives a band. The level-2 sub-bands are NESTED inside
 * level-1 in the source distribution (TBR2 ⊆ TBR1, TAR2 ⊆ TAR1), so the
 * segment widths here use the EXCLUSIVE slices to fill exactly 100%.
 */

const BAND_COLORS = {
  veryLow: "var(--destructive)", // dracula-red — urgent low
  low: "var(--warning)", // dracula-orange — low
  inRange: "var(--success)", // dracula-green — target
  high: "var(--dracula-yellow)", // dracula-yellow — high
  veryHigh: "var(--chart-3)", // dracula-pink — urgent high
} as const;

type BandKey = keyof typeof BAND_COLORS;

export interface GlucoseTirBarProps {
  distribution: TimeInRangeDistribution;
}

export function GlucoseTirBar({ distribution }: GlucoseTirBarProps) {
  const { t } = useTranslations();

  // Exclusive slices from the nested consensus fractions: level-2 is a subset
  // of level-1, so the level-1-only slice = level1 − level2.
  const veryLow = distribution.tbrLevel2;
  const low = Math.max(0, distribution.tbrLevel1 - distribution.tbrLevel2);
  const inRange = distribution.tir;
  const high = Math.max(0, distribution.tarLevel1 - distribution.tarLevel2);
  const veryHigh = distribution.tarLevel2;

  const segments: Array<{ key: BandKey; label: string; fraction: number }> = [
    {
      key: "veryLow",
      label: t("insights.bloodGlucose.clinical.tir.veryLow"),
      fraction: veryLow,
    },
    {
      key: "low",
      label: t("insights.bloodGlucose.clinical.tir.low"),
      fraction: low,
    },
    {
      key: "inRange",
      label: t("insights.bloodGlucose.clinical.tir.inRange"),
      fraction: inRange,
    },
    {
      key: "high",
      label: t("insights.bloodGlucose.clinical.tir.high"),
      fraction: high,
    },
    {
      key: "veryHigh",
      label: t("insights.bloodGlucose.clinical.tir.veryHigh"),
      fraction: veryHigh,
    },
  ];

  const pct = (f: number) => Math.round(f * 100);
  const ariaLabel = t("insights.bloodGlucose.clinical.tir.ariaLabel", {
    tir: pct(inRange),
    below: pct(distribution.tbrLevel1),
    above: pct(distribution.tarLevel1),
  });

  return (
    <div data-slot="glucose-tir-bar" className="space-y-2">
      <div
        role="img"
        aria-label={ariaLabel}
        className="bg-muted flex h-6 w-full overflow-hidden rounded-md"
      >
        {segments.map((s) =>
          s.fraction > 0 ? (
            <div
              key={s.key}
              data-slot={`glucose-tir-segment-${s.key}`}
              className="h-full"
              style={{
                width: `${s.fraction * 100}%`,
                background: BAND_COLORS[s.key],
              }}
              title={`${s.label}: ${pct(s.fraction)}%`}
            />
          ) : null,
        )}
      </div>
      <ul
        className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3"
        data-slot="glucose-tir-legend"
      >
        {segments.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: BAND_COLORS[s.key] }}
              />
              {s.label}
            </span>
            <span className="text-foreground font-medium tabular-nums">
              {pct(s.fraction)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
