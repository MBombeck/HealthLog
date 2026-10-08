"use client";

/**
 * v1.15.0 — the basal-body-temperature (BBT) chart.
 *
 * Plots the user's logged BBT across the CURRENT cycle — the same window the
 * wheel shows, because both take the cycle start from the server's resolved
 * verdict rather than each walking the calendar themselves — as a line with
 * phase-tinted dots,
 * the symptothermal signal a fertility-aware reader expects. Fertility signs
 * already logged for a day — egg-white/watery mucus, a positive LH test —
 * surface in the tooltip so the temperature shift reads in context. When the
 * goal surfaces a fertile window, the estimated ovulation day is marked with a
 * reference line.
 *
 * Honest data contract: BBT is a LOGGED fact (no estimate), so the curve needs
 * no disclaimer of its own; the estimated-ovulation marker is the prediction
 * panel's, which already carries the fixed non-medical disclaimer beside it.
 * In raw-chart ("Read Your Body") mode the phase tint + ovulation marker are
 * suppressed — only the neutral temperatures are drawn, no interpretation.
 *
 * Recharts (the project's charting lib), Dracula/Alucard tokens, reduced-motion
 * gated via `isAnimationActive`. Needs ≥2 logged readings to draw; below that
 * it surfaces a "log your morning temperature" hint rather than a flat dot.
 */

import { useMemo, type ReactNode } from "react";
import { Thermometer } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { cn } from "@/lib/utils";
import type { CalendarDay, CervicalMucus, OvulationTest } from "./types";
import { PHASE_HUE, OVULATION_HUE } from "./phase-tokens";
import { shiftDateKey } from "@/lib/tz/format";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { ChartDataTable } from "@/components/charts/chart-data-table";
import {
  ChartDayFooter,
  OPEN_DAY_LINE,
  useChartDayLinks,
} from "@/components/day/chart-day-links";

/** Trailing fallback window (days) when no MENSTRUAL-anchored cycle is active. */
const FALLBACK_WINDOW_DAYS = 35;

const LINE_COLOR = "var(--cycle-phase-luteal)";

interface BbtPoint {
  t: number;
  temp: number;
  phaseHue: string;
  mucus: CervicalMucus | null;
  ovulationTest: OvulationTest | null;
}

export interface BbtChartProps {
  days: CalendarDay[];
  today: string;
  /**
   * First day of the current cycle, from the calendar read's resolved
   * `verdict.cycleStartDate`. Null when no cycle is active, and the chart
   * falls back to a trailing window so recent temperatures still show.
   */
  cycleStartDate: string | null;
  /** Estimated ovulation day (`YYYY-MM-DD`), or null when goal-gated off. */
  predictedOvulation: string | null;
  /** Whether the ovulation day was confirmed by a signal layer (solid marker). */
  ovulationConfirmed?: boolean;
  /** Read-Your-Body mode: suppress phase tint + ovulation marker. */
  rawChartMode: boolean;
}

function ymdToMs(d: string): number {
  // Noon UTC so a YYYY-MM-DD never rolls a day across the viewer's tz.
  return Date.parse(`${d}T12:00:00Z`);
}

/**
 * The plotted readings of the window, oldest first, each temperature in the
 * reader's unit (`toDisplay` converts the stored degrees Celsius).
 */
export function bbtPoints(args: {
  days: CalendarDay[];
  fromDate: string;
  today: string;
  rawChartMode: boolean;
  toDisplay: (celsius: number) => number;
}): BbtPoint[] {
  const { days, fromDate, today, rawChartMode, toDisplay } = args;
  const fromMs = ymdToMs(fromDate);
  const todayMs = ymdToMs(today);
  return days
    .filter((d) => {
      if (d.basalBodyTempC == null || !Number.isFinite(d.basalBodyTempC)) {
        return false;
      }
      const ms = ymdToMs(d.date);
      return ms >= fromMs && ms <= todayMs;
    })
    .map((d) => ({
      t: ymdToMs(d.date),
      temp: toDisplay(d.basalBodyTempC as number),
      phaseHue:
        rawChartMode || d.phase == null ? LINE_COLOR : PHASE_HUE[d.phase],
      mucus: d.cervicalMucus,
      ovulationTest: d.ovulationTest,
    }))
    .sort((a, b) => a.t - b.t);
}

export function BbtChart({
  days,
  today,
  cycleStartDate,
  predictedOvulation,
  ovulationConfirmed = false,
  rawChartMode,
}: BbtChartProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // Stored in °C, read in the reader's unit: every point, the padding and
  // the empty-state domain go through the same transform.
  const unitDisplay = useUnitDisplay();
  const animationsEnabled = !prefersReducedMotion();

  // Scope to the current cycle using the server's resolved start; fall back to
  // a trailing window when no cycle is active so a user still sees their
  // recent temperatures.
  const fromDate = useMemo(() => {
    if (cycleStartDate) return cycleStartDate;
    return shiftDateKey(today, -FALLBACK_WINDOW_DAYS);
  }, [cycleStartDate, today]);

  const points = useMemo(
    () =>
      bbtPoints({
        days,
        fromDate,
        today,
        rawChartMode,
        toDisplay: (celsius) =>
          unitDisplay.toDisplay("BODY_TEMPERATURE", celsius),
      }),
    [days, fromDate, today, rawChartMode, unitDisplay],
  );

  const ovulationMs = useMemo(() => {
    if (rawChartMode || !predictedOvulation) return null;
    const ms = ymdToMs(predictedOvulation);
    if (points.length < 2) return null;
    const first = points[0].t;
    const last = points[points.length - 1].t;
    return ms >= first && ms <= last ? ms : null;
  }, [predictedOvulation, points, rawChartMode]);

  const yDomain = useMemo<[number, number]>(() => {
    if (points.length === 0) {
      return [
        unitDisplay.toDisplay("BODY_TEMPERATURE", 36),
        unitDisplay.toDisplay("BODY_TEMPERATURE", 37.5),
      ];
    }
    const temps = points.map((p) => p.temp);
    const min = Math.min(...temps);
    const max = Math.max(...temps);
    // Pad by 0.15 °C (in the reader's unit) so the shift is legible and the
    // line never hugs an edge.
    const pad = unitDisplay.toDisplayDelta("BODY_TEMPERATURE", 0.15);
    return [
      Math.floor((min - pad) * 10) / 10,
      Math.ceil((max + pad) * 10) / 10,
    ];
  }, [points, unitDisplay]);

  const ticks = useMemo(() => {
    if (points.length < 2) return [];
    const first = points[0].t;
    const last = points[points.length - 1].t;
    const span = last - first;
    if (span <= 0) return [first];
    return [0, 0.33, 0.66, 1].map((f) => Math.round(first + span * f));
  }, [points]);

  const hasCurve = points.length >= 2;

  // v1.42 — each logged temperature opens its day through the doors every
  // day-linked chart has. Tapping a cycle-calendar cell still logs the day;
  // the chart is where a day is read.
  const chartDays = useChartDayLinks({
    enabled: hasCurve,
    days: points.map((p) => dateOnlyKey(new Date(p.t))),
    focusFor: (index) => {
      const p = points[index];
      return p
        ? {
            label: t("cycle.bbt.title"),
            value: fmt.number(p.temp),
            unit: unitDisplay.unitFor("BODY_TEMPERATURE"),
            types: ["BODY_TEMPERATURE"],
          }
        : null;
    },
  });
  const openPoint =
    chartDays.openIndex !== undefined ? points[chartDays.openIndex] : undefined;

  return (
    <Card data-slot="cycle-bbt-chart">
      <CardHeader>
        <TileHeader icon={Thermometer} title={t("cycle.bbt.title")} />
      </CardHeader>
      <CardContent>
        {!hasCurve ? (
          <div
            className="text-muted-foreground bg-muted/40 flex flex-col items-start gap-2 rounded-md p-4 text-sm"
            data-slot="cycle-bbt-empty"
          >
            <p className="font-medium">{t("cycle.bbt.empty")}</p>
            <p className="text-xs">{t("cycle.bbt.emptyHint")}</p>
          </div>
        ) : (
          <>
            <p
              className="text-muted-foreground mb-2 text-xs"
              data-slot="cycle-bbt-caption"
            >
              {t("cycle.bbt.caption")}
            </p>
            <div
              className={cn("touch-pan-y", chartDays.plotClassName)}
              style={{ height: "210px" }}
              data-slot="cycle-bbt-area"
              {...chartDays.plotProps}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={points}
                  margin={{ top: 10, right: 14, bottom: 16, left: 4 }}
                  onClick={chartDays.onChartClick}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    opacity={0.5}
                  />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    ticks={ticks}
                    tickFormatter={(v) =>
                      fmt.dateShortSmart(new Date(v as number))
                    }
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    domain={yDomain}
                    width={40}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${fmt.number(v as number)}°`}
                  />
                  {openPoint ? (
                    <ReferenceLine x={openPoint.t} {...OPEN_DAY_LINE} />
                  ) : null}
                  <Tooltip
                    {...chartDays.tooltipProps}
                    cursor={{
                      stroke: "var(--muted-foreground)",
                      strokeOpacity: 0.3,
                      strokeDasharray: "3 3",
                    }}
                    content={(props) => {
                      const payload = props.payload as unknown as
                        { payload: BbtPoint }[] | undefined;
                      const point = payload?.[0]?.payload;
                      return (
                        <BbtTooltip
                          active={props.active}
                          payload={payload}
                          action={chartDays.tooltipAction(
                            point ? points.indexOf(point) : undefined,
                          )}
                        />
                      );
                    }}
                  />
                  {ovulationMs != null ? (
                    <ReferenceLine
                      x={ovulationMs}
                      stroke={OVULATION_HUE}
                      // Solid line for a confirmed ovulation (signal-detected),
                      // dashed for the calendar estimate (QA M1).
                      strokeDasharray={ovulationConfirmed ? undefined : "4 3"}
                      strokeWidth={1.5}
                      label={{
                        value: ovulationConfirmed
                          ? t("cycle.bbt.ovulationConfirmed")
                          : t("cycle.bbt.ovulationEstimate"),
                        position: "insideTopRight",
                        fontSize: 10,
                        // Muted text (not the amber hue) so the tiny label keeps
                        // AA contrast on the card; the line carries the colour (L1).
                        fill: "var(--muted-foreground)",
                      }}
                    />
                  ) : null}
                  <Line
                    type="monotone"
                    dataKey="temp"
                    stroke={LINE_COLOR}
                    strokeWidth={2}
                    dot={<PhaseDot />}
                    activeDot={{ r: 5 }}
                    isAnimationActive={animationsEnabled}
                    animationDuration={animationsEnabled ? 600 : 0}
                    animationEasing="ease-out"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <ChartDayFooter
              links={chartDays}
              points={points.map((p) => ({ timestamp: p.t }))}
              axis="time"
              // The margin (4) + the y axis (40) on the left, the margin (14)
              // on the right.
              insetLeft={4 + 40}
              insetRight={14}
            />
            <ChartDataTable
              points={points.map((p) => ({
                date: dateOnlyKey(new Date(p.t)),
                timestamp: p.t,
                temp: p.temp,
              }))}
              columns={[{ key: "temp", label: t("cycle.bbt.title") }]}
              unit={unitDisplay.unitFor("BODY_TEMPERATURE")}
              formatValue={(value) => fmt.number(value)}
              formatDate={(date) => fmt.dateShortSmartCalendar(date)}
              bucket="day"
              metricLabel={t("cycle.bbt.title")}
              dayLinks
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A line dot tinted to its day's cycle phase (neutral in raw-chart mode). */
function PhaseDot(props: { cx?: number; cy?: number; payload?: BbtPoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={3.5}
      fill={payload.phaseHue}
      stroke="var(--background)"
      strokeWidth={1}
    />
  );
}

/** Tooltip restating the temperature + any fertility signs logged that day. */
export function BbtTooltip(props: {
  active?: boolean;
  payload?: { payload: BbtPoint }[];
  /** v1.42 — the tooltip's way to the day on a touch screen. */
  action?: ReactNode;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const unitDisplay = useUnitDisplay();
  if (!props.active || !props.payload || props.payload.length === 0)
    return null;
  const p = props.payload[0].payload;
  return (
    <div
      className={cn(
        "bg-popover border-border rounded-md border px-2.5 py-2 text-xs shadow-md",
      )}
    >
      <p className="text-muted-foreground">
        {fmt.dateShortSmart(new Date(p.t))}
      </p>
      <p className="text-foreground font-medium tabular-nums">
        {t("cycle.bbt.tooltipTemp", {
          temp: fmt.number(p.temp),
          unit: unitDisplay.unitFor("BODY_TEMPERATURE"),
        })}
      </p>
      {p.mucus ? (
        <p className="text-muted-foreground mt-0.5">
          {t("cycle.mucus.label")}: {t(`cycle.mucus.${p.mucus}`)}
        </p>
      ) : null}
      {p.ovulationTest && p.ovulationTest !== "NEGATIVE" ? (
        <p className="text-muted-foreground mt-0.5">
          {t("cycle.ovulationTest.label")}:{" "}
          {t(`cycle.ovulationTest.${p.ovulationTest}`)}
        </p>
      ) : null}
      {props.action ?? null}
    </div>
  );
}
