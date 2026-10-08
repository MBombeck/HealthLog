"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";

/**
 * v1.8.5 — tag / trigger breakdown.
 *
 * Ranked horizontal bars over tag frequency, with the per-tag average
 * mood ("lift") rendered as a coloured score chip. The aggregation comes
 * pre-computed from `/api/mood/insights` (shared with the LLM snapshot's
 * tag block, so the prose and the chart agree). Works on the flat
 * free-text tag array we hold today — the structured-tag taxonomy with
 * icons is a separate later piece.
 */

export interface MoodTagRow {
  tag: string;
  count: number;
  avgScore: number;
}

// v1.28.17 — semantic tokens, not raw `--dracula-*` primitives (see
// mood-distribution-chart's `BAR_COLOR_BY_SCORE` for the same swap).
function colorForScore(score: number): string {
  if (score < 2) return "var(--destructive)";
  if (score < 3) return "var(--warning)";
  if (score < 3.5) return "var(--dracula-yellow)";
  return "var(--success)";
}

export function MoodTagBreakdown({ tags }: { tags: MoodTagRow[] }) {
  const { t } = useTranslations();
  const nf = useFormatters();
  const maxCount = tags.reduce((m, row) => Math.max(m, row.count), 0) || 1;

  return (
    <ul className="space-y-2" data-slot="mood-tag-breakdown">
      {tags.map((row) => (
        <li key={row.tag} className="flex items-center gap-2 text-sm">
          <span
            className="text-foreground w-28 shrink-0 truncate"
            title={row.tag}
          >
            {row.tag}
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
      ))}
    </ul>
  );
}
