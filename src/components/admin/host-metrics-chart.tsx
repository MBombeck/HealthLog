"use client";

/**
 * `<HostMetricsChart>` — last-2h host-load chart that sits above the
 * `/admin/system-status` facts grid (v1.4.16 phase B3).
 *
 * Three lines on a shared time axis:
 *   - load1 (yellow)            os.loadavg() 1-minute average
 *   - memUsedPercent (cyan)     0..100, derived from totalmem - freemem
 *   - diskBusyPercent (purple)  read-bps + write-bps as a fraction of
 *                               the window's peak; only drawn when at
 *                               least two diskBps samples are present
 *                               (Linux only — macOS dev hosts hide the
 *                               line entirely)
 *
 * The chart wrapper imports every Recharts primitive statically and
 * lives inside `next/dynamic` at the consumer (the system-status
 * section). Splitting at the wrapper boundary keeps Recharts' internal
 * `findAllByType` happy. See
 * `src/components/charts/scatter-correlation-chart.tsx` for the same
 * pattern + rationale.
 *
 * Polling: TanStack Query with `refetchInterval: 60_000` so the chart
 * surfaces a freshly-sampled minute as soon as the worker writes one.
 */

import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMemo } from "react";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface HostMetricsApiSample {
  capturedAt: string;
  loadAvg1: number;
  memUsedPercent: number;
  diskReadBps: number | null;
  diskWriteBps: number | null;
}

interface HostMetricsApiResponse {
  samples: HostMetricsApiSample[];
  meta: {
    since: string;
    count: number;
    memTotalBytes: number;
  };
}

interface ChartRow {
  /** ms since epoch — the X-axis. */
  timestamp: number;
  /** Display label "HH:mm" in the user's locale. */
  label: string;
  loadAvg1: number;
  memUsedPercent: number;
  /**
   * Combined read+write BPS as a fraction (0..100) of the window's peak.
   * Null when the API row had no diskReadBps/diskWriteBps (first sample,
   * non-Linux host, or counter reset).
   */
  diskBusyPercent: number | null;
}

const COLOR_LOAD = "var(--dracula-yellow)";
const COLOR_MEM = "var(--dracula-cyan)";
const COLOR_DISK = "var(--dracula-purple)";

/**
 * Pure helper exposed for unit tests: turns API samples into chart rows
 * + the absolute peak BPS used to scale `diskBusyPercent`. Kept as a
 * separate export so the test suite doesn't need to render Recharts.
 */
export function buildChartRows(samples: HostMetricsApiSample[]): {
  rows: ChartRow[];
  peakDiskBps: number;
  hasDiskData: boolean;
} {
  let peakDiskBps = 0;
  for (const sample of samples) {
    const total = (sample.diskReadBps ?? 0) + (sample.diskWriteBps ?? 0);
    if (total > peakDiskBps) peakDiskBps = total;
  }

  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  let hasDiskData = false;
  const rows = samples.map((sample) => {
    const ts = new Date(sample.capturedAt).getTime();
    const total =
      sample.diskReadBps !== null && sample.diskWriteBps !== null
        ? sample.diskReadBps + sample.diskWriteBps
        : null;

    let diskBusyPercent: number | null = null;
    if (total !== null) {
      hasDiskData = true;
      diskBusyPercent =
        peakDiskBps > 0
          ? Math.max(0, Math.min(100, (total / peakDiskBps) * 100))
          : 0;
    }

    return {
      timestamp: ts,
      label: formatter.format(new Date(ts)),
      loadAvg1: sample.loadAvg1,
      memUsedPercent: sample.memUsedPercent,
      diskBusyPercent,
    };
  });

  return { rows, peakDiskBps, hasDiskData };
}

export function HostMetricsChart() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.adminHostMetrics("2h"),
    queryFn: async () => {
      const res = await fetch("/api/admin/host-metrics?since=2h");
      if (!res.ok) throw new Error("Failed to load host metrics");
      return (await res.json()).data as HostMetricsApiResponse;
    },
    // 60s matches the sampler cadence — anything faster would just
    // re-render the same data.
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const { rows, peakDiskBps, hasDiskData } = useMemo(
    () => buildChartRows(data?.samples ?? []),
    [data?.samples],
  );

  // Loading skeleton: same footprint as the chart so the panel doesn't
  // jump when data lands. Animated only when motion isn't reduced.
  if (isLoading) {
    return (
      <section
        aria-labelledby="admin-host-metrics-heading"
        className="bg-card border-border rounded-xl border p-4 md:p-6"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="admin-host-metrics-heading" className="text-sm font-semibold">
            {t("admin.hostMetrics.title")}
          </h2>
          <span className="text-muted-foreground text-xs">
            {t("admin.hostMetrics.last2hours")}
          </span>
        </div>
        <div className="bg-muted/40 h-[180px] w-full animate-pulse rounded-md motion-reduce:animate-none" />
      </section>
    );
  }

  if (isError) {
    return (
      <section
        aria-labelledby="admin-host-metrics-heading"
        className="bg-card border-border rounded-xl border p-4 md:p-6"
      >
        <h2 id="admin-host-metrics-heading" className="text-sm font-semibold">
          {t("admin.hostMetrics.title")}
        </h2>
        <p
          role="alert"
          className="text-destructive bg-destructive/10 border-destructive/30 mt-3 rounded-md border px-3 py-2 text-xs"
        >
          {t("admin.hostMetrics.loadError")}
        </p>
      </section>
    );
  }

  // Empty: the sampler runs every 60s, so a freshly-deployed instance
  // takes 1–2 minutes to surface its first row. Show a friendly hint
  // instead of an empty plot.
  if (rows.length === 0) {
    return (
      <section
        aria-labelledby="admin-host-metrics-heading"
        className="bg-card border-border rounded-xl border p-4 md:p-6"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="admin-host-metrics-heading" className="text-sm font-semibold">
            {t("admin.hostMetrics.title")}
          </h2>
          <span className="text-muted-foreground text-xs">
            {t("admin.hostMetrics.last2hours")}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("admin.hostMetrics.empty")}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="admin-host-metrics-heading"
      className="bg-card border-border rounded-xl border p-4 md:p-6"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 id="admin-host-metrics-heading" className="text-sm font-semibold">
          {t("admin.hostMetrics.title")}
        </h2>
        <span className="text-muted-foreground text-xs">
          {t("admin.hostMetrics.last2hours")}
        </span>
      </div>

      <div className="h-[200px] w-full touch-pan-y">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 10, right: 12, bottom: 8, left: 8 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border)"
              opacity={0.5}
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={32}
            />
            {/* Left axis: load (raw number) — Linux scheduler convention,
                 typical idle host = 0..1, multi-core saturation > #cpu. */}
            <YAxis
              yAxisId="load"
              orientation="left"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              width={36}
              domain={[0, "auto"]}
            />
            {/* Right axis: percentage — shared by memory + diskBusy. */}
            <YAxis
              yAxisId="percent"
              orientation="right"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              width={40}
              domain={[0, 100]}
              tickFormatter={(value: number) => `${Math.round(value)}%`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                fontSize: "0.75rem",
              }}
              labelStyle={{ color: "var(--dracula-fg)" }}
              itemStyle={{ color: "var(--dracula-fg)" }}
              formatter={(value, name) => {
                if (typeof value !== "number") return [String(value), name];
                if (name === t("admin.hostMetrics.load1")) {
                  return [fmt.number(value, 2), name];
                }
                if (name === t("admin.hostMetrics.memUsedPercent")) {
                  return [`${fmt.number(value, 1)} %`, name];
                }
                if (name === t("admin.hostMetrics.diskBusyPercent")) {
                  // Show the actual MiB/s alongside the relative share —
                  // the percent alone is meaningless without the peak.
                  const peakMiB = peakDiskBps / 1_048_576;
                  const absMiB = (value / 100) * peakMiB;
                  return [
                    `${fmt.number(value, 1)} % · ${fmt.number(absMiB, 2)} MiB/s`,
                    name,
                  ];
                }
                return [String(value), name];
              }}
            />
            <Legend
              wrapperStyle={{
                fontSize: "0.75rem",
                fontFamily: "inherit",
                fontWeight: "normal",
              }}
            />
            <Line
              yAxisId="load"
              type="monotone"
              dataKey="loadAvg1"
              name={t("admin.hostMetrics.load1")}
              stroke={COLOR_LOAD}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <Line
              yAxisId="percent"
              type="monotone"
              dataKey="memUsedPercent"
              name={t("admin.hostMetrics.memUsedPercent")}
              stroke={COLOR_MEM}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            {hasDiskData && (
              <Line
                yAxisId="percent"
                type="monotone"
                dataKey="diskBusyPercent"
                name={t("admin.hostMetrics.diskBusyPercent")}
                stroke={COLOR_DISK}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
