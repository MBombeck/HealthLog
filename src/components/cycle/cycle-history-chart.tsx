"use client";

import { useMemo } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { cn } from "@/lib/utils";
import type { CycleHistoryResponse, MenstrualCycleDTO } from "./types";
import {
  FLOW_HUE,
  OVULATION_HUE,
  PHASE_HUE,
  HISTORY_REST_OPACITY,
  HISTORY_PERIOD_OPACITY,
} from "./phase-tokens";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * v1.15.1 — the cycle-length history chart.
 *
 * A HAND-ROLLED SVG (0-KB runtime, no chart lib — matching `cycle-ring.tsx`'s
 * identity rather than reaching for Recharts) that draws one vertical bar per
 * observed cycle, segmented period-vs-rest: the lower span is the menstrual
 * (period) portion in the rose `FLOW_HUE`, the upper span is the rest of the
 * cycle in the calm luteal hue, and a thin ovulation tick marks the confirmed
 * ovulation day when present. A mean baseline rule runs across the field so
 * variability reads at a glance. Stat chips above carry the average length,
 * the variability spread, and the regularity classification.
 *
 * Why hand-rolled SVG over Recharts: the geometry is trivial (N rects + a
 * baseline line), the visual must match the wheel's bespoke SVG signature, and
 * a thin bar chart through Recharts' ResponsiveContainer would pull a chart
 * lib, an animation engine, and a tooltip surface we don't want here — the
 * 0-KB approach is genuinely better for identity and weight.
 *
 * a11y: `role="img"` + a summary aria-label restating avg + regularity; each
 * bar carries a `<title>` with its own length so the SVG is never colour-only.
 * Markers are `data-*`-attr driven (`data-cycle-bar`, `data-ovulation-tick`,
 * `data-regularity`) so Playwright asserts stable attrs, not viewport text.
 *
 * Motion: the shared bar-rise reveal plays ONLY when the host passes
 * `animate` AND `prefers-reduced-motion` is not set (it sets `data-animate`
 * on the SVG, which the CSS keys the per-bar grow on). Otherwise bars paint
 * at full height immediately.
 */

const VIEW_W = 320;
const VIEW_H = 120;
const PAD_TOP = 8;
const PAD_BOTTOM = 4;
const MAX_BARS = 12;
const REST_HUE = "var(--cycle-phase-luteal)";

export interface CycleHistoryChartProps {
  history: CycleHistoryResponse | undefined;
  /** Play the staggered bar-rise once (gated on reduced-motion internally). */
  animate?: boolean;
  className?: string;
}

interface Bar {
  id: string;
  lengthDays: number;
  periodDays: number | null;
  ovulationDay: number | null;
}

/** Inclusive day span between two `YYYY-MM-DD` dates (noon-UTC anchored). */
function daySpan(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

function toBar(c: MenstrualCycleDTO): Bar | null {
  if (c.lengthDays == null || c.lengthDays <= 0) return null;
  const periodDays =
    c.periodEndDate != null ? daySpan(c.startDate, c.periodEndDate) : null;
  const ovulationDay =
    c.ovulationConfirmed && c.ovulationDate != null
      ? daySpan(c.startDate, c.ovulationDate)
      : null;
  return {
    id: c.id,
    lengthDays: c.lengthDays,
    periodDays: periodDays != null ? Math.min(periodDays, c.lengthDays) : null,
    ovulationDay,
  };
}

export function CycleHistoryChart({
  history,
  animate = false,
  className,
}: CycleHistoryChartProps) {
  const { t } = useTranslations();
  const reduced = prefersReducedMotion();
  const shouldAnimate = animate && !reduced;

  const stats = history?.stats;

  // Oldest-to-newest, capped — read left-to-right like a timeline.
  const bars = useMemo<Bar[]>(() => {
    const observed = (history?.cycles ?? []).filter((c) => !c.isPredicted);
    return observed
      .map(toBar)
      .filter((b): b is Bar => b != null)
      .slice(0, MAX_BARS)
      .reverse();
  }, [history?.cycles]);

  const hasData = bars.length > 0 && stats?.avgLengthDays != null;

  const maxLen = useMemo(
    () => Math.max(...bars.map((b) => b.lengthDays), stats?.avgLengthDays ?? 1),
    [bars, stats?.avgLengthDays],
  );

  const regularity = stats?.regularity ?? "LEARNING";

  return (
    <Card data-slot="cycle-history-chart" className={className}>
      <CardHeader>
        <CardTitle className="text-base">
          {t("cycle.history.chartTitle")}
        </CardTitle>
        {hasData ? (
          <CardDescription>{t("cycle.history.chartCaption")}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasData ? (
          <EmptyState variant="plain" title={t("cycle.history.none")} />
        ) : (
          <>
            {/* Stat chips — avg / variability / regularity classification. */}
            <ul
              className="flex flex-wrap gap-2"
              data-slot="cycle-history-stats"
            >
              <StatChip
                hue={REST_HUE}
                label={t("cycle.history.avgLength")}
                value={t("cycle.history.days", {
                  count: stats!.avgLengthDays!,
                })}
              />
              {stats!.lengthVariabilityDays != null ? (
                <StatChip
                  hue="var(--muted-foreground)"
                  label={t("cycle.history.variability")}
                  value={t("cycle.history.daysPlusMinus", {
                    count: stats!.lengthVariabilityDays,
                  })}
                />
              ) : null}
              <StatChip
                hue={
                  regularity === "REGULAR"
                    ? PHASE_HUE.FOLLICULAR
                    : regularity === "IRREGULAR"
                      ? OVULATION_HUE
                      : "var(--muted-foreground)"
                }
                data-regularity={regularity}
                label={t("cycle.history.regularity")}
                value={t(`cycle.history.regularity${regularity}`)}
              />
            </ul>

            <BarField
              bars={bars}
              maxLen={maxLen}
              avg={stats!.avgLengthDays!}
              shouldAnimate={shouldAnimate}
              ariaLabel={t("cycle.history.chartAria", {
                count: bars.length,
                avg: Math.round(stats!.avgLengthDays!),
                regularity: t(`cycle.history.regularity${regularity}`),
              })}
              periodLabel={t("cycle.history.legendPeriodSegment")}
              ovulationLabel={t("cycle.calendar.legendOvulationConfirmed")}
              barTitle={(b) => t("cycle.history.days", { count: b.lengthDays })}
            />

            {/* Inline legend mirroring the bar segments. */}
            <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: FLOW_HUE }}
                />
                {t("cycle.history.legendPeriodSegment")}
              </li>
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-sm opacity-60"
                  style={{ backgroundColor: REST_HUE }}
                />
                {t("cycle.history.legendRestSegment")}
              </li>
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-0.5 rounded-full"
                  style={{ backgroundColor: OVULATION_HUE }}
                />
                {t("cycle.calendar.legendOvulationConfirmed")}
              </li>
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BarField({
  bars,
  maxLen,
  avg,
  shouldAnimate,
  ariaLabel,
  periodLabel,
  ovulationLabel,
  barTitle,
}: {
  bars: Bar[];
  maxLen: number;
  avg: number;
  shouldAnimate: boolean;
  ariaLabel: string;
  periodLabel: string;
  ovulationLabel: string;
  barTitle: (b: Bar) => string;
}) {
  const usableH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const baseY = VIEW_H - PAD_BOTTOM;
  // Column layout: even slots with a calm gap, bars centred in each slot.
  const slot = VIEW_W / bars.length;
  const barW = Math.min(slot * 0.62, 22);
  const scale = (days: number) => (days / maxLen) * usableH;
  const avgY = baseY - scale(avg);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="h-32 w-full"
      role="img"
      aria-label={ariaLabel}
      data-animate={shouldAnimate ? "true" : undefined}
      preserveAspectRatio="none"
    >
      {/* Mean baseline rule — variability reads against it. */}
      <line
        x1={0}
        x2={VIEW_W}
        y1={avgY}
        y2={avgY}
        stroke="var(--muted-foreground)"
        strokeOpacity={0.4}
        strokeWidth={1}
        strokeDasharray="3 3"
        data-avg-line="true"
      />
      {bars.map((b, i) => {
        const cx = i * slot + slot / 2;
        const x = cx - barW / 2;
        const totalH = scale(b.lengthDays);
        const topY = baseY - totalH;
        const periodH = b.periodDays != null ? scale(b.periodDays) : 0;
        const periodTopY = baseY - periodH;
        const restH = totalH - periodH;
        const ovuY =
          b.ovulationDay != null ? baseY - scale(b.ovulationDay) : null;
        return (
          <g
            key={b.id}
            className="cycle-history-bar"
            data-cycle-bar="true"
            style={{ "--bar-delay": `${i * 55}ms` } as React.CSSProperties}
          >
            <title>{`${barTitle(b)}`}</title>
            {/* Rest-of-cycle segment (upper). */}
            {restH > 0 ? (
              <rect
                x={x}
                y={topY}
                width={barW}
                height={Math.max(restH, 0)}
                rx={2}
                fill={REST_HUE}
                fillOpacity={HISTORY_REST_OPACITY}
              />
            ) : null}
            {/* Period segment (lower) — rose, the bleeding portion. */}
            {periodH > 0 ? (
              <rect
                x={x}
                y={periodTopY}
                width={barW}
                height={periodH}
                rx={2}
                fill={FLOW_HUE}
                fillOpacity={HISTORY_PERIOD_OPACITY}
                data-period-segment="true"
              >
                <title>{periodLabel}</title>
              </rect>
            ) : null}
            {/* Confirmed-ovulation tick — a short cross-bar at the ovu day. */}
            {ovuY != null ? (
              <rect
                x={x - 1.5}
                y={ovuY - 1}
                width={barW + 3}
                height={2}
                rx={1}
                fill={OVULATION_HUE}
                data-ovulation-tick="true"
              >
                <title>{ovulationLabel}</title>
              </rect>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function StatChip({
  hue,
  label,
  value,
  ...rest
}: {
  hue: string;
  label: string;
  value: string;
} & React.HTMLAttributes<HTMLLIElement>) {
  return (
    <li
      className={cn("bg-muted/40 flex items-center gap-2 rounded-md px-3 py-2")}
      {...rest}
    >
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: hue }}
      />
      <span className="flex flex-col">
        <span className="text-muted-foreground text-xs leading-tight">
          {label}
        </span>
        <span className="text-foreground text-sm font-semibold tabular-nums">
          {value}
        </span>
      </span>
    </li>
  );
}
