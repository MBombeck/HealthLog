"use client";

import { useState, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { ChartDataTable } from "@/components/charts/chart-data-table";
import {
  ChartDayFooter,
  OPEN_DAY_LINE,
  dayAnchor,
  useChartDayLinks,
} from "@/components/day/chart-day-links";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";

/**
 * v1.4.25 W4c → W3f — sleep-stage composition chart.
 *
 * The maintainer directive 2026-05-14: switch from "30-day average composition"
 * to a per-night stacked column chart so the user sees nightly stage
 * variation, not just a rolling average. Apple Health's sleep tab is
 * the visual reference — one column per night, stacks for REM / Deep /
 * Core / Awake.
 *
 * Window toggle: 7 / 14 / 30 days, default 7. The toggle pill above
 * the chart matches the per-chart cog pattern in the rest of the app.
 * Backed by `/api/analytics`'s `sleepStages.perNight` field (added in
 * v1.4.25 W3f); the parent threads the full per-night array and the
 * chart slices it down to the active window.
 *
 * Accessibility: the Recharts wrapper sets `role="img"` and an
 * `aria-label` derived from the composition so screen readers hear a
 * meaningful summary instead of a forest of `<rect>` elements.
 */

export interface SleepStageNight {
  /** Berlin-tz day key (YYYY-MM-DD). */
  dayKey: string;
  /** Per-stage minutes of the MAIN night. Naps are not in here. */
  stages: Record<string, number>;
  /**
   * Time asleep across this day's naps, in minutes. Absent on a day with no
   * nap, which is most days — the chart draws nothing for it and the legend
   * does not carry a nap entry.
   */
  napMinutes?: number;
  /** How many naps that is. Absent alongside `napMinutes`. */
  napCount?: number;
}

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
  /**
   * v1.4.25 W3f — per-night breakdown over the trailing 30 days,
   * sorted ascending. The chart slices the trailing N entries based on
   * the active window toggle.
   */
  perNight?: SleepStageNight[];
}

export interface SleepStageStackedBarProps {
  breakdown: SleepStageBreakdown;
}

/** Window toggle values. Default 7. */
const WINDOW_DAYS = [7, 14, 30] as const;
type WindowSize = (typeof WINDOW_DAYS)[number];

/**
 * Order on the stack — deepest restorative stages first so a user
 * scanning left → right reads quality before context.
 *
 * IN_BED is deliberately NOT a stack segment. It is the TOTAL time in
 * bed (≈ CORE + DEEP + REM + AWAKE), so stacking it on top of those
 * phases doubled every bar (~14 h for a 7 h night) and inflated the
 * tooltip's per-night total. With it out of the stack the bar height
 * and the tooltip total are the real night. The `STAGE_COLORS.IN_BED`
 * token + the `insights.sleep.stages.inBed` label survive for the
 * last-night hypnogram, which still renders the in-bed span.
 */
export const STAGE_ORDER = ["DEEP", "REM", "CORE", "ASLEEP", "AWAKE"] as const;

/**
 * The nap band. Not a sleep stage — it is the day's daytime sleep, kept out
 * of the night's stage buckets and drawn as its own block on top of the
 * column so the night below it reads as the night.
 *
 * The band is only rendered when the visible window actually holds a nap. On
 * a week without one there is no bar, no legend entry, and no tooltip row.
 */
const NAP_KEY = "NAP";

/**
 * The nap band is drawn with a card-coloured outline, and that outline is
 * load-bearing rather than decoration.
 *
 * No flat fill can carry this on its own. To clear the 3:1 that WCAG 1.4.11
 * asks between adjacent graphical objects, a nap colour would have to beat
 * all five stage colours AND the card it sits on. In the dark theme the five
 * stages span luminance 0.385–0.890, which forces the nap below 0.095, while
 * clearing the card (0.014) forces it above 0.143 — no value satisfies both.
 * The light theme is the same bind mirrored: the stages sit at 0.088–0.161,
 * forcing the nap above 0.583, while the card (0.966) forces it below 0.289.
 * Both are empty ranges, so this is arithmetic, not a shortage of tokens.
 *
 * A separator is the sanctioned way out, and it measures comfortably:
 *
 *            stroke vs  DEEP   REM   CORE  ASLEEP  AWAKE   nap fill
 *   dark             6.78  6.86  11.82  11.92  14.65      9.60
 *   light            6.04  7.37   5.80   5.90   4.81      5.60
 *
 * Lowest pair 4.81:1, against a light-theme wake bout — the neighbour the
 * nap most often lands on, since AWAKE is the top of the stage stack.
 *
 * The stage tokens themselves are untouched; they are shared with the
 * hypnogram and the charts-visual-identity rule keeps them put.
 */
const NAP_SEPARATOR = {
  stroke: "var(--card)",
  strokeWidth: 2,
} as const;

/**
 * Dracula stage palette. Exported so the last-night hypnogram
 * (`sleep-hypnogram.tsx`) reuses the exact same tokens — per the
 * charts-visual-identity rule, no token reshuffle.
 */
export const STAGE_COLORS: Record<string, string> = {
  DEEP: "var(--chart-1)", // dracula-purple — deepest, most restorative
  REM: "var(--chart-3)", // dracula-pink — dream phase
  CORE: "var(--info)", // dracula-cyan — bulk of sleep
  ASLEEP: "var(--success)", // dracula-green — legacy iOS 15- unspecified
  AWAKE: "var(--dracula-yellow)", // dracula-yellow — wake bouts
  IN_BED: "var(--chart-inbed)", // muted blue-grey — pre-asleep
  [NAP_KEY]: "var(--dracula-orange)", // daytime sleep, not a night stage
};

/**
 * Format a Berlin-tz day key (YYYY-MM-DD) as a short x-axis tick.
 * 7-day window → "Mon" / "Tue" / …; 14-day → "M 10" / "T 11" / …;
 * 30-day → "May 10" / "May 11" / …  Recharts handles overflow via
 * interval=preserveStartEnd so we keep the label space tight without
 * forced rotation.
 *
 * The constructed Date is anchored to UTC so the rendered tick is
 * stable regardless of the SSR server's local timezone — without the
 * anchor a user in Asia/Tokyo viewing a server rendered in
 * Europe/Berlin could see the weekday tick shift by one. We pair the
 * UTC anchor with `timeZone: "UTC"` on the locale formatter so both
 * sides of the conversion agree.
 */
function formatDayTick(
  dayKey: string,
  window: WindowSize,
  locale: Locale,
): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (window === 7) {
    return date.toLocaleDateString(resolveIntlLocale(locale), {
      timeZone: "UTC",
      weekday: "short",
    });
  }
  if (window === 14) {
    return `${date.getUTCDate()}.`;
  }
  return date.toLocaleDateString(resolveIntlLocale(locale), {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

/** One Recharts row: the day's label plus a numeric key per drawn band. */
export type CompositionRow = Record<string, number | string>;

/**
 * Turn the trailing window of nights into the chart's rows.
 *
 * A day without a nap gets a plain `NAP: 0`, which draws as nothing. Pulled
 * out of the component because Recharts renders no markup under SSR, so this
 * is the only place the nap decision can actually be pinned by a test.
 */
export function buildCompositionRows(
  perNight: readonly SleepStageNight[],
  windowDays: number,
  formatLabel: (dayKey: string) => string,
): { rows: CompositionRow[] } {
  const trailing = perNight.slice(-windowDays);
  const rows = trailing.map((night) => {
    const row: CompositionRow = {
      dayKey: night.dayKey,
      label: formatLabel(night.dayKey),
    };
    for (const stage of STAGE_ORDER) {
      row[stage] = night.stages[stage] ?? 0;
    }
    row[NAP_KEY] = night.napMinutes ?? 0;
    row.napCount = night.napCount ?? 0;
    return row;
  });
  return { rows };
}

/**
 * Whether the visible window holds a nap at all. When it does not, the nap
 * band is never mounted — so there is no bar, no legend entry, and no tooltip
 * row saying a nap did not happen.
 */
export function windowHasNap(rows: readonly CompositionRow[]): boolean {
  return rows.some(
    (row) => typeof row[NAP_KEY] === "number" && (row[NAP_KEY] as number) > 0,
  );
}

/**
 * Totals for one hovered column, split the way the tooltip reports them.
 *
 * `nightMinutes` is the sum of the stacked stage bands — the main session
 * only, the same figure the column draws and the per-stage percentages
 * divide by. `napMinutes` is the day's inferred naps. `dayMinutes` is the
 * whole drawn column, night plus naps; it equals `nightMinutes` on a day
 * without one, and the tooltip renders its line only when it differs.
 *
 * Pulled out of the tooltip body because Recharts renders no tooltip under
 * SSR — this is the only place the footer split can be pinned by a test.
 */
export function compositionTotals(row: CompositionRow | undefined): {
  nightMinutes: number;
  napMinutes: number;
  dayMinutes: number;
} {
  let nightMinutes = 0;
  for (const stage of STAGE_ORDER) {
    const minutes = row?.[stage];
    if (typeof minutes === "number") nightMinutes += minutes;
  }
  const nap = row?.[NAP_KEY];
  const napMinutes = typeof nap === "number" ? nap : 0;
  return { nightMinutes, napMinutes, dayMinutes: nightMinutes + napMinutes };
}

export function SleepStageStackedBar({ breakdown }: SleepStageStackedBarProps) {
  const { t, locale } = useTranslations();
  const formatCalendar = useCalendarDate();
  const fmtDay = (date: Date) => formatCalendar(dateOnlyKey(date));

  // v1.4.25 W3f — window toggle (7 / 14 / 30). Default 7d so the user
  // sees their most recent week with maximal per-bar resolution.
  const [windowDays, setWindowDays] = useState<WindowSize>(7);

  // Pull stage names from i18n once so the legend + tooltip share a
  // single source of truth.
  const stageLabels: Record<string, string> = {
    DEEP: t("insights.sleep.stages.deep"),
    REM: t("insights.sleep.stages.rem"),
    CORE: t("insights.sleep.stages.core"),
    ASLEEP: t("insights.sleep.stages.asleep"),
    AWAKE: t("insights.sleep.stages.awake"),
    IN_BED: t("insights.sleep.stages.inBed"),
    [NAP_KEY]: t("insights.sleep.stages.nap"),
  };

  // v1.4.25 W3f — per-night dataset. Slice the trailing N nights and
  // build a Recharts row per night with one numeric key per stage.
  // Empty perNight (legacy clients during the rollout) falls back to
  // the aggregate row so the chart still renders something rather
  // than going blank.
  const data = useMemo(() => {
    const perNight = breakdown.perNight ?? [];
    if (perNight.length === 0) {
      // Legacy fallback: render the 30-day aggregate as a single row
      // so the chart degrades gracefully against a pre-W3f payload.
      const fallbackRow: Record<string, number | string> = {
        dayKey: "aggregate",
        label: t("insights.sleep.compositionTitle"),
      };
      for (const stage of STAGE_ORDER) {
        fallbackRow[stage] = breakdown.stages[stage] ?? 0;
      }
      return [fallbackRow];
    }
    return buildCompositionRows(perNight, windowDays, (dayKey) =>
      formatDayTick(dayKey, windowDays, locale),
    ).rows;
  }, [breakdown, windowDays, locale, t]);

  // Mount the nap band only when the VISIBLE window holds one.
  const hasNap = useMemo(() => windowHasNap(data), [data]);

  // Empty-state guard — no perNight rows AND no aggregate.
  const hasData =
    data.length > 0 &&
    data.some((row) =>
      STAGE_ORDER.some(
        (stage) => typeof row[stage] === "number" && (row[stage] as number) > 0,
      ),
    );

  // v1.42 — each night's column opens the day it ended on (the day the
  // per-night key names, as `/api/sleep/night` does), through the same doors
  // every day-linked chart has.
  const nightDays = data.map((row) =>
    typeof row.dayKey === "string" && row.dayKey !== "aggregate"
      ? row.dayKey
      : null,
  );
  const chartDays = useChartDayLinks({
    enabled: hasData && nightDays.some((day) => day !== null),
    days: nightDays,
    focusFor: (index) => {
      const totals = compositionTotals(data[index]);
      return totals.nightMinutes > 0
        ? {
            label: t("insights.sleep.mainSleep"),
            value: formatDurationMinutes(totals.nightMinutes, t),
            types: ["SLEEP_DURATION"],
          }
        : null;
    },
  });
  const tableColumns = [...STAGE_ORDER, ...(hasNap ? [NAP_KEY] : [])]
    .filter((stage) =>
      data.some(
        (row) => typeof row[stage] === "number" && (row[stage] as number) > 0,
      ),
    )
    .map((stage) => ({ key: stage, label: stageLabels[stage] ?? stage }));

  const ariaLabel = t("insights.sleep.compositionAriaLabel", {
    nights: breakdown.nights,
  });

  return (
    <Card data-slot="sleep-stage-stacked-bar">
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            {/* The canonical tile header — the title used to be a bare
                `CardTitle` in a hand-rolled row. The window toggles stay a
                sibling of the title+subtitle pair rather than riding the
                header's `right` slot: the subtitle belongs under the title,
                and the toggles need to drop to their own row below `sm`
                (the sanctioned inline-action-row shape). */}
            <TileHeader title={t("insights.sleep.compositionTitle")} />
            <span className="text-muted-foreground text-xs">
              {t("insights.sleep.compositionSubtitle", {
                nights: breakdown.nights,
              })}
            </span>
          </div>
          <div
            // v1.4.27 MB7 / CF-70 — bump the gap from `gap-1` to
            // `gap-1.5` so the three window-toggle buttons (7d /
            // 14d / 30d) breathe enough on Pixel 5 that the active
            // pill's border doesn't fuse with the inactive neighbour.
            className="flex items-center gap-1.5 self-end sm:self-auto"
            data-slot="sleep-stage-window-toggle"
          >
            {WINDOW_DAYS.map((w) => (
              <Button
                key={w}
                type="button"
                variant={windowDays === w ? "default" : "ghost"}
                size="sm"
                className="min-h-11 px-2 text-xs sm:px-3"
                onClick={() => setWindowDays(w)}
                aria-pressed={windowDays === w}
                data-slot={`sleep-stage-window-${w}`}
              >
                {/* The page's other range controls read "7T / 30T"; this
                    one printed an English "7d" beside them. */}
                {t("charts.daysNLabel", { days: w })}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p
            className="text-muted-foreground py-8 text-center text-xs"
            data-slot="sleep-stage-empty"
          >
            {t("insights.sleep.stages.unavailable")}
          </p>
        ) : (
          <>
            <div
              role="img"
              aria-label={ariaLabel}
              data-slot="chart-plot"
              {...chartDays.plotProps}
              className={chartDays.plotClassName}
            >
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={data}
                  margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                  onClick={chartDays.onChartClick}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    opacity={0.3}
                  />
                  <XAxis
                    type="category"
                    // The day key, so the open day's line can name its column;
                    // the tick prints the window's label for it.
                    dataKey="dayKey"
                    tickFormatter={(dayKey: string) =>
                      dayKey === "aggregate"
                        ? t("insights.sleep.compositionTitle")
                        : formatDayTick(dayKey, windowDays, locale)
                    }
                    stroke="var(--muted-foreground)"
                    fontSize={10}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    type="number"
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickFormatter={(v: number) => {
                      // Render the y-axis as hours so 480 min reads as 8h.
                      if (v <= 0) return "0";
                      return `${Math.round(v / 60)}h`;
                    }}
                  />
                  {chartDays.openIndex !== undefined ? (
                    <ReferenceLine
                      x={nightDays[chartDays.openIndex] ?? undefined}
                      {...OPEN_DAY_LINE}
                    />
                  ) : null}
                  <Tooltip
                    {...chartDays.tooltipProps}
                    cursor={{ fill: "transparent" }}
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0)
                        return null;
                      const row = payload[0]?.payload as
                        Record<string, number | string> | undefined;
                      const label = row?.label;
                      const rowIndex = row ? data.indexOf(row) : -1;
                      const napCount =
                        typeof row?.napCount === "number" ? row.napCount : 0;
                      // The footer's first line is the NIGHT. The nap is listed
                      // above it as its own line and stays out of that sum, so
                      // the per-stage percentages keep meaning "of this night".
                      // On a day with a nap a second line carries the whole
                      // column — main sleep plus naps — the Main sleep / Naps /
                      // Total split issue #611 asked for.
                      const totals = compositionTotals(row);
                      return (
                        <div className="bg-popover text-popover-foreground rounded-md border p-2 text-xs shadow-md">
                          <div className="border-border mb-1 border-b pb-1 font-medium">
                            {label}
                          </div>
                          {payload.map((entry) => {
                            const stage = String(entry.dataKey ?? "");
                            const minutes =
                              typeof entry.value === "number" ? entry.value : 0;
                            if (minutes === 0) return null;
                            const isNap = stage === NAP_KEY;
                            const label = isNap
                              ? napCount > 1
                                ? t("insights.sleep.stages.napCount", {
                                    count: String(napCount),
                                  })
                                : stageLabels[NAP_KEY]
                              : (stageLabels[stage] ?? stage);
                            const pct =
                              totals.nightMinutes > 0
                                ? Math.round(
                                    (minutes / totals.nightMinutes) * 100,
                                  )
                                : 0;
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
                                  {label}
                                </span>
                                <span className="text-muted-foreground">
                                  {/* The nap is not part of the night, so it
                                    gets no share-of-night percentage. */}
                                  {isNap
                                    ? formatDurationMinutes(minutes, t)
                                    : `${formatDurationMinutes(minutes, t)} · ${pct}%`}
                                </span>
                              </div>
                            );
                          })}
                          {totals.nightMinutes > 0 && (
                            <div className="border-border mt-1 border-t pt-1 font-medium">
                              <div className="flex items-center justify-between gap-3">
                                <span>{t("insights.sleep.mainSleep")}</span>
                                <span>
                                  {formatDurationMinutes(
                                    totals.nightMinutes,
                                    t,
                                  )}
                                </span>
                              </div>
                              {totals.napMinutes > 0 && (
                                <div className="flex items-center justify-between gap-3">
                                  <span>{t("insights.sleep.totalSleep")}</span>
                                  <span>
                                    {formatDurationMinutes(
                                      totals.dayMinutes,
                                      t,
                                    )}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                          {chartDays.tooltipAction(
                            rowIndex === -1 ? undefined : rowIndex,
                          )}
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
                      stackId="stages"
                      fill={STAGE_COLORS[stage]}
                      isAnimationActive={false}
                    >
                      <Cell fill={STAGE_COLORS[stage]} />
                    </Bar>
                  ))}
                  {hasNap && (
                    <Bar
                      key={NAP_KEY}
                      dataKey={NAP_KEY}
                      stackId="stages"
                      fill={STAGE_COLORS[NAP_KEY]}
                      // The outline is what separates the nap from the stage
                      // beneath it; the two fills alone measure as low as
                      // 1.04:1. See NAP_SEPARATOR.
                      stroke={NAP_SEPARATOR.stroke}
                      strokeWidth={NAP_SEPARATOR.strokeWidth}
                      isAnimationActive={false}
                    >
                      <Cell
                        fill={STAGE_COLORS[NAP_KEY]}
                        stroke={NAP_SEPARATOR.stroke}
                        strokeWidth={NAP_SEPARATOR.strokeWidth}
                      />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ChartDayFooter
              links={chartDays}
              points={data.map((row) => ({
                timestamp:
                  typeof row.dayKey === "string" && row.dayKey !== "aggregate"
                    ? dayAnchor(row.dayKey)
                    : 0,
              }))}
              axis="band"
              mark="bar"
              // The plot's margin (8) + the y axis (60) on the left, the
              // margin (16) on the right.
              insetLeft={8 + 60}
              insetRight={16}
            />
            {chartDays.active ? (
              <ChartDataTable
                points={data.map((row) => ({
                  date: String(row.dayKey),
                  timestamp: dayAnchor(String(row.dayKey)),
                  ...Object.fromEntries(
                    tableColumns.map(({ key }) => [
                      key,
                      typeof row[key] === "number" && (row[key] as number) > 0
                        ? (row[key] as number)
                        : undefined,
                    ]),
                  ),
                }))}
                columns={tableColumns}
                formatValue={(minutes) => formatDurationMinutes(minutes, t)}
                formatDate={(date) => fmtDay(date)}
                bucket="day"
                metricLabel={t("insights.sleep.compositionTitle")}
                dayLinks
              />
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
