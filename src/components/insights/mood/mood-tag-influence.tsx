"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "@/components/mood/mood-tag-icons";
import { cn } from "@/lib/utils";

/**
 * v1.11.5 (F1) — tag "Influence on Mood".
 *
 * For each frequent flat / structured tag, the average daily mood on days
 * the tag is PRESENT vs the counterfactual baseline of days it is ABSENT,
 * the delta, and a confidence chip. The math is pre-computed in
 * `mood-aggregates.ts` (shared with the LLM snapshot), gated on per-group
 * sample floors — sparse tags never reach here. Observational only: the
 * generic "associations, not causes" caveat lives once in the page-level
 * Insights footer, so this list no longer repeats it.
 */

export type MoodInfluenceConfidence = "low" | "medium" | "high";

export interface MoodTagInfluenceRow {
  tag: string;
  labelKey: string | null;
  /**
   * v1.16.11 — decrypted custom-tag label, resolved server-side. A custom
   * tag's `labelKey` mirrors its raw `custom:<uuid>` key, so the label
   * takes precedence over `t(labelKey)`. Null for catalogue / flat tags.
   */
  label?: string | null;
  categoryKey: string | null;
  icon: string | null;
  withDays: number;
  withoutDays: number;
  withAvg: number;
  withoutAvg: number;
  delta: number;
  pValue: number;
  confidence: MoodInfluenceConfidence;
}

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

// Semantic feedback tokens (not raw `--dracula-*`): the delta read-out is
// COLORED TEXT, so it needs the Alucard light-mode override to clear AA.
function deltaColor(delta: number): string {
  return delta >= 0 ? "var(--success)" : "var(--destructive)";
}

export function MoodTagInfluence({ rows }: { rows: MoodTagInfluenceRow[] }) {
  const { t } = useTranslations();
  const nf = useFormatters();
  if (rows.length === 0) return null;

  return (
    <div data-slot="mood-tag-influence">
      <ul className="divide-border divide-y">
        {rows.map((row) => {
          const Icon = row.labelKey ? moodTagIcon(row.icon) : null;
          const label = row.label ?? (row.labelKey ? t(row.labelKey) : row.tag);
          const up = row.delta >= 0;
          const deltaText = `${up ? "+" : ""}${nf.number(row.delta, 1)}`;
          return (
            <li
              key={`${row.labelKey ?? "flat"}:${row.tag}`}
              className="flex flex-col gap-1.5 py-2"
              data-slot="mood-influence-row"
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
                  title={label}
                >
                  {label}
                </span>
                <span
                  className="shrink-0 text-sm font-semibold tabular-nums"
                  style={{ color: deltaColor(row.delta) }}
                >
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
              </div>
              <p className="text-muted-foreground text-xs">
                {t("insights.mood.influence.detail", {
                  withAvg: nf.number(row.withAvg, 1),
                  withoutAvg: nf.number(row.withoutAvg, 1),
                  withDays: row.withDays,
                })}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
