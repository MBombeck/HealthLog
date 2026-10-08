"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "@/components/mood/mood-tag-icons";

/**
 * v1.8.5 — structured-tag breakdown.
 *
 * Ranked icon-bearing rows over the taxonomy tags the user picked,
 * grouped under their category, with the per-tag average mood ("lift")
 * as a coloured score. Distinct from the flat free-text breakdown:
 * structured tags carry icons + categories from the curated catalog.
 */

export interface MoodStructuredTagRow {
  key: string;
  categoryKey: string;
  labelKey: string;
  /**
   * v1.16.11 — decrypted custom-tag label, resolved server-side. A custom
   * tag's `labelKey` mirrors its raw `custom:<uuid>` key, so the label
   * takes precedence over `t(labelKey)`. Null for catalogue tags.
   */
  label?: string | null;
  icon: string | null;
  count: number;
  avgScore: number;
}

function colorForScore(score: number): string {
  if (score < 2) return "var(--dracula-red)";
  if (score < 3) return "var(--dracula-orange)";
  if (score < 3.5) return "var(--dracula-yellow)";
  return "var(--dracula-green)";
}

export function MoodStructuredTagBreakdown({
  tags,
}: {
  tags: MoodStructuredTagRow[];
}) {
  const { t } = useTranslations();
  const nf = useFormatters();
  const maxCount = tags.reduce((m, row) => Math.max(m, row.count), 0) || 1;

  return (
    <ul className="space-y-2" data-slot="mood-structured-tag-breakdown">
      {tags.map((row) => {
        const Icon = moodTagIcon(row.icon);
        return (
          <li key={row.key} className="flex items-center gap-2 text-sm">
            <Icon
              className="text-muted-foreground h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span className="text-foreground w-28 shrink-0 truncate">
              {row.label ?? t(row.labelKey)}
            </span>
            <div className="bg-secondary relative h-3 flex-1 overflow-hidden rounded-full">
              {/* v1.19.0 — full-saturation fill, matching the mood Recharts
                  bars (the earlier muted tint read as a rendering glitch). */}
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${(row.count / maxCount) * 100}%`,
                  backgroundColor: colorForScore(row.avgScore),
                }}
              />
            </div>
            <span className="text-muted-foreground w-6 shrink-0 text-right tabular-nums">
              {row.count}
            </span>
            <span
              className="w-10 shrink-0 text-right text-xs font-medium tabular-nums"
              style={{ color: colorForScore(row.avgScore) }}
              title={t("insights.mood.tagAvgMood")}
            >
              {nf.number(row.avgScore, 1)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
