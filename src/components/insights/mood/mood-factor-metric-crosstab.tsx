"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { Formatters } from "@/lib/format-locale";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { moodTagIcon } from "@/components/mood/mood-tag-icons";
import { cn } from "@/lib/utils";
import type { MoodInfluenceConfidence } from "./mood-tag-influence";
import {
  PatternDismissButton,
  PatternDismissedNotice,
  usePatternDismissalOverrides,
} from "@/components/insights/pattern-dismiss-action";

/**
 * v1.14.0 — RATED-factor × vital crosstab card.
 *
 * The cross-domain bridge: for each factor the user scores per entry (work /
 * sleep-quality / stress …), a vital's mean on the days the factor was rated
 * LOW (below its median) vs HIGH, the delta, and a confidence chip. The math
 * is pre-computed in `mood-aggregates.ts` (`computeFactorMetricCrosstab`) —
 * the same Welch t-test + day floors + Benjamini-Hochberg FDR the rest of the
 * relations surface uses; only FDR-surviving rows reach here. An inverse
 * factor (stress / conflict) already runs its split on the flipped series, so
 * "low" always means a worse day; the phrasing reads "your worse <factor>
 * days". Observational only: the page-level "associations, not causes" footer
 * carries the caveat once.
 */

export type MoodFactorCrosstabDisplay =
  "hours" | "score" | "steps" | "bpm" | "ms" | "kg" | "mmHg";
export type MoodFactorCrosstabMode = "sameDay" | "nextDay";

export interface MoodFactorMetricCrosstabRow {
  factor: string;
  labelKey: string;
  categoryKey: string;
  icon: string | null;
  inverse: boolean;
  metricKey: string;
  display: MoodFactorCrosstabDisplay;
  mode: MoodFactorCrosstabMode;
  lowDays: number;
  highDays: number;
  lowAvg: number;
  highAvg: number;
  delta: number;
  pValue: number;
  qValue: number;
  confidence: MoodInfluenceConfidence;
  patternId?: string;
  canonicalKey?: string;
  dismissed?: boolean;
}

const METRIC_LABEL_KEY: Record<string, string> = {
  sleepDuration: "insights.mood.factorCrosstab.metricSleepDuration",
  steps: "insights.mood.factorCrosstab.metricSteps",
  restingHeartRate: "insights.mood.factorCrosstab.metricRestingHeartRate",
  heartRateVariability: "insights.mood.factorCrosstab.metricHrv",
  weight: "insights.mood.factorCrosstab.metricWeight",
  bloodPressureSystolic: "insights.mood.factorCrosstab.metricBloodPressureSys",
};

const UNIT_KEY: Record<MoodFactorCrosstabDisplay, string> = {
  hours: "insights.mood.factorCrosstab.unitHours",
  score: "insights.mood.factorCrosstab.unitScore",
  steps: "insights.mood.factorCrosstab.unitSteps",
  bpm: "insights.mood.factorCrosstab.unitBpm",
  ms: "insights.mood.factorCrosstab.unitMs",
  kg: "insights.mood.factorCrosstab.unitKg",
  mmHg: "insights.mood.factorCrosstab.unitMmHg",
};

const CONFIDENCE_KEY: Record<MoodInfluenceConfidence, string> = {
  low: "insights.mood.influence.confidenceLow",
  medium: "insights.mood.influence.confidenceMedium",
  high: "insights.mood.influence.confidenceHigh",
};

const CONFIDENCE_CLASS: Record<MoodInfluenceConfidence, string> = {
  low: "bg-secondary text-muted-foreground",
  medium: "bg-info/15 text-info",
  high: "bg-success/15 text-success",
};

/** Whole numbers for steps; one decimal otherwise. */
function formatValue(
  value: number,
  display: MoodFactorCrosstabDisplay,
  nf: Formatters,
): string {
  return display === "steps" ? nf.integer(value) : nf.number(value, 1);
}

export function MoodFactorMetricCrosstab({
  rows,
}: {
  rows: MoodFactorMetricCrosstabRow[];
}) {
  const { t } = useTranslations();
  const nf = useFormatters();
  const unitDisplay = useUnitDisplay();
  const dismissal = usePatternDismissalOverrides();
  if (rows.length === 0) return null;

  return (
    <div data-slot="mood-factor-metric-crosstab">
      <p className="text-muted-foreground mb-2 text-sm">
        {t("insights.mood.factorCrosstab.description")}
      </p>
      <ul className="divide-border divide-y">
        {rows.map((row) => {
          const patternId = row.patternId;
          if (
            patternId &&
            dismissal.isDismissed(patternId, row.dismissed === true)
          ) {
            return (
              <li key={row.canonicalKey ?? patternId} className="py-2">
                <PatternDismissedNotice
                  compact
                  patternId={patternId}
                  onRestored={() => dismissal.setDismissed(patternId, false)}
                  onSettled={() => dismissal.clearDismissed(patternId, false)}
                />
              </li>
            );
          }
          const Icon = moodTagIcon(row.icon);
          const factorLabel = t(row.labelKey);
          const metricLabel = t(
            METRIC_LABEL_KEY[row.metricKey] ?? row.metricKey,
          );
          const pairLabel = t("insights.mood.factorCrosstab.pairLabel", {
            factor: factorLabel,
            metric: metricLabel,
          });
          // v1.32.26 — the weight ("kg") row follows the metric/imperial
          // preference: the unit symbol + the values (averages + delta, all in
          // kg, offset-free) convert together. Every other display is unitless
          // to the preference and keeps its i18n label + raw value.
          const isWeightRow = row.display === "kg";
          const unit = isWeightRow
            ? unitDisplay.unitFor("WEIGHT")
            : t(UNIT_KEY[row.display]);
          const conv = (v: number) =>
            isWeightRow ? unitDisplay.toDisplay("WEIGHT", v) : v;
          // `delta` = lowAvg − highAvg: positive = the vital runs higher on the
          // low-factor (worse) days. The number stays NEUTRAL — a higher value
          // is good for steps but bad for resting HR, and this board is
          // observational ("associations, not causes"), so colouring it
          // green/red would imply a health verdict the data doesn't support.
          // The sign prefix + `data-direction` carry the direction.
          const up = row.delta >= 0;
          const deltaText = `${up ? "+" : ""}${formatValue(conv(row.delta), row.display, nf)} ${unit}`;
          return (
            <li
              key={`${row.metricKey}:${row.factor}`}
              className="flex flex-col gap-1.5 py-2"
              data-slot="mood-factor-crosstab-row"
              data-metric={row.metricKey}
              data-direction={up ? "up" : "down"}
              data-confidence={row.confidence}
            >
              <div className="flex items-center gap-2 text-sm">
                {Icon && (
                  <Icon
                    className="text-muted-foreground h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                )}
                <span
                  className="text-foreground min-w-0 flex-1 truncate"
                  title={pairLabel}
                >
                  {pairLabel}
                </span>
                <span className="text-foreground shrink-0 text-sm font-semibold tabular-nums">
                  {deltaText}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                    CONFIDENCE_CLASS[row.confidence],
                  )}
                >
                  {t(CONFIDENCE_KEY[row.confidence])}
                </span>
                {patternId ? (
                  <PatternDismissButton
                    patternId={patternId}
                    onDismissed={() => dismissal.setDismissed(patternId, true)}
                    onSettled={() => dismissal.clearDismissed(patternId, true)}
                    className="shrink-0"
                  />
                ) : null}
              </div>
              <p className="text-muted-foreground text-xs">
                {t(
                  row.inverse
                    ? "insights.mood.factorCrosstab.detailInverse"
                    : "insights.mood.factorCrosstab.detail",
                  {
                    factor: factorLabel,
                    metric: metricLabel,
                    lowAvg: formatValue(conv(row.lowAvg), row.display, nf),
                    highAvg: formatValue(conv(row.highAvg), row.display, nf),
                    unit,
                    lowDays: row.lowDays,
                  },
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
