"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useFormatters, useTranslations } from "@/lib/i18n/context";

/**
 * v1.8.5 — average mood per weekday (Monday-aligned).
 *
 * One bar per weekday over the average daily-mean mood, with the
 * best/worst day called out below the chart. Empty weekdays (no data)
 * render as a zero-height bar so the seven-column rhythm stays intact.
 */

export interface MoodWeekdayRow {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  avgScore: number | null;
  count: number;
}

const WEEKDAY_LABEL_KEYS = [
  "charts.weekdaysFull.mon",
  "charts.weekdaysFull.tue",
  "charts.weekdaysFull.wed",
  "charts.weekdaysFull.thu",
  "charts.weekdaysFull.fri",
  "charts.weekdaysFull.sat",
  "charts.weekdaysFull.sun",
] as const;

// v1.28.17 — semantic tokens, not raw `--dracula-*` primitives (see
// mood-distribution-chart's `BAR_COLOR_BY_SCORE` for the same swap).
function colorForScore(score: number): string {
  if (score < 2) return "var(--destructive)";
  if (score < 3) return "var(--warning)";
  if (score < 3.5) return "var(--dracula-yellow)";
  return "var(--success)";
}

export function MoodWeekdayChart({ weekday }: { weekday: MoodWeekdayRow[] }) {
  const { t } = useTranslations();
  const nf = useFormatters();

  const data = weekday.map((row) => ({
    weekday: row.weekday,
    label: t(WEEKDAY_LABEL_KEYS[row.weekday]),
    value: row.avgScore ?? 0,
    avgScore: row.avgScore,
    count: row.count,
  }));

  const { best, worst } = useMemo(() => {
    const populated = weekday.filter(
      (r): r is MoodWeekdayRow & { avgScore: number } => r.avgScore != null,
    );
    if (populated.length === 0) return { best: null, worst: null };
    let bestRow = populated[0];
    let worstRow = populated[0];
    for (const row of populated) {
      if (row.avgScore > bestRow.avgScore) bestRow = row;
      if (row.avgScore < worstRow.avgScore) worstRow = row;
    }
    return { best: bestRow, worst: worstRow };
  }, [weekday]);

  return (
    <div className="space-y-2">
      {/* v1.15.14 — bounded compact height (was `aspect-[3/2] min-h-[160px]`,
          which derived its height off the full card width and ballooned on a
          wide viewport). A fixed band keeps it a tidy card matching the
          distribution sibling. */}
      <div className="h-[clamp(120px,26vh,150px)] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
          >
            <XAxis
              dataKey="label"
              // v1.15.14 — theme-aware axis text (see mood-distribution-chart).
              // `--dracula-fg` was white-on-white on the light-mode card; switch
              // to the shared `--muted-foreground` axis-tick token. Bar mood
              // hues route through semantic tokens (see `colorForScore`);
              // dark mode is unchanged.
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              stroke="var(--muted-foreground)"
              interval={0}
            />
            <YAxis
              domain={[1, 5]}
              ticks={[1, 2, 3, 4, 5]}
              // v1.15.14 — theme-aware axis text (see mood-distribution-chart).
              // `--dracula-fg` was white-on-white on the light-mode card; switch
              // to the shared `--muted-foreground` axis-tick token. Bar mood
              // hues route through semantic tokens (see `colorForScore`);
              // dark mode is unchanged.
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              stroke="var(--muted-foreground)"
              width={24}
            />
            {/* v1.15.14 — calmer target guide: a muted comment-grey dashed
                line instead of the bright green, so it reads as a quiet
                reference rather than competing with the bars. */}
            <ReferenceLine
              y={3.5}
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
              strokeOpacity={0.6}
            />
            <Tooltip
              cursor={{ fill: "var(--secondary)", opacity: 0.4 }}
              contentStyle={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                fontSize: "0.75rem",
              }}
              itemStyle={{ color: "var(--foreground)" }}
              labelStyle={{ color: "var(--foreground)" }}
              formatter={(_value, _name, item) => {
                const payload = item?.payload as
                  { avgScore: number | null; count: number } | undefined;
                if (!payload || payload.avgScore == null) {
                  return [t("insights.mood.weekdayNoData"), ""];
                }
                return [
                  `${nf.number(payload.avgScore, 1)} (${payload.count})`,
                  t("insights.mood.weekdayTitle"),
                ];
              }}
            />
            {/* v1.19.0 — bars paint at full saturation in their level colour;
                the earlier muted tint read as a rendering glitch. */}
            <Bar dataKey="value" radius={[3, 3, 0, 0]}>
              {data.map((row) => (
                <Cell
                  key={row.weekday}
                  fill={
                    row.avgScore == null
                      ? "var(--secondary)"
                      : colorForScore(row.avgScore)
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {best && worst && (
        <p className="text-muted-foreground text-xs">
          {t("insights.mood.weekdayBestWorst", {
            best: t(WEEKDAY_LABEL_KEYS[best.weekday]),
            worst: t(WEEKDAY_LABEL_KEYS[worst.weekday]),
          })}
        </p>
      )}
    </div>
  );
}
