"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "@/components/mood/mood-tag-icons";
import { cn } from "@/lib/utils";
import type { MoodInfluenceConfidence } from "./mood-tag-influence";

/**
 * v1.11.5 (F2) — "What's associated with your better days" board.
 *
 * One ranked, confidence-gated list folding the F1 tag deltas and the
 * mood × health-metric correlations into a single effect-size-ranked
 * surface — the headline "relations" answer to "what goes with my good
 * days?". The merge + ranking is pre-computed in `mood-aggregates.ts`
 * (`computeBetterDays`); this component only paints. Observational only;
 * the standing "describes your own data, not a diagnosis" disclaimer lives
 * once in the page-level Insights footer, not on this board.
 */

export interface MoodBetterDayFactor {
  source: "tag" | "metric";
  key: string;
  labelKey: string | null;
  /**
   * v1.16.11 — decrypted custom-tag label, resolved server-side. A custom
   * tag's `labelKey` mirrors its raw `custom:<uuid>` key, so the label
   * takes precedence over `t(labelKey)`. Null for catalogue / flat /
   * metric rows.
   */
  label?: string | null;
  categoryKey: string | null;
  icon: string | null;
  direction: "up" | "down";
  n: number;
  confidence: MoodInfluenceConfidence;
  effectSize: number;
  delta: number | null;
  r: number | null;
}

const METRIC_LABEL_KEY: Record<string, string> = {
  sleep: "insights.mood.correlation.sleepTitle",
  steps: "insights.mood.correlation.stepsTitle",
  pulse: "insights.mood.correlation.pulseTitle",
  weight: "insights.mood.correlation.weightTitle",
  bloodPressureSystolic: "insights.mood.correlation.bloodPressureTitle",
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

export function MoodBetterDays({
  factors,
}: {
  factors: MoodBetterDayFactor[];
}) {
  const { t } = useTranslations();
  const nf = useFormatters();
  if (factors.length === 0) return null;

  return (
    <div data-slot="mood-better-days">
      <p className="text-foreground mb-2 text-sm">
        {t("insights.mood.betterDays.description")}
      </p>
      <ul className="divide-border divide-y">
        {factors.map((factor) => {
          const up = factor.direction === "up";

          let label: string;
          let Icon: ReturnType<typeof moodTagIcon> | null = null;
          if (factor.source === "metric") {
            label = t(METRIC_LABEL_KEY[factor.key] ?? factor.key);
          } else if (factor.label) {
            // Custom tag — render the decrypted label verbatim (its
            // labelKey is the raw `custom:<uuid>` key).
            label = factor.label;
            Icon = moodTagIcon(factor.icon);
          } else if (factor.labelKey) {
            label = t(factor.labelKey);
            Icon = moodTagIcon(factor.icon);
          } else {
            label = factor.key;
          }

          const DirectionIcon = up ? ArrowUpRight : ArrowDownRight;
          // Semantic feedback tokens (not raw `--dracula-*`): the effect
          // read-out is COLORED TEXT, so it needs the Alucard light-mode
          // override to clear AA. The arrow icon shares the same token so the
          // good→down ramp stays coherent across both themes.
          const directionColor = up ? "var(--success)" : "var(--destructive)";

          // The effect read-out: tag factors show the mood-point delta,
          // metric factors show the correlation coefficient.
          const effectText =
            factor.source === "tag" && factor.delta != null
              ? `${factor.delta >= 0 ? "+" : ""}${nf.number(factor.delta, 1)}`
              : factor.r != null
                ? `r ${nf.number(factor.r, 2)}`
                : "";

          return (
            <li
              key={`${factor.source}:${factor.key}`}
              className="flex items-center gap-2 py-2 text-sm"
              data-slot="mood-better-day-factor"
              data-source={factor.source}
              data-direction={factor.direction}
              data-confidence={factor.confidence}
            >
              <DirectionIcon
                className="h-4 w-4 shrink-0"
                style={{ color: directionColor }}
                aria-hidden="true"
              />
              {Icon && (
                <Icon
                  className="text-muted-foreground h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
              )}
              <span
                className="text-foreground min-w-0 flex-1 truncate"
                title={label}
              >
                {label}
              </span>
              <span
                className="shrink-0 text-xs font-semibold tabular-nums"
                style={{ color: directionColor }}
              >
                {effectText}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                  CONFIDENCE_CLASS[factor.confidence],
                )}
              >
                {t(CONFIDENCE_KEY[factor.confidence])}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
