"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.25 W4c — sleep-stage composition chart.
 *
 * Renders the trailing 30-day stage distribution as a horizontal
 * stacked bar (REM / Deep / Core / Awake / In-bed / Asleep). The
 * underlying data comes from `/api/analytics`'s `sleepStages` payload
 * (added in v1.4.23 W2) which exposes the per-stage minute totals plus
 * the number of nights covered, so the legend can read "averaged
 * across N nights".
 *
 * Why composition over per-night time series? The current
 * `/api/analytics` aggregate only carries totals; a per-night stacked
 * column chart would need a separate endpoint. The "average night"
 * read is the dominant question users ask of stage data — see
 * Apple Health's own sleep tab, which shows the same composition
 * column above the trend chart. v1.4.26 can add the per-night surface
 * if Marc wants it.
 *
 * Accessibility: the Recharts wrapper sets `role="img"` and an
 * `aria-label` derived from the composition so screen readers hear a
 * meaningful summary instead of a forest of `<rect>` elements.
 */

export interface SleepStageBreakdown {
  windowDays: number;
  nights: number;
  totalMinutes: number;
  /**
   * Keys mirror the Prisma `SleepStage` enum:
   *   IN_BED, AWAKE, ASLEEP, REM, CORE, DEEP.
   * Values are total minutes across the trailing-30 window.
   */
  stages: Record<string, number>;
}

export interface SleepStageStackedBarProps {
  breakdown: SleepStageBreakdown;
}

/**
 * Order on the stack — deepest restorative stages first so a user
 * scanning left → right reads quality before context.
 */
const STAGE_ORDER = [
  "DEEP",
  "REM",
  "CORE",
  "ASLEEP",
  "AWAKE",
  "IN_BED",
] as const;

const STAGE_COLORS: Record<string, string> = {
  DEEP: "#bd93f9", // dracula-purple — deepest, most restorative
  REM: "#ff79c6", // dracula-pink — dream phase
  CORE: "#8be9fd", // dracula-cyan — bulk of sleep
  ASLEEP: "#50fa7b", // dracula-green — legacy iOS 15- unspecified
  AWAKE: "#f1fa8c", // dracula-yellow — wake bouts
  IN_BED: "#6272a4", // dracula-comment — pre-asleep
};

function formatMinutes(total: number, locale: string): string {
  const hours = Math.floor(total / 60);
  const mins = Math.round(total - hours * 60);
  if (locale === "de") {
    return hours > 0 ? `${hours} Std. ${mins} Min.` : `${mins} Min.`;
  }
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

export function SleepStageStackedBar({ breakdown }: SleepStageStackedBarProps) {
  const { t, locale } = useTranslations();
  const total = breakdown.totalMinutes || 1; // avoid divide-by-zero
  // Build a single-row dataset Recharts can stack on. Each stage is its
  // own series so the user can hover one stage at a time.
  const row: Record<string, number | string> = {
    name: t("insights.sleep.compositionTitle"),
  };
  for (const stage of STAGE_ORDER) {
    row[stage] = breakdown.stages[stage] ?? 0;
  }
  const data = [row];

  // Pull stage names from i18n once so the legend + tooltip share a
  // single source of truth. Missing keys fall back to the enum value
  // — covers `ASLEEP`/`IN_BED` which we always want to show even when
  // no localization exists yet.
  const stageLabels: Record<string, string> = {
    DEEP: t("insights.sleep.stages.deep"),
    REM: t("insights.sleep.stages.rem"),
    CORE: t("insights.sleep.stages.core"),
    ASLEEP: t("insights.sleep.stages.asleep"),
    AWAKE: t("insights.sleep.stages.awake"),
    IN_BED: t("insights.sleep.stages.inBed"),
  };

  const ariaLabel = t("insights.sleep.compositionAriaLabel", {
    nights: breakdown.nights,
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            {t("insights.sleep.compositionTitle")}
          </CardTitle>
          <span className="text-muted-foreground text-xs">
            {t("insights.sleep.compositionSubtitle", {
              nights: breakdown.nights,
            })}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div role="img" aria-label={ariaLabel}>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 8, right: 16, left: 16, bottom: 8 }}
              stackOffset="expand"
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                opacity={0.3}
              />
              <XAxis
                type="number"
                domain={[0, 1]}
                tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
              />
              <YAxis type="category" dataKey="name" hide />
              <Tooltip
                cursor={{ fill: "transparent" }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  return (
                    <div className="bg-popover text-popover-foreground rounded-md border p-2 text-xs shadow-md">
                      {payload.map((entry) => {
                        const stage = String(entry.dataKey ?? "");
                        const minutes =
                          typeof entry.value === "number" ? entry.value : 0;
                        if (minutes === 0) return null;
                        const pct = Math.round((minutes / total) * 100);
                        return (
                          <div
                            key={stage}
                            className="flex items-center justify-between gap-3"
                          >
                            <span className="flex items-center gap-1.5">
                              <span
                                aria-hidden="true"
                                className="inline-block h-2 w-2 rounded-sm"
                                style={{ background: STAGE_COLORS[stage] }}
                              />
                              {stageLabels[stage] ?? stage}
                            </span>
                            <span className="text-muted-foreground">
                              {formatMinutes(minutes, locale)} · {pct}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(value: string) => stageLabels[value] ?? value}
              />
              {STAGE_ORDER.map((stage) => (
                <Bar
                  key={stage}
                  dataKey={stage}
                  stackId="sleep"
                  fill={STAGE_COLORS[stage]}
                  isAnimationActive={false}
                >
                  <Cell fill={STAGE_COLORS[stage]} />
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
