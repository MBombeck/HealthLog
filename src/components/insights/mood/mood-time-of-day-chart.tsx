"use client";

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
 * v1.9.0 — average mood per part of day.
 *
 * Four bars (morning / afternoon / evening / night) over the average
 * mood logged in each part of the user's local day. The buckets are
 * computed server-side in each entry's own timezone and gated on a
 * spread floor (`reliable`); the parent only mounts this chart when the
 * pattern is trustworthy, so a once-a-day logger never sees a misleading
 * single bar dressed up as a daypart preference. Empty buckets render as
 * a muted zero-height bar so the four-column rhythm stays intact.
 */

export type MoodTimeOfDayBucket = "morning" | "afternoon" | "evening" | "night";

export interface MoodTimeOfDayRow {
  bucket: MoodTimeOfDayBucket;
  avgScore: number | null;
  count: number;
}

export interface MoodTimeOfDayPattern {
  buckets: MoodTimeOfDayRow[];
  reliable: boolean;
  best: MoodTimeOfDayBucket | null;
  worst: MoodTimeOfDayBucket | null;
}

const LABEL_KEYS: Record<MoodTimeOfDayBucket, string> = {
  morning: "insights.mood.timeOfDay.morning",
  afternoon: "insights.mood.timeOfDay.afternoon",
  evening: "insights.mood.timeOfDay.evening",
  night: "insights.mood.timeOfDay.night",
};

// v1.28.17 — semantic tokens, not raw `--dracula-*` primitives (see
// mood-distribution-chart's `BAR_COLOR_BY_SCORE` for the same swap).
function colorForScore(score: number): string {
  if (score < 2) return "var(--destructive)";
  if (score < 3) return "var(--warning)";
  if (score < 3.5) return "var(--dracula-yellow)";
  return "var(--success)";
}

export function MoodTimeOfDayChart({
  pattern,
}: {
  pattern: MoodTimeOfDayPattern;
}) {
  const { t } = useTranslations();
  const nf = useFormatters();

  const data = pattern.buckets.map((row) => ({
    bucket: row.bucket,
    label: t(LABEL_KEYS[row.bucket]),
    value: row.avgScore ?? 0,
    avgScore: row.avgScore,
    count: row.count,
  }));

  const bestLabel = pattern.best ? t(LABEL_KEYS[pattern.best]) : null;

  return (
    <div className="space-y-2">
      {/* A fixed height, not `aspect-[3/2]`: this card spans the full overview
          width (its weekday/distribution siblings sit in a 2-col grid and are
          width-constrained), so an aspect ratio derived the height off the full
          card width and ballooned the chart to ~800px on a wide viewport. A
          bounded height keeps it the same size as the sibling charts. */}
      <div className="h-[clamp(160px,38vh,220px)] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 8, left: 0 }}
          >
            {/* Quiet chart language — `--muted-foreground` axis ticks and a
                comment-grey target guide. The bars themselves render at full
                saturation (v1.19.1) so the mood level hues read clearly. */}
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              stroke="var(--muted-foreground)"
              interval={0}
            />
            <YAxis
              domain={[1, 5]}
              ticks={[1, 2, 3, 4, 5]}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              stroke="var(--muted-foreground)"
              width={24}
            />
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
                  t("insights.mood.timeOfDay.title"),
                ];
              }}
            />
            {/* v1.19.1 — populated buckets render at full saturation so the
                level hues read clearly; only the no-data buckets keep the quiet
                `--secondary` empty-state tint. */}
            <Bar dataKey="value" radius={[3, 3, 0, 0]}>
              {data.map((row) => (
                <Cell
                  key={row.bucket}
                  fill={
                    row.avgScore == null
                      ? "var(--secondary)"
                      : colorForScore(row.avgScore)
                  }
                  fillOpacity={row.avgScore == null ? 0.55 : 1}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {bestLabel && (
        <p className="text-muted-foreground text-xs">
          {t("insights.mood.timeOfDay.bestCaption", { bucket: bestLabel })}
        </p>
      )}
    </div>
  );
}
