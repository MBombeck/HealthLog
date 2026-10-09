"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { Formatters } from "@/lib/format-locale";
import { moodTagIcon } from "@/components/mood/mood-tag-icons";
import { cn } from "@/lib/utils";
import type { MoodInfluenceConfidence } from "./mood-tag-influence";
import {
  PatternDismissButton,
  PatternDismissedNotice,
  usePatternDismissalOverrides,
} from "@/components/insights/pattern-dismiss-action";

/**
 * v1.12.0 — tag × health-metric crosstab card.
 *
 * Daylio's "Activities & Mood" board, extended from mood to a health
 * METRIC: for each structured mood tag, a metric's mean on tag-present vs
 * tag-absent days, the delta, and a confidence chip. The math is
 * pre-computed in `mood-aggregates.ts` (`computeTagMetricCrosstab`) — the
 * same Welch t-test + day floors + Benjamini-Hochberg FDR the rest of the
 * relations surface uses; only FDR-surviving rows reach here. Observational
 * only: the generic "associations, not causes" caveat lives once in the
 * page-level Insights footer, so this card no longer repeats it.
 *
 * The delta read-out is NEUTRAL, matching the rated-factor board. Once the
 * board carries next-day resting heart rate alongside sleep and active energy,
 * a positive delta is good on one row and bad on the next, so a green/red
 * sign would assert a health verdict the association does not support. The
 * sign prefix and `data-direction` carry the direction instead.
 */

export type MoodCrosstabDisplay = "hours" | "kcal" | "score" | "bpm" | "ms";
export type MoodCrosstabMode = "sameDay" | "nextDay";

export interface MoodTagMetricCrosstabRow {
  tag: string;
  labelKey: string;
  /**
   * v1.16.11 — decrypted custom-tag label, resolved server-side. A custom
   * tag's `labelKey` mirrors its raw `custom:<uuid>` key, so the label
   * takes precedence over `t(labelKey)`. Null for catalogue tags.
   */
  label?: string | null;
  categoryKey: string;
  icon: string | null;
  metricKey: string;
  display: MoodCrosstabDisplay;
  mode: MoodCrosstabMode;
  withDays: number;
  withoutDays: number;
  withAvg: number;
  withoutAvg: number;
  delta: number;
  pValue: number;
  qValue: number;
  confidence: MoodInfluenceConfidence;
  patternId?: string;
  canonicalKey?: string;
  dismissed?: boolean;
}

const METRIC_LABEL_KEY: Record<string, string> = {
  activeEnergy: "insights.mood.crosstab.metricActiveEnergy",
  sleepDuration: "insights.mood.crosstab.metricSleepDuration",
  nextDayRecovery: "insights.mood.crosstab.metricNextDayRecovery",
  nextDayRestingHeartRate: "insights.mood.crosstab.metricNextDayRestingHr",
  nextDayHeartRateVariability: "insights.mood.crosstab.metricNextDayHrv",
};

const UNIT_KEY: Record<MoodCrosstabDisplay, string> = {
  hours: "insights.mood.crosstab.unitHours",
  kcal: "insights.mood.crosstab.unitKcal",
  score: "insights.mood.crosstab.unitScore",
  bpm: "insights.mood.crosstab.unitBpm",
  ms: "insights.mood.crosstab.unitMs",
};

const CONFIDENCE_KEY: Record<MoodInfluenceConfidence, string> = {
  low: "insights.mood.influence.confidenceLow",
  medium: "insights.mood.influence.confidenceMedium",
  high: "insights.mood.influence.confidenceHigh",
};

// Confidence chips carry COLORED TEXT, so they ride the semantic feedback
// tokens (`--info` / `--success`) — these carry the Alucard light-mode
// overrides that clear AA on the white card. Raw `--dracula-*` stays bright
// green/cyan in light mode and fails AA for text.
const CONFIDENCE_CLASS: Record<MoodInfluenceConfidence, string> = {
  low: "bg-secondary text-muted-foreground",
  medium: "bg-info/15 text-info",
  high: "bg-success/15 text-success",
};

/** One decimal for hours/score, whole numbers for kcal. */
function formatValue(
  value: number,
  display: MoodCrosstabDisplay,
  nf: Formatters,
): string {
  return display === "kcal" ? nf.integer(value) : nf.number(value, 1);
}

export function MoodTagMetricCrosstab({
  rows,
}: {
  rows: MoodTagMetricCrosstabRow[];
}) {
  const { t } = useTranslations();
  const nf = useFormatters();
  const dismissal = usePatternDismissalOverrides();
  if (rows.length === 0) return null;

  return (
    <div data-slot="mood-tag-metric-crosstab">
      <p className="text-muted-foreground mb-2 text-sm">
        {t("insights.mood.crosstab.description")}
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
          const tagLabel = row.label ?? t(row.labelKey);
          const metricLabel = t(
            METRIC_LABEL_KEY[row.metricKey] ?? row.metricKey,
          );
          const pairLabel = t("insights.mood.crosstab.pairLabel", {
            tag: tagLabel,
            metric: metricLabel,
          });
          const unit = t(UNIT_KEY[row.display]);
          const up = row.delta >= 0;
          const deltaText = `${up ? "+" : ""}${formatValue(row.delta, row.display, nf)} ${unit}`;
          return (
            <li
              key={`${row.metricKey}:${row.tag}`}
              className="flex flex-col gap-1.5 py-2"
              data-slot="mood-crosstab-row"
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
                  row.mode === "nextDay"
                    ? "insights.mood.crosstab.detailNextDay"
                    : "insights.mood.crosstab.detailSameDay",
                  {
                    withAvg: formatValue(row.withAvg, row.display, nf),
                    withoutAvg: formatValue(row.withoutAvg, row.display, nf),
                    unit,
                    withDays: row.withDays,
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
