"use client";

/**
 * v1.8.6 W4c — GLP-1 dose-strength (titration) curve.
 *
 * Replaces the EMA *reference*-ladder block that showed no values when
 * the medication's brand fell outside the catalog. This surface plots
 * the user's OWN dose-strength history — the `MedicationDoseChange`
 * stream (`effectiveFrom` + `doseValue` + `doseUnit`) returned by
 * `GET /api/medications/[id]/glp1` — as a step curve over time, so a
 * 2.5 → 5 → 7.5 → 10 mg escalation reads at a glance.
 *
 * Honest data contract:
 *   - 2+ dose-change rows → step curve, the latest dose carried forward
 *     to "now" so the current strength stays visible at the right edge.
 *   - exactly 1 row → no escalation to draw; surface the single current
 *     dose plainly with a "no titration history yet" caption rather than
 *     a flat single-point chart.
 *   - 0 rows → empty state with the same caption. The
 *     `MedicationDoseChange` table is the history of record; when it is
 *     empty there is genuinely no time series to plot.
 *
 * Ungated by design: this curve plots only logged facts (the user's own
 * recorded dose strengths), so it carries no pharmacokinetic estimate and
 * needs no disclaimer. The estimated-PK `DrugLevelChart` beside it is not
 * gated either — the Research-Mode switch that once governed it was
 * retired as inert — but it carries the persistent estimate disclaimer
 * that names its numbers as modelled, not measured.
 *
 * Dracula purple tokens + the shared `<MedicationDetailSection>` chrome
 * so the GLP-1 disclosure reads as one visual group with the drug-level
 * chart that sits beside it.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, TrendingUp } from "lucide-react";
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

import {
  useDisplayTimezone,
  useTranslations,
  useFormatters,
} from "@/lib/i18n/context";
import { ChartDataTable } from "@/components/charts/chart-data-table";
import {
  RichChartTooltip,
  type RichTooltipRow,
} from "@/components/charts/chart-tooltip";
import {
  ChartDayFooter,
  OPEN_DAY_LINE,
  dayAnchor,
  useChartDayLinks,
} from "@/components/day/chart-day-links";
import { dateKeyOfInstant } from "@/components/day/day-url";
import { dateOnlyKey, isNoonUtcAnchor } from "@/lib/tz/date-only";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";

// --chart-1 is the light/dark-aware alias for this hue (dracula-purple in
// dark mode); raw --dracula-purple has no light-theme override and mis-
// renders on the light card.
const CURVE_COLOR = "var(--chart-1)";

interface DoseChange {
  id: string;
  effectiveFrom: string;
  doseValue: number;
  doseUnit: string;
  note?: string | null;
}

interface Glp1DetailsResponse {
  doseChanges: DoseChange[];
}

export interface DoseStrengthCurveProps {
  medicationId: string;
  /** Override "now" for deterministic snapshot tests. */
  asOf?: Date;
}

interface CurvePoint {
  t: number;
  dose: number;
  unit: string;
}

/**
 * Build the step-curve points from the dose-change stream. The series is
 * sorted by `effectiveFrom`, finite-guarded, and the latest dose is
 * carried forward to `asOf` so the current strength anchors the right
 * edge. Exported for the unit test.
 */
export function buildCurvePoints(
  doseChanges: readonly DoseChange[],
  asOf: Date,
): CurvePoint[] {
  const sorted = doseChanges
    .map((dc) => ({
      t: Date.parse(dc.effectiveFrom),
      dose: dc.doseValue,
      unit: dc.doseUnit,
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.dose))
    .sort((a, b) => a.t - b.t);

  if (sorted.length < 2) return sorted;

  // Carry the latest dose forward to "now" so the most-recent strength
  // reads as a flat segment up to the right edge rather than ending at
  // the last change date.
  const last = sorted[sorted.length - 1];
  const nowMs = asOf.getTime();
  if (nowMs > last.t) {
    sorted.push({ t: nowMs, dose: last.dose, unit: last.unit });
  }
  return sorted;
}

export function DoseStrengthCurve({
  medicationId,
  asOf,
}: DoseStrengthCurveProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data: details, isLoading } = useQuery<Glp1DetailsResponse | null>({
    queryKey: queryKeys.medicationGlp1Details(medicationId),
    queryFn: async () => {
      try {
        return await apiGet<Glp1DetailsResponse>(
          `/api/medications/${medicationId}/glp1`,
        );
      } catch {
        return null;
      }
    },
    staleTime: 60 * 1000,
  });

  const now = useMemo(() => asOf ?? new Date(), [asOf]);
  const doseChanges = useMemo(() => details?.doseChanges ?? [], [details]);
  const points = useMemo(
    () => buildCurvePoints(doseChanges, now),
    [doseChanges, now],
  );
  const animationsEnabled = !prefersReducedMotion();

  // The latest logged dose — surfaced in the single-row / empty states so
  // the user always sees their current strength even without a curve.
  const latest = useMemo(() => {
    if (doseChanges.length === 0) return null;
    const sorted = [...doseChanges].sort(
      (a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom),
    );
    return sorted[sorted.length - 1];
  }, [doseChanges]);

  const hasCurve = points.length >= 2;

  const chartData = useMemo(
    () =>
      points.map((p) => ({
        t: p.t,
        dose: p.dose,
      })),
    [points],
  );

  // Four evenly-spaced date ticks across the plotted span so the strip
  // reads start → … → now without crowding.
  const ticks = useMemo(() => {
    if (chartData.length < 2) return [];
    const first = chartData[0].t;
    const last = chartData[chartData.length - 1].t;
    const span = last - first;
    if (span <= 0) return [first];
    return [0, 0.33, 0.66, 1].map((f) => Math.round(first + span * f));
  }, [chartData]);

  const unit = latest?.doseUnit ?? "mg";

  // v1.42 — each dose change opens the day it took effect, through the doors
  // every day-linked chart has. The point carried forward to today is not a
  // change and opens nothing.
  const timeZone = useDisplayTimezone();
  const changeCount = Math.min(
    doseChanges.filter(
      (dc) =>
        Number.isFinite(Date.parse(dc.effectiveFrom)) &&
        Number.isFinite(dc.doseValue),
    ).length,
    chartData.length,
  );
  const pointDays = chartData.map((p, index) => {
    if (index >= changeCount) return null;
    const instant = new Date(p.t);
    return isNoonUtcAnchor(instant)
      ? dateOnlyKey(instant)
      : dateKeyOfInstant(instant, timeZone);
  });
  const chartDays = useChartDayLinks({
    enabled: hasCurve,
    days: pointDays,
    focusFor: (index) => {
      const point = chartData[index];
      return point
        ? {
            label: t("medications.doseStrength.tooltipLabel"),
            value: fmt.number(point.dose),
            unit,
          }
        : null;
    },
  });
  const openPoint =
    chartDays.openIndex !== undefined
      ? chartData[chartDays.openIndex]
      : undefined;

  const body = isLoading ? (
    <div
      className="flex h-[200px] min-h-[200px] items-center justify-center"
      data-slot="dose-strength-curve-loading"
    >
      <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
    </div>
  ) : !hasCurve ? (
    <div
      className="text-muted-foreground bg-muted/40 flex flex-col items-start gap-2 rounded-md p-4 text-sm"
      data-slot="dose-strength-curve-empty"
    >
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 shrink-0" aria-hidden="true" />
        {latest ? (
          <p>
            {t("medications.doseStrength.currentDose", {
              dose: fmt.number(latest.doseValue),
              unit: latest.doseUnit,
            })}
          </p>
        ) : (
          <p>{t("medications.doseStrength.noCurrentDose")}</p>
        )}
      </div>
      <p className="text-xs italic">{t("medications.doseStrength.empty")}</p>
    </div>
  ) : (
    <>
      <div
        className={`touch-pan-y ${chartDays.plotClassName}`}
        style={{ height: "200px" }}
        data-slot="dose-strength-curve-area"
        {...chartDays.plotProps}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
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
              tickFormatter={(v) => fmt.dateShortSmart(new Date(v as number))}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              domain={[0, "auto"]}
              width={34}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => fmt.number(v as number)}
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
                  | ReadonlyArray<{ payload?: { t: number; dose: number } }>
                  | undefined;
                const point = payload?.[0]?.payload;
                if (!props.active || !point) {
                  return <RichChartTooltip active={false} rows={[]} />;
                }
                const rows: RichTooltipRow[] = [
                  {
                    name: t("medications.doseStrength.tooltipLabel"),
                    value: `${fmt.number(point.dose)} ${unit}`,
                    color: CURVE_COLOR,
                  },
                ];
                return (
                  <RichChartTooltip
                    active
                    label={fmt.dateShortSmart(new Date(point.t))}
                    rows={rows}
                  />
                );
              }}
            />
            <Line
              type="stepAfter"
              dataKey="dose"
              stroke={CURVE_COLOR}
              strokeWidth={2}
              dot={{ r: 3, fill: CURVE_COLOR, strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              isAnimationActive={animationsEnabled}
              animationDuration={animationsEnabled ? 600 : 0}
              animationEasing="ease-out"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ChartDayFooter
        links={chartDays}
        points={chartData.map((p) => ({ timestamp: p.t }))}
        axis="time"
        // The margin (4) + the y axis (34) on the left, the margin (14) on
        // the right.
        insetLeft={4 + 34}
        insetRight={14}
      />
      {chartDays.active ? (
        <ChartDataTable
          points={chartData.slice(0, changeCount).map((p, index) => ({
            date: pointDays[index]!,
            timestamp: dayAnchor(pointDays[index]!),
            dose: p.dose,
          }))}
          columns={[
            {
              key: "dose",
              label: t("medications.doseStrength.tooltipLabel"),
            },
          ]}
          unit={unit}
          formatValue={(value) => fmt.number(value)}
          formatDate={(date) => fmt.dateShortSmartCalendar(date)}
          bucket="day"
          metricLabel={t("medications.doseStrength.title")}
          dayLinks
        />
      ) : null}
    </>
  );

  return (
    <MedicationDetailSection
      titleId="dose-strength-curve-title"
      title={t("medications.doseStrength.title")}
      dataSlot="dose-strength-curve"
    >
      {hasCurve && (
        <p
          className="text-muted-foreground mb-2 text-xs"
          data-slot="dose-strength-curve-caption"
        >
          {t("medications.doseStrength.axisLabel", { unit })}
        </p>
      )}
      {body}
    </MedicationDetailSection>
  );
}
