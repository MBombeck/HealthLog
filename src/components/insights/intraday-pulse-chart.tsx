"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronLeft, ChevronRight } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";

import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { userDayKey, shiftDateKey, DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { TileHeader } from "@/components/insights/tile-header";
import { DayLink } from "@/components/day/day-link";
import { Button } from "@/components/ui/button";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { axisUnitSuffix } from "@/lib/charts/axis-unit";
import {
  BUCKET_MINUTES,
  type IntradayHrBucket,
  type IntradayResolution,
  type TensionWindow,
} from "@/lib/analytics/intraday-pulse";

/** Slim DTO the intraday route returns (type-only — no server code bundled). */
interface IntradayPulseDto {
  dateKey: string;
  bucketMinutes: number;
  series: IntradayHrBucket[];
  baseline: number | null;
  baselineSource: "resting" | "proxy" | "none";
  tension: TensionWindow | null;
  resolution: IntradayResolution;
}

/** Minutes-since-midnight → "HH:mm" wall-clock label. */
function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const AXIS_TICKS = [0, 360, 720, 1080, 1440];

/**
 * S11 — the intraday pulse "shape of the day" layer inside the pulse insight.
 *
 * Charts one local day's 10-minute mean heart rate (computed on demand from
 * raw), with the personal resting baseline drawn as a reference line and any
 * detected elevated-at-rest ("tension") window softly shaded. Copy is cautious
 * and non-diagnostic — "possible tension", never a stress score. Empty / no-
 * baseline days render an honest one-liner rather than an empty grid.
 *
 * The area never interpolates across a gap of missing buckets — `chartData`
 * is a full-day grid with `null` for every absent bucket and the `Area`
 * renders with `connectNulls={false}`, so a handful of spot readings shows
 * as isolated points rather than a fabricated smooth curve. Whenever that
 * produces a visible break, a small "based on N readings across M hours"
 * line discloses the coverage so the shape doesn't read as more continuous
 * than it is.
 *
 * v1.29.x — a day navigator (`TileHeader`'s `right` slot, per UI-STANDARDS
 * §11) pages the same route backward through prior days; "next" is disabled
 * at today, so the view can never step into the future. A day outside the
 * dense retention window (`DENSE_INTRADAY_RETENTION_DAYS`) reads back at the
 * coarser hourly grain instead of an empty chart — `resolution` on the DTO
 * tells the caption which, and the tension read is always absent on an
 * hourly day (it needs per-sample resolution to stay honest). A failed fetch
 * renders `<QueryErrorCard>` with a retry action instead of falling through
 * to the empty-day copy.
 *
 * `initialDateKey` pins the first day shown, for callers that already know
 * which day they are talking about — the workout detail page seeds it with
 * the session's `dayKey` so the chart opens on the day of the workout. The
 * navigator still works from there, so "the day before" stays one tap away.
 * Absent, the view opens on today and keeps tracking it.
 */
export function IntradayPulseChart({
  userTimezone,
  initialDateKey,
}: {
  userTimezone?: string;
  initialDateKey?: string;
}) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const tz = userTimezone ?? DEFAULT_TIMEZONE;
  const todayKey = userDayKey(new Date(), tz);
  // `null` tracks "today" live (so a session left open across midnight keeps
  // following the current day); a non-null value pins the viewed day once
  // the user has navigated away from today — or from the start, when the
  // caller seeded a day of its own.
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(
    initialDateKey ?? null,
  );
  const dateKey = selectedDateKey ?? todayKey;
  const isToday = dateKey === todayKey;

  const goToPreviousDay = () => setSelectedDateKey(shiftDateKey(dateKey, -1));
  const goToNextDay = () => {
    const next = shiftDateKey(dateKey, 1);
    // Defence in depth alongside the button's `disabled` — never step past
    // today regardless of how the handler is reached.
    if (next > todayKey) return;
    setSelectedDateKey(next === todayKey ? null : next);
  };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.insightsPulseIntraday(dateKey),
    queryFn: () =>
      apiGet<IntradayPulseDto>(`/api/insights/pulse/intraday?date=${dateKey}`),
    enabled: isAuthenticated,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const bucketMinutes = data?.bucketMinutes ?? BUCKET_MINUTES;

  // A handful of spot readings scattered across the day must never read as
  // a smooth, continuous curve — that fabricates a shape the data doesn't
  // support. Building one grid point per possible bucket (present buckets
  // carry their mean, absent ones are `null`) lets `connectNulls={false}`
  // below break the area over any missing bucket instead of interpolating
  // across it, so only genuinely adjacent readings connect.
  const chartData = useMemo(() => {
    const series = data?.series;
    if (!series || series.length === 0) return [];
    const byMinute = new Map(series.map((b) => [b.startMinute, b.mean]));
    const points: Array<{ minute: number; label: string; bpm: number | null }> =
      [];
    for (let minute = 0; minute < 1440; minute += bucketMinutes) {
      points.push({
        minute,
        label: minuteLabel(minute),
        bpm: byMinute.get(minute) ?? null,
      });
    }
    return points;
  }, [data?.series, bucketMinutes]);

  // The coverage disclosure only fires when the chart actually contains a
  // break — a fully contiguous day already reads honestly without it. Whole
  // hours (not fractional) keep the copy simple across locales.
  const coverage = useMemo(() => {
    const series = data?.series;
    if (!series || series.length < 2) return null;
    const sorted = [...series].sort((a, b) => a.startMinute - b.startMinute);
    let hasGap = false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startMinute - sorted[i - 1].startMinute > bucketMinutes) {
        hasGap = true;
        break;
      }
    }
    if (!hasGap) return null;
    const readingCount = sorted.reduce((sum, b) => sum + b.count, 0);
    const first = sorted[0].startMinute;
    const last = sorted[sorted.length - 1].startMinute + bucketMinutes;
    const hours = Math.max(1, Math.round((last - first) / 60));
    return { readingCount, hours };
  }, [data?.series, bucketMinutes]);

  const caption = data?.tension
    ? t(`insights.intradayPulse.tension.${data.tension.partOfDay}`)
    : data?.resolution === "hourly"
      ? t("insights.intradayPulse.hourlyNote")
      : t("insights.intradayPulse.caption");

  const coverageNote = coverage
    ? coverage.readingCount === 1
      ? t("insights.intradayPulse.coverageOne", { hours: coverage.hours })
      : t("insights.intradayPulse.coverageMany", {
          count: coverage.readingCount,
          hours: coverage.hours,
        })
    : null;

  const dayLabel = isToday
    ? t("insights.intradayPulse.today")
    : fmt.dateShortSmartCalendar(dateKey);

  return (
    <div
      data-slot="intraday-pulse-chart"
      // `.metric-accent` — the tension layer's identity edge on the CARD
      // shell only (`--tile-stress`, the wellness vocabulary's autonomic
      // hue, per the plan's §3.6 hue-family call); the chart inside stays
      // untouched. The same hue marks the `tension_window` rail card, so
      // the two S11 surfaces read as one family.
      className="bg-card metric-accent space-y-1.5 rounded-xl border p-4 md:p-6"
      style={{ "--tile-hue": "var(--tile-stress)" } as React.CSSProperties}
    >
      <TileHeader
        icon={Activity}
        title={t("insights.intradayPulse.title")}
        right={
          <div
            data-slot="intraday-pulse-day-nav"
            className="flex items-center gap-0.5"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 sm:size-8"
              onClick={goToPreviousDay}
              aria-label={t("insights.intradayPulse.previousDay")}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </Button>
            {/* v1.42 — the date opens the whole day this chart is one part
                of, the one thing every date in the app does. */}
            <span className="min-w-14 text-center text-xs">
              <DayLink date={dateKey} size="xs">
                {dayLabel}
              </DayLink>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 sm:size-8"
              onClick={goToNextDay}
              disabled={isToday}
              aria-label={t("insights.intradayPulse.nextDay")}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        }
      />
      <p className="text-muted-foreground text-xs leading-snug">{caption}</p>
      {coverageNote ? (
        <p
          data-slot="intraday-pulse-coverage"
          className="text-muted-foreground text-xs leading-snug"
        >
          {coverageNote}
        </p>
      ) : null}

      {isLoading ? (
        <Skeleton className="h-[180px] w-full rounded-lg" />
      ) : isError ? (
        <QueryErrorCard
          onRetry={() => refetch()}
          className="border-0 bg-transparent shadow-none"
        />
      ) : chartData.length === 0 ? (
        <div className="text-muted-foreground flex h-44 items-center justify-center rounded-lg border border-dashed text-sm">
          {t("insights.intradayPulse.empty")}
        </div>
      ) : (
        <div className="touch-pan-y">
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient
                  id="intradayPulseFill"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0.3}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                opacity={0.5}
              />
              <XAxis
                dataKey="minute"
                type="number"
                domain={[0, 1440]}
                ticks={AXIS_TICKS}
                tickFormatter={minuteLabel}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={["dataMin - 10", "dataMax + 10"]}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                unit={axisUnitSuffix("bpm")}
                width={52}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: "0.5rem",
                  fontSize: "0.875rem",
                }}
                labelFormatter={(minute) => minuteLabel(Number(minute))}
                formatter={(value) => [`${value} bpm`, t("charts.pulse")]}
              />
              {data?.tension ? (
                <ReferenceArea
                  x1={data.tension.startMinute}
                  x2={data.tension.endMinute}
                  fill="var(--warning)"
                  fillOpacity={0.14}
                  ifOverflow="extendDomain"
                />
              ) : null}
              {data?.baseline != null ? (
                <ReferenceLine
                  y={data.baseline}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="5 5"
                  strokeOpacity={0.7}
                  label={{
                    value: t("insights.intradayPulse.baseline"),
                    position: "insideTopLeft",
                    fill: "var(--muted-foreground)",
                    fontSize: 10,
                  }}
                />
              ) : null}
              {/* `connectNulls={false}` (the default, spelled out here for
                  intent) is the honesty fix: `chartData` carries one point
                  per possible bucket, `null` where no reading exists, so a
                  gap of missing buckets breaks the line/fill instead of
                  interpolating a shape across hours of silence. `dot`
                  keeps an isolated reading visible as a point even where
                  it has no neighbour to connect to. */}
              <Area
                type="monotone"
                dataKey="bpm"
                stroke="var(--chart-1)"
                strokeWidth={2}
                fill="url(#intradayPulseFill)"
                dot={{ r: 2, fill: "var(--chart-1)", strokeWidth: 0 }}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
